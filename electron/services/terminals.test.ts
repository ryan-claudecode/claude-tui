import { describe, it, expect, vi } from "vitest"
import { TerminalService, encodeProjectDir, resumeArgs } from "./terminals"

describe("TerminalService emit channels (terminal:* not session:*)", () => {
  it("emits terminal:created on create()", () => {
    const svc = new TerminalService()
    const sent: string[] = []
    // Override sendToRenderer before any operation so all emits are captured
    ;(svc as unknown as { sendToRenderer: (c: string, ...a: unknown[]) => void }).sendToRenderer =
      (channel) => { sent.push(channel) }

    svc.create("t", process.cwd())

    expect(sent).toContain("terminal:created")
    expect(sent.some((c) => c.startsWith("session:"))).toBe(false)
  })

  it("emits terminal:state (idle) via the idle monitor when mainWindow is set", () => {
    vi.useFakeTimers()
    const svc = new TerminalService()
    const sent: string[] = []
    ;(svc as unknown as { sendToRenderer: (c: string, ...a: unknown[]) => void }).sendToRenderer =
      (channel) => { sent.push(channel) }

    svc.create("t", process.cwd())
    // Start the idle monitor directly (normally started by setMainWindow)
    ;(svc as unknown as { startIdleMonitor: () => void }).startIdleMonitor()
    // Advance past idle threshold (1500ms) + one timer tick (1000ms)
    vi.advanceTimersByTime(3000)

    expect(sent).toContain("terminal:state")
    expect(sent.some((c) => c.startsWith("session:"))).toBe(false)

    vi.useRealTimers()
  })

  it("emits terminal:renamed when rename() is called", () => {
    const svc = new TerminalService()
    const sent: string[] = []
    ;(svc as unknown as { sendToRenderer: (c: string, ...a: unknown[]) => void }).sendToRenderer =
      (channel) => { sent.push(channel) }

    const info = svc.create("t", process.cwd())
    // clear earlier channels; we only care about rename here
    sent.length = 0
    svc.rename(info.id, "new-name")
    expect(sent).toContain("terminal:renamed")
    expect(sent.some((c) => c.startsWith("session:"))).toBe(false)
  })
})

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

  it("clears the convo poller immediately on kill (no convo event after kill)", () => {
    vi.useFakeTimers()
    const svc = new TerminalService()
    const info = svc.create("t", process.cwd())
    const events: string[] = []
    svc.onEvent((e) => events.push(e.type))
    svc.kill(info.id)
    // advance well past the 1s poll interval; a leaked timer would fire here
    vi.advanceTimersByTime(5000)
    expect(events).not.toContain("convo")
    vi.useRealTimers()
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

import { resolveTranscriptId, listTranscriptIds } from "./terminals"
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

  it("excludes transcripts that already existed at spawn (sibling in same cwd)", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-projects-"))
    const cwd = "C:\\fake\\shared"
    const dir = join(root, encodeProjectDir(cwd))
    mkdirSync(dir, { recursive: true })

    // A sibling terminal's transcript, already on disk and freshly written.
    const siblingId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    writeFileSync(join(dir, `${siblingId}.jsonl`), "{}")

    const spawnedAt = Date.now()
    // Snapshot taken at our spawn — sibling is present.
    const preexisting = listTranscriptIds(root, cwd)
    expect(preexisting.has(siblingId)).toBe(true)

    // Sibling keeps streaming AFTER we spawned (newest mtime), but it's excluded.
    const future = (spawnedAt + 2_000) / 1000
    utimesSync(join(dir, `${siblingId}.jsonl`), future, future)

    // Without exclusion the sibling would win; with it, nothing new yet.
    expect(resolveTranscriptId(root, cwd, spawnedAt, preexisting)).toBeUndefined()

    // Now OUR transcript appears — it's not in the snapshot, so we bind to it.
    const ourId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    writeFileSync(join(dir, `${ourId}.jsonl`), "{}")
    const ourTime = (spawnedAt + 3_000) / 1000
    utimesSync(join(dir, `${ourId}.jsonl`), ourTime, ourTime)
    expect(resolveTranscriptId(root, cwd, spawnedAt, preexisting)).toBe(ourId)
  })
})

describe("resumeArgs", () => {
  it("adds --resume when the transcript still exists", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-resume-"))
    const cwd = "C:\\fake\\r"
    const dir = join(root, encodeProjectDir(cwd))
    mkdirSync(dir, { recursive: true })
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    writeFileSync(join(dir, `${id}.jsonl`), "{}")
    expect(resumeArgs(root, cwd, id)).toEqual(["--resume", id])
  })

  it("returns [] when the id is missing", () => {
    expect(resumeArgs(mkdtempSync(join(tmpdir(), "cc-r2-")), "C:\\x", undefined)).toEqual([])
  })

  it("returns [] when the transcript file is gone", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-r3-"))
    expect(resumeArgs(root, "C:\\x", "dead-id")).toEqual([])
  })
})

import { parseActivityLine } from "./terminals"

describe("parseActivityLine", () => {
  it("extracts the last tool-call line", () => {
    const out = [
      "some chatter",
      "● Read(electron/services/sessions.ts)",
      "more text",
      "● Edit(electron/services/terminals.ts)",
      "tail",
    ].join("\n")
    expect(parseActivityLine(out)).toBe("Edit(electron/services/terminals.ts)")
  })

  it("returns undefined when there is no tool-call line", () => {
    expect(parseActivityLine("just\nplain\ntext")).toBeUndefined()
  })

  it("matches tool calls but not prose bullets", () => {
    expect(parseActivityLine("● Edit(src/App.tsx)")).toBe("Edit(src/App.tsx)")
    expect(parseActivityLine("● Bash(npm test)")).toBe("Bash(npm test)")
    // prose bullets / markdown lists must NOT match
    expect(parseActivityLine("* this is a note (with parens)")).toBeUndefined()
    expect(parseActivityLine("● note about something (no tool)")).toBeUndefined()
  })
})
