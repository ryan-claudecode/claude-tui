import { describe, it, expect } from "vitest"
import { TerminalService, encodeProjectDir } from "./terminals"

describe("TerminalService.onEvent", () => {
  it("notifies listeners on created and exit, and unsubscribes cleanly", () => {
    const svc = new TerminalService()
    const events: any[] = []
    const off = svc.onEvent((e) => events.push(e))

    const info = svc.create("t", process.cwd())
    expect(events.some((e) => e.type === "created" && e.info.id === info.id)).toBe(true)

    off()
    const before = events.length
    svc.kill(info.id)
    expect(events.length).toBe(before)
  })
})

describe("encodeProjectDir", () => {
  it("encodes a Windows cwd the way Claude Code does", () => {
    expect(encodeProjectDir("C:\\Users\\ryguy\\projects\\claude-tui-app")).toBe(
      "C--Users-ryguy-projects-claude-tui-app",
    )
  })

  it("encodes a POSIX cwd", () => {
    expect(encodeProjectDir("/home/ryguy/projects/app")).toBe("-home-ryguy-projects-app")
  })
})

import { resolveTranscriptId } from "./terminals"
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("resolveTranscriptId", () => {
  it("returns the newest .jsonl id created at/after spawnedAt", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-projects-"))
    const cwd = "C:\\fake\\repo"
    const dir = join(root, encodeProjectDir(cwd))
    mkdirSync(dir, { recursive: true })

    const oldId = "11111111-1111-1111-1111-111111111111"
    const newId = "22222222-2222-2222-2222-222222222222"
    writeFileSync(join(dir, `${oldId}.jsonl`), "{}")
    writeFileSync(join(dir, `${newId}.jsonl`), "{}")

    const spawnedAt = Date.now()
    const past = (spawnedAt - 60_000) / 1000
    const future = (spawnedAt + 1_000) / 1000
    utimesSync(join(dir, `${oldId}.jsonl`), past, past)
    utimesSync(join(dir, `${newId}.jsonl`), future, future)

    expect(resolveTranscriptId(root, cwd, spawnedAt)).toBe(newId)
  })

  it("returns undefined when no transcript is new enough", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-projects-"))
    const cwd = "C:\\fake\\repo2"
    const dir = join(root, encodeProjectDir(cwd))
    mkdirSync(dir, { recursive: true })
    const id = "33333333-3333-3333-3333-333333333333"
    writeFileSync(join(dir, `${id}.jsonl`), "{}")
    const past = (Date.now() - 60_000) / 1000
    utimesSync(join(dir, `${id}.jsonl`), past, past)
    expect(resolveTranscriptId(root, cwd, Date.now())).toBeUndefined()
  })
})
