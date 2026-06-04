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

  it("load() cold-sets terminals to dead/stopped (lazy spawn — no live PTYs at boot)", () => {
    const a = new SessionService({ dir, now: () => 1000 })
    const s = a.create()
    a.addTerminal(s.id, { id: "live-1", name: "x", cwd: "/r", lastState: "active" })
    a.addTerminal(s.id, { id: "live-2", name: "y", cwd: "/r", lastState: "idle" })
    // status was "active" while PTYs were notionally live
    expect(a.get(s.id)!.status).toBe("active")

    const b = new SessionService({ dir, now: () => 2000 })
    b.load()
    const loaded = b.get(s.id)!
    expect(loaded.terminals.map((t) => t.lastState)).toEqual(["dead", "dead"])
    expect(loaded.status).toBe("stopped")
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

describe("SessionService.deriveStatus", () => {
  const mk = (svc: SessionService) => svc.create()

  it("Empty when no terminals", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = mk(svc)
    expect(svc.deriveStatus(s.id)).toBe("Empty")
  })

  it("Stopped when session.status is stopped", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = mk(svc)
    svc.addTerminal(s.id, { id: "t1", name: "x", cwd: "/r", lastState: "idle" })
    svc.setStatus(s.id, "stopped")
    expect(svc.deriveStatus(s.id)).toBe("Stopped")
  })

  it("Idle when live terminals exist but none active", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = mk(svc)
    svc.addTerminal(s.id, { id: "t1", name: "x", cwd: "/r", lastState: "idle" })
    expect(svc.deriveStatus(s.id)).toBe("Idle")
  })

  it("counts active terminals (singular vs plural)", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = mk(svc)
    svc.addTerminal(s.id, { id: "t1", name: "x", cwd: "/r", lastState: "active" })
    expect(svc.deriveStatus(s.id)).toBe("1 Terminal Working")
    svc.addTerminal(s.id, { id: "t2", name: "y", cwd: "/r", lastState: "active" })
    expect(svc.deriveStatus(s.id)).toBe("2 Terminals Working")
  })
})

describe("SessionService notes", () => {
  it("addNote appends an active self-sourced note", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    const n = svc.addNote(s.id, "root cause is the N+1 query")
    expect(n!.text).toBe("root cause is the N+1 query")
    expect(n!.status).toBe("active")
    expect(n!.source).toBe("self")
    expect(svc.get(s.id)!.notes).toHaveLength(1)
  })

  it("addNote with corrects supersedes the referenced note and links it", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    const first = svc.addNote(s.id, "bug is in auth")!
    const second = svc.addNote(s.id, "actually it's the list endpoint", { corrects: first.id })!
    const notes = svc.get(s.id)!.notes
    const stored = notes.find((x) => x.id === first.id)!
    expect(stored.status).toBe("superseded")
    expect(stored.supersededBy).toBe(second.id)
    expect(notes.find((x) => x.id === second.id)!.status).toBe("active")
  })
})

describe("SessionService.getContext", () => {
  it("orders summary first, then active notes, then a ruled-out section with corrections", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    svc.setSummary(s.id, "Goal: fix the auth race. Currently patching middleware.")
    const wrong = svc.addNote(s.id, "bug is in auth")!
    svc.addNote(s.id, "actually it's the list endpoint", { corrects: wrong.id })
    svc.addNote(s.id, "tests live in mission.test.ts")
    const ctx = svc.getContext(s.id)!
    // summary leads
    expect(ctx.indexOf("Goal: fix the auth race")).toBeGreaterThanOrEqual(0)
    // active notes present
    expect(ctx).toContain("actually it's the list endpoint")
    expect(ctx).toContain("tests live in mission.test.ts")
    // ruled-out section present and shows the superseded note with its correction
    expect(ctx).toContain("Ruled out")
    expect(ctx).toContain("bug is in auth")
    // ordering: summary before active before ruled-out
    expect(ctx.indexOf("Goal:")).toBeLessThan(ctx.indexOf("actually it's the list endpoint"))
    expect(ctx.indexOf("actually it's the list endpoint")).toBeLessThan(ctx.indexOf("Ruled out"))
  })

  it("omits the ruled-out section when nothing is superseded", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    svc.addNote(s.id, "only a live note")
    expect(svc.getContext(s.id)!).not.toContain("Ruled out")
  })
})

describe("SessionService terminal activity & state", () => {
  it("setTerminalActivity sets the rich-presence line + timestamp and persists", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    svc.addTerminal(s.id, { id: "t1", name: "x", cwd: "/r", lastState: "idle" })
    svc.setTerminalActivity(s.id, "t1", "running the test suite")
    const t = svc.get(s.id)!.terminals[0]
    expect(t.activity).toBe("running the test suite")
    expect(t.activityAt).toBe(1000)
    // persisted
    const stored = JSON.parse(readFileSync(join(dir, `${s.id}.json`), "utf-8"))
    expect(stored.terminals[0].activity).toBe("running the test suite")
  })

  it("setTerminalActivity is a no-op for unknown session/terminal", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    expect(() => svc.setTerminalActivity(s.id, "nope", "x")).not.toThrow()
    expect(() => svc.setTerminalActivity("nope", "t1", "x")).not.toThrow()
  })

  it("setTerminalState updates lastState (drives deriveStatus) and persists", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    svc.addTerminal(s.id, { id: "t1", name: "x", cwd: "/r", lastState: "idle" })
    expect(svc.deriveStatus(s.id)).toBe("Idle")
    svc.setTerminalState(s.id, "t1", "active")
    expect(svc.get(s.id)!.terminals[0].lastState).toBe("active")
    expect(svc.deriveStatus(s.id)).toBe("1 Terminal Working")
  })
})

describe("SessionService.status", () => {
  it("returns the session by id when given one", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    expect(svc.status(s.id)!.id).toBe(s.id)
  })

  it("returns the most-recently-updated active session when id omitted", () => {
    let t = 1000
    const svc = new SessionService({ dir, now: () => t })
    const a = svc.create()
    t = 2000
    const b = svc.create()
    // touch a so it becomes most-recent again
    t = 3000
    svc.setSummary(a.id, "newer")
    expect(svc.status()!.id).toBe(a.id)
    // stopping a should make b the most-recent active
    t = 4000
    svc.setStatus(a.id, "stopped")
    expect(svc.status()!.id).toBe(b.id)
  })

  it("returns undefined when there are no active sessions", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    svc.setStatus(s.id, "stopped")
    expect(svc.status()).toBeUndefined()
  })
})

// Minimal fake of the slice of TerminalService the container uses.
class FakeTerminals {
  private n = 0
  killed: string[] = []
  spawned: Array<{ id: string; name?: string; cwd?: string; sessionId?: string }> = []
  private cb: ((e: any) => void) | null = null
  create(name?: string, cwd?: string, sessionId?: string) {
    const id = `live-${++this.n}`
    this.spawned.push({ id, name, cwd, sessionId })
    return { id, name: name ?? id, cwd: cwd ?? "/", state: "active" as const }
  }
  kill(id: string) { this.killed.push(id); return true }
  onEvent(cb: (e: any) => void) { this.cb = cb; return () => { this.cb = null } }
  emit(e: any) { this.cb?.(e) }
}

describe("SessionService reconciliation", () => {
  it("folds terminal state/exit events into refs and recomputes session status", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    svc.addTerminal(s.id, { id: "live-1", name: "x", cwd: "/r", lastState: "active" })

    term.emit({ type: "state", id: "live-1", state: "idle" })
    expect(svc.get(s.id)!.terminals[0].lastState).toBe("idle")
    expect(svc.get(s.id)!.status).toBe("active") // idle still counts as live

    term.emit({ type: "exit", id: "live-1" })
    expect(svc.get(s.id)!.terminals[0].lastState).toBe("dead")
    expect(svc.get(s.id)!.status).toBe("stopped") // no live PTYs left
  })

  it("ignores events for terminals it does not own", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    expect(() => term.emit({ type: "state", id: "ghost", state: "idle" })).not.toThrow()
  })
})

describe("SessionService orchestration", () => {
  it("openSession creates a container, spawns + registers its first terminal", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo")
    expect(terminalId).toBe("live-1")
    expect(svc.get(session.id)!.terminals.map((t) => t.id)).toEqual(["live-1"])
    expect(svc.get(session.id)!.terminals[0].cwd).toBe("/repo")
  })

  it("addTerminalToSession spawns + registers another terminal", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000 })
    svc.attachTerminals(term as any)
    const { session } = svc.openSession("/repo")
    const r = svc.addTerminalToSession(session.id, "/repo")
    expect(r!.terminalId).toBe("live-2")
    expect(svc.get(session.id)!.terminals).toHaveLength(2)
  })

  it("closeTerminal kills the PTY + drops the ref but keeps the session alive (empty-but-live)", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo")
    svc.closeTerminal(session.id, terminalId)
    expect(term.killed).toContain("live-1")
    expect(svc.get(session.id)).toBeDefined()
    expect(svc.get(session.id)!.terminals).toEqual([])
    expect(svc.get(session.id)!.status).toBe("stopped")
  })

  it("killSession kills all PTYs and deletes the record + file", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000 })
    svc.attachTerminals(term as any)
    const { session } = svc.openSession("/repo")
    svc.addTerminalToSession(session.id, "/repo")
    svc.killSession(session.id)
    expect(term.killed).toEqual(["live-1", "live-2"])
    expect(svc.get(session.id)).toBeUndefined()
    expect(existsSync(join(dir, `${session.id}.json`))).toBe(false)
  })

  it("reopenTerminal spawns a fresh PTY and updates the ref id in place (3a fresh-reopen)", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo")
    // simulate app-close: terminal exits, ref goes dead but stays
    term.emit({ type: "exit", id: terminalId })
    const oldRef = svc.get(session.id)!.terminals[0]
    expect(oldRef.lastState).toBe("dead")
    const r = svc.reopenTerminal(session.id, oldRef.id)
    expect(r!.terminalId).toBe("live-2")
    const ref = svc.get(session.id)!.terminals[0]
    expect(ref.id).toBe("live-2")
    expect(ref.lastState).toBe("active")
    expect(ref.name).toBe(oldRef.name) // name carried over
  })
})

describe("SessionService identity-bound spawn", () => {
  it("spawns terminals with their work-session id (for identity-bound MCP) and pastes nothing", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000 })
    svc.attachTerminals(term as any)
    const { session } = svc.openSession("/repo")
    svc.addTerminalToSession(session.id, "/repo")
    // every spawn carries the session id so the PTY's MCP config is identity-bound
    expect(term.spawned.every((sp) => sp.sessionId === session.id)).toBe(true)
    // no write()/seed-paste API is used at all
    expect("write" in term).toBe(false)
  })

  it("reopenTerminal also spawns with the session id", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo")
    term.emit({ type: "exit", id: terminalId })
    svc.reopenTerminal(session.id, svc.get(session.id)!.terminals[0].id)
    expect(term.spawned[term.spawned.length - 1].sessionId).toBe(session.id)
  })
})
