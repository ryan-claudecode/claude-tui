import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { SessionService } from "./sessions"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ctui-sess-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("SessionService persistence", () => {
  it("create() makes an active, empty, named-placeholder session and persists it atomically", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    expect(s.status).toBe("active")
    expect(s.terminals).toEqual([])
    expect(s.notes).toEqual([])
    expect(s.provisionalFindings).toEqual([])
    expect(s.summary).toBe("")
    expect(s.createdAt).toBe(1000)
    // persisted to <dir>/<id>.json
    const file = join(dir, `${s.id}.json`)
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, "utf-8")).id).toBe(s.id)
    // no leftover tmp file
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it("load() rehydrates persisted sessions from disk", () => {
    const a = new SessionService({ dir, now: () => 1000 })
    const s = a.create()
    const b = new SessionService({ dir, now: () => 2000 })
    b.load()
    expect(b.get(s.id)?.id).toBe(s.id)
    expect(b.list().length).toBe(1)
  })
})

describe("SessionService terminals", () => {
  it("addTerminal stores a TerminalRef and persists", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    svc.addTerminal(s.id, { id: "t1", name: "Untitled", cwd: "/r", lastState: "active" })
    expect(svc.get(s.id)!.terminals).toEqual([
      { id: "t1", name: "Untitled", cwd: "/r", lastState: "active" },
    ])
  })

  it("removeTerminal drops it but keeps the session alive (empty-but-live)", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    svc.addTerminal(s.id, { id: "t1", name: "x", cwd: "/r", lastState: "active" })
    svc.removeTerminal(s.id, "t1")
    expect(svc.get(s.id)).toBeDefined()
    expect(svc.get(s.id)!.terminals).toEqual([])
  })

  it("first terminal's first name sets the session name when still placeholder", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    svc.addTerminal(s.id, { id: "t1", name: "Untitled", cwd: "/r", lastState: "active" })
    svc.nameTerminal(s.id, "t1", "Fix auth race")
    expect(svc.get(s.id)!.terminals[0].name).toBe("Fix auth race")
    expect(svc.get(s.id)!.name).toBe("Fix auth race") // session inherits from first terminal
  })

  it("naming a later terminal does NOT overwrite an already-named session", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    svc.addTerminal(s.id, { id: "t1", name: "Untitled", cwd: "/r", lastState: "active" })
    svc.nameTerminal(s.id, "t1", "First")
    svc.addTerminal(s.id, { id: "t2", name: "Untitled", cwd: "/r", lastState: "active" })
    svc.nameTerminal(s.id, "t2", "Second")
    expect(svc.get(s.id)!.name).toBe("First")
  })
})
