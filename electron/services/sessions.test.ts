import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
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
    expect(s.createdAt).toBe(1000)
    // persisted to <dir>/<id>.json in the versioned envelope
    const file = join(dir, `${s.id}.json`)
    expect(existsSync(file)).toBe(true)
    const onDisk = JSON.parse(readFileSync(file, "utf-8"))
    expect(onDisk.schemaVersion).toBe(1)
    expect(onDisk.data.id).toBe(s.id)
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

  it("load() reads a LEGACY (pre-versioning, envelope-less) session file and rewrites it as v1", () => {
    // Simulate a user's existing on-disk file written before schema versioning:
    // raw WorkSession JSON, no { schemaVersion, data } envelope.
    const legacy = {
      id: "legacy-sess",
      name: "Old session",
      status: "active",
      terminals: [{ id: "t1", name: "x", cwd: "/r", lastState: "idle" }],
      createdAt: 1000,
      updatedAt: 1000,
    }
    const file = join(dir, "legacy-sess.json")
    writeFileSync(file, JSON.stringify(legacy, null, 2))

    const svc = new SessionService({ dir, now: () => 2000 })
    svc.load()
    // backward compat: the legacy file still loads
    const loaded = svc.get("legacy-sess")!
    expect(loaded.name).toBe("Old session")
    // read-repair: file is rewritten in the v1 envelope on load
    const onDisk = JSON.parse(readFileSync(file, "utf-8"))
    expect(onDisk.schemaVersion).toBe(1)
    expect(onDisk.data.id).toBe("legacy-sess")
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

describe("SessionService workspace scoping (WS-C)", () => {
  it("stamps the active workspace id on a session created while a workspace is active", () => {
    const svc = new SessionService({ dir, now: () => 1000, getActiveWorkspaceId: () => "ws-42" })
    const s = svc.create()
    expect(s.workspaceId).toBe("ws-42")
    // persisted inside the versioned envelope
    const stored = JSON.parse(readFileSync(join(dir, `${s.id}.json`), "utf-8")).data
    expect(stored.workspaceId).toBe("ws-42")
  })

  it("leaves workspaceId UNSET when no workspace is active ('All' mode)", () => {
    const svc = new SessionService({ dir, now: () => 1000, getActiveWorkspaceId: () => null })
    const s = svc.create()
    expect(s.workspaceId).toBeUndefined()
    // the field is omitted from the persisted JSON (additive/byte-clean)
    const stored = JSON.parse(readFileSync(join(dir, `${s.id}.json`), "utf-8")).data
    expect("workspaceId" in stored).toBe(false)
  })

  it("defaults to UNSET when no getActiveWorkspaceId is injected (existing call sites unaffected)", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    expect(s.workspaceId).toBeUndefined()
  })

  it("the stamped workspaceId survives a fresh service load (persists across reload)", () => {
    const a = new SessionService({ dir, now: () => 1000, getActiveWorkspaceId: () => "ws-7" })
    const s = a.create()
    const b = new SessionService({ dir, now: () => 2000 })
    b.load()
    expect(b.get(s.id)!.workspaceId).toBe("ws-7")
  })

  it("loads an OLD persisted session that predates workspaceId cleanly (→ undefined / 'All' bucket)", () => {
    // A legacy on-disk session with no workspaceId field at all.
    const legacy = {
      id: "legacy-no-ws",
      name: "Old session",
      status: "active",
      terminals: [],
      createdAt: 1000,
      updatedAt: 1000,
    }
    writeFileSync(join(dir, "legacy-no-ws.json"), JSON.stringify(legacy, null, 2))
    const svc = new SessionService({ dir, now: () => 2000 })
    svc.load()
    const loaded = svc.get("legacy-no-ws")!
    expect(loaded.workspaceId).toBeUndefined()
  })
})

describe("SessionService workspace spawn-cwd (WS-G / G1)", () => {
  it("a NEW session with an active workspace dir spawns its terminal in that dir (xterm)", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000, getActiveWorkspaceDir: () => "/ws/primary" })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("") // renderer passes "" = default
    // The spawn was given the workspace dir as its cwd.
    expect(term.spawned[0].cwd).toBe("/ws/primary")
    expect(svc.get(session.id)!.terminals.find((t) => t.id === terminalId)!.cwd).toBe("/ws/primary")
  })

  it("a NEW session with an active workspace dir spawns in that dir (structured engine)", () => {
    // The cwd seam is engine-agnostic: SessionService.spawnInto always calls
    // terminals.create(name, cwd, sessionId), and create() routes to the HEADLESS
    // path internally when the engine is structured. The fake routes create() →
    // createHeadless when structuredEngine is set, exactly like the real service, so
    // this exercises the real headless dispatch and asserts the headless spawn (not
    // the xterm branch) received the workspace cwd.
    const term = new FakeTerminals()
    term.structuredEngine = true
    const svc = new SessionService({ dir, now: () => 1000, getActiveWorkspaceDir: () => "/ws/headless" })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("")
    // The spawn that recorded the cwd is a HEADLESS one, and it got the workspace dir.
    expect(term.spawned[0].headless).toBe(true)
    expect(term.spawned[0].cwd).toBe("/ws/headless")
    expect(term.isHeadless(terminalId)).toBe(true)
    expect(svc.get(session.id)!.terminals.find((t) => t.id === terminalId)!.cwd).toBe("/ws/headless")
  })

  it("an EXPLICIT cwd always wins over the active workspace dir", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000, getActiveWorkspaceDir: () => "/ws/primary" })
    svc.attachTerminals(term as any)
    svc.openSession("/explicit/path")
    expect(term.spawned[0].cwd).toBe("/explicit/path")
  })

  it("NO active workspace dir → the default cwd behavior (undefined → TerminalService default)", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000, getActiveWorkspaceDir: () => null })
    svc.attachTerminals(term as any)
    svc.openSession("")
    expect(term.spawned[0].cwd).toBeUndefined()
  })

  it("no getActiveWorkspaceDir injected → default cwd (existing call sites unaffected)", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000 })
    svc.attachTerminals(term as any)
    svc.openSession("")
    expect(term.spawned[0].cwd).toBeUndefined()
  })

  it("a terminal added to an EXISTING session INHERITS the session's cwd, NOT the (now-different) active workspace dir", () => {
    let activeDir: string | null = "/ws/A"
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000, getActiveWorkspaceDir: () => activeDir })
    svc.attachTerminals(term as any)
    // New session opens in workspace A.
    const { session } = svc.openSession("")
    expect(term.spawned[0].cwd).toBe("/ws/A")
    // User switches the active workspace to B, then adds a terminal to the A session.
    activeDir = "/ws/B"
    svc.addTerminalToSession(session.id, "")
    // The added terminal inherits A's cwd — it does NOT re-resolve to B.
    expect(term.spawned[1].cwd).toBe("/ws/A")
  })

  it("a RESTORE (reopenTerminal) keeps the ref's recorded cwd — never the active workspace dir", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000, getActiveWorkspaceDir: () => "/ws/CHANGED" })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/original/cwd")
    expect(term.spawned[0].cwd).toBe("/original/cwd")
    // App-close: the terminal dies but its ref persists with /original/cwd.
    term.emit({ type: "exit", id: terminalId })
    const ref = svc.get(session.id)!.terminals[0]
    svc.reopenTerminal(session.id, ref.id)
    // The reopen re-passes the RECORDED cwd, even though the active workspace dir changed.
    const last = term.spawned[term.spawned.length - 1]
    expect(last.cwd).toBe("/original/cwd")
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

describe("SessionService terminal activity & state", () => {
  it("setTerminalActivity sets the rich-presence line + timestamp and persists", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    svc.addTerminal(s.id, { id: "t1", name: "x", cwd: "/r", lastState: "idle" })
    svc.setTerminalActivity(s.id, "t1", "running the test suite")
    const t = svc.get(s.id)!.terminals[0]
    expect(t.activity).toBe("running the test suite")
    expect(t.activityAt).toBe(1000)
    // persisted (inside the versioned envelope)
    const stored = JSON.parse(readFileSync(join(dir, `${s.id}.json`), "utf-8")).data
    expect(stored.terminals[0].activity).toBe("running the test suite")
  })

  it("setTerminalActivity is a no-op for unknown session/terminal", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    expect(() => svc.setTerminalActivity(s.id, "nope", "x")).not.toThrow()
    expect(() => svc.setTerminalActivity("nope", "t1", "x")).not.toThrow()
  })

  it("setTerminalActivity emits worksession:updated so the renderer refreshes live (CAPP-84 regression)", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const send = vi.fn()
    svc.setMainWindow({ webContents: { send }, isDestroyed: () => false })
    const s = svc.create()
    svc.addTerminal(s.id, { id: "t1", name: "x", cwd: "/r", lastState: "idle" })
    send.mockClear() // ignore the create/addTerminal pushes — assert on the activity push only
    svc.setTerminalActivity(s.id, "t1", "Testing the agent rail NOW line")
    const call = send.mock.calls.find((c) => c[0] === "worksession:updated")
    // Without the emit (the bug) this is undefined → the renderer never refreshes.
    expect(call).toBeTruthy()
    const snapshot = call![1] as { terminals: Array<{ activity?: string }> }
    expect(snapshot.terminals[0].activity).toBe("Testing the agent rail NOW line")
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
    svc.renameSession(a.id, "newer")
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
  spawned: Array<{ id: string; name?: string; cwd?: string; sessionId?: string; resumeConvId?: string; headless?: boolean; login?: boolean; xterm?: boolean; model?: string; effort?: string; ultracode?: boolean }> = []
  private cb: ((e: any) => void) | null = null
  writes: Array<{ id: string; data: string }> = []
  output = new Map<string, string>()
  /** Terminal ids this fake reports as headless (BO-5 structured engine). */
  headlessIds = new Set<string>()
  /** CAPP-39 gate ②: terminal ids this fake reports as the interactive login PTY. */
  loginIds = new Set<string>()
  /** BO-11: terminal ids the fake reports as parked on a permission prompt. */
  pendingPermissionIds = new Set<string>()
  /** BO-11: records each abort-drain call (id + message) for assertions. */
  aborted: Array<{ id: string; message: string }> = []
  /** BO-11: "auto" resolves abort-drain immediately; "manual" parks it in
   *  pendingDrains so a test can race a kill in DURING the drain before resolving. */
  drainMode: "auto" | "manual" = "auto"
  pendingDrains: Array<{ id: string; resolve: (v: boolean) => void }> = []
  /** WS-G test fidelity: when set, `create()` ROUTES to `createHeadless()` exactly
   *  like the real TerminalService.create() does when the engine is "structured" —
   *  so a structured-engine test exercises the real headless dispatch (and records
   *  the cwd on a `headless: true` spawn), not the xterm branch. */
  structuredEngine = false
  // BO-6: model is the 5th arg on create() and the 6th on createHeadless()
  // (after allowedTools); CAPP-46: effort is the next positional arg on each,
  // matching the real TerminalService positions.
  create(name?: string, cwd?: string, sessionId?: string, resumeConvId?: string, model?: string, effort?: string, ultracode?: boolean) {
    if (this.structuredEngine) {
      // Mirror create()'s structured routing: createHeadless(name, cwd, sessionId,
      // resumeConvId, allowedTools=undefined, model, effort, ultracode).
      return this.createHeadless(name, cwd, sessionId, resumeConvId, undefined, model, effort, ultracode)
    }
    const id = `live-${++this.n}`
    this.spawned.push({ id, name, cwd, sessionId, resumeConvId, model, effort, ultracode })
    return { id, name: name ?? id, cwd: cwd ?? "/", state: "active" as const, engine: "xterm" as const, model, effort, ultracode }
  }
  // CAPP-108: ultracode is the 8th arg on createHeadless. When ON the real service
  // omits --effort (ultracode forces xhigh); the fake mirrors that so effort-vs-
  // ultracode preservation assertions hold.
  createHeadless(name?: string, cwd?: string, sessionId?: string, resumeConvId?: string, _allowedTools?: string[], model?: string, effort?: string, ultracode?: boolean) {
    const id = `head-${++this.n}`
    this.headlessIds.add(id)
    const resolvedUltracode = ultracode === true
    const resolvedEffort = resolvedUltracode ? undefined : effort
    this.spawned.push({ id, name, cwd, sessionId, resumeConvId, headless: true, model, effort: resolvedEffort, ultracode: resolvedUltracode })
    return { id, name: name ?? id, cwd: cwd ?? "/", state: "active" as const, engine: "structured" as const, model, effort: resolvedEffort, ultracode: resolvedUltracode }
  }
  // CAPP-39 gate ② — a one-time interactive `claude /login` xterm terminal.
  createLogin(name?: string, cwd?: string, sessionId?: string) {
    const id = `login-${++this.n}`
    this.loginIds.add(id)
    this.spawned.push({ id, name, cwd, sessionId, login: true })
    return { id, name: name ?? "Sign in", cwd: cwd ?? "/", state: "active" as const, engine: "xterm" as const, isLogin: true }
  }
  // CAPP-39 gate ③ — an xterm PTY spawned INDEPENDENT of the global engine (the
  // raw-view escape hatch). Returns NO model/effort (an xterm path has no --model/
  // --effort), exactly like the real createXterm, so the model/effort-preservation
  // assertions are exercised.
  createXterm(name?: string, cwd?: string, sessionId?: string, resumeConvId?: string, _model?: string, _effort?: string, _ultracode?: boolean) {
    const id = `xterm-${++this.n}`
    this.spawned.push({ id, name, cwd, sessionId, resumeConvId, xterm: true })
    return { id, name: name ?? id, cwd: cwd ?? "/", state: "active" as const, engine: "xterm" as const }
  }
  isHeadless(id: string) { return this.headlessIds.has(id) }
  isLogin(id: string) { return this.loginIds.has(id) }
  /** CAPP-126: per-terminal picker catalogs + the seed log so a restore test can
   *  assert reopenTerminal re-seeds the persisted catalog onto the fresh PTY. */
  catalogs = new Map<string, any>()
  seededCatalogs: Array<{ id: string; catalog: any }> = []
  seedCatalog(id: string, catalog: any) {
    this.seededCatalogs.push({ id, catalog })
    if (!this.catalogs.has(id)) this.catalogs.set(id, catalog)
  }
  getCatalog(id: string) { return this.catalogs.get(id) ?? null }
  /** CAPP-39 gate ③: terminal ids the fake reports as busy (generating / permission). */
  busyIds = new Set<string>()
  isBusy(id: string) { return this.busyIds.has(id) }
  hasPendingPermission(id: string) { return this.pendingPermissionIds.has(id) }
  async abortPendingPermissionAndDrain(id: string, message: string) {
    this.aborted.push({ id, message })
    this.pendingPermissionIds.delete(id)
    if (this.drainMode === "manual") {
      return new Promise<boolean>((resolve) => this.pendingDrains.push({ id, resolve }))
    }
    return true
  }
  // A killed proc is no longer headless/alive and holds no pending permission —
  // mirrors the real teardownHeadless, so interruptAgent's re-validation (isHeadless)
  // sees a racing killSession/closeTerminal.
  kill(id: string) {
    this.killed.push(id)
    this.headlessIds.delete(id)
    this.pendingPermissionIds.delete(id)
    return true
  }
  write(id: string, data: string) { this.writes.push({ id, data }) }
  getOutput(id: string) { return this.output.get(id) ?? null }
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

describe("SessionService convo recording", () => {
  it("records ccConversationId when the terminal emits a convo event", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo")

    term.emit({ type: "convo", id: terminalId, ccConversationId: "abc-123" })

    const ref = svc.get(session.id)!.terminals.find((t) => t.id === terminalId)
    expect(ref?.ccConversationId).toBe("abc-123")
  })

  it("reopenTerminal forwards the stored ccConversationId to spawn", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo")
    term.emit({ type: "convo", id: terminalId, ccConversationId: "keep-me" })
    // simulate app-close: terminal exits, ref goes dead but stays (the resume path)
    term.emit({ type: "exit", id: terminalId })

    const ref = svc.get(session.id)!.terminals[0]
    svc.reopenTerminal(session.id, ref.id)

    const last = term.spawned[term.spawned.length - 1]
    expect(last.resumeConvId).toBe("keep-me")
  })
})

// CAPP-113 — the resolved-model echo: the headless `init` stream event reports the
// RESOLVED full model id; SessionService records it onto the terminal ref (the
// picker's tooltip). Mirrors the convo-recording seam above (same onEvent stream).
describe("SessionService resolvedModel recording (CAPP-113)", () => {
  it("records the resolved model id off a stream init event onto the terminal ref", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo")

    term.emit({ type: "stream", id: terminalId, event: { kind: "init", model: "claude-opus-4-8" } })

    const ref = svc.get(session.id)!.terminals.find((t) => t.id === terminalId)
    expect(ref?.resolvedModel).toBe("claude-opus-4-8")
  })

  it("ignores non-init stream events and an init with a missing/blank model (ref untouched)", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo")

    term.emit({ type: "stream", id: terminalId, event: { kind: "assistant_delta", text: "hi" } })
    term.emit({ type: "stream", id: terminalId, event: { kind: "init" } })
    term.emit({ type: "stream", id: terminalId, event: { kind: "init", model: "   " } })

    const ref = svc.get(session.id)!.terminals.find((t) => t.id === terminalId)
    expect(ref?.resolvedModel).toBeUndefined()

    // And a later VALID init still lands (the guards above didn't wedge anything).
    term.emit({ type: "stream", id: terminalId, event: { kind: "init", model: "claude-fable-5" } })
    expect(svc.get(session.id)!.terminals[0].resolvedModel).toBe("claude-fable-5")
  })
})

// CAPP-126 — the picker catalog is captured off the headless `init` stream event and
// PERSISTED on the terminal ref so a restored terminal's `/`-autocomplete works BEFORE
// its first turn (init lands only after the first message). On reopen, the persisted
// catalog is seeded back onto the fresh PTY.
describe("SessionService picker-catalog persistence + restore seeding (CAPP-126)", () => {
  it("records the picker catalog off a stream init event onto the ref + persists it", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo")

    term.emit({
      type: "stream",
      id: terminalId,
      event: { kind: "init", slashCommands: ["clear", "compact"], skills: ["deep-research"] },
    })

    const ref = svc.get(session.id)!.terminals.find((t) => t.id === terminalId)
    expect(ref?.catalog).toEqual({ slashCommands: ["clear", "compact"], skills: ["deep-research"] })
    // Survives a fresh service load (persisted to disk).
    const b = new SessionService({ dir, now: () => 2000 })
    b.load()
    expect(b.get(session.id)!.terminals[0].catalog).toEqual({
      slashCommands: ["clear", "compact"],
      skills: ["deep-research"],
    })
  })

  it("ignores an init with no catalog arrays and dedups an unchanged re-report (no ref churn)", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo")

    // An init with no slash_commands/skills leaves the catalog undefined.
    term.emit({ type: "stream", id: terminalId, event: { kind: "init", model: "claude-opus-4-8" } })
    expect(svc.get(session.id)!.terminals[0].catalog).toBeUndefined()

    // A first real catalog lands; a second identical re-report is a no-op (dedup).
    term.emit({ type: "stream", id: terminalId, event: { kind: "init", slashCommands: ["clear"], skills: [] } })
    const after = svc.get(session.id)!.updatedAt
    term.emit({ type: "stream", id: terminalId, event: { kind: "init", slashCommands: ["clear"], skills: [] } })
    expect(svc.get(session.id)!.updatedAt).toBe(after) // unchanged → not re-persisted
  })

  it("reopenTerminal seeds the persisted catalog onto the fresh restored terminal", () => {
    const term = new FakeTerminals()
    term.structuredEngine = true // route create() → the headless path (real restore shape)
    const svc = new SessionService({ dir, now: () => 1000 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo")
    term.emit({
      type: "stream",
      id: terminalId,
      event: { kind: "init", slashCommands: ["clear", "compact"], skills: ["deep-research"] },
    })
    // App-close: the terminal exits, its ref goes dead but stays (the resume path).
    term.emit({ type: "exit", id: terminalId })

    const ref = svc.get(session.id)!.terminals[0]
    const r = svc.reopenTerminal(session.id, ref.id)!

    // The fresh PTY was seeded with last session's catalog (before any live init).
    expect(term.seededCatalogs).toContainEqual({
      id: r.terminalId,
      catalog: { slashCommands: ["clear", "compact"], skills: ["deep-research"] },
    })
    expect(term.getCatalog(r.terminalId)).toEqual({
      slashCommands: ["clear", "compact"],
      skills: ["deep-research"],
    })
  })

  it("reopenTerminal seeds nothing when the ref has no persisted catalog (legacy ref)", () => {
    const term = new FakeTerminals()
    term.structuredEngine = true
    const svc = new SessionService({ dir, now: () => 1000 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo")
    term.emit({ type: "exit", id: terminalId })
    svc.reopenTerminal(session.id, svc.get(session.id)!.terminals[0].id)
    expect(term.seededCatalogs).toHaveLength(0)
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
    // spawning injects nothing (no seed-paste); write is only used by idle-flush/handoff
    expect(term.writes.length).toBe(0)
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

describe("SessionService effective activity", () => {
  it("falls back to parsed output when self-report is stale", () => {
    const term = new FakeTerminals()
    let clock = 1000
    const svc = new SessionService({ dir, now: () => clock })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo")
    term.output.set(terminalId, "● Edit(foo.ts)")

    // self-report at t=1000
    svc.setTerminalActivity(session.id, terminalId, "planning")
    // advance well past the stale threshold; terminal still active
    clock = 1000 + 60_000
    svc.setTerminalState(session.id, terminalId, "active")

    expect(svc.effectiveActivity(session.id, terminalId)).toBe("Edit(foo.ts)")
  })

  it("uses self-reported activity when fresh", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 5000 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo")
    svc.setTerminalActivity(session.id, terminalId, "running tests")
    expect(svc.effectiveActivity(session.id, terminalId)).toBe("running tests")
  })
})

describe("SessionService.getOverview", () => {
  it("returns identity + status + terminals (the durable knowledge tier was removed in R3a)", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const { session } = svc.openSession("/repo")

    const ov = svc.getOverview(session.id)!
    expect(ov.id).toBe(session.id)
    expect(ov.name).toBe(svc.get(session.id)!.name)
    expect(ov.status).toBe("active")
    expect(ov.terminals.length).toBe(1)
  })

  it("returns undefined for an unknown session", () => {
    const svc = new SessionService({ dir, now: () => 1 })
    expect(svc.getOverview("nope")).toBeUndefined()
  })
})

describe("SessionService.handoffTerminal", () => {
  it("spawns a fresh terminal in the same session and retires the old one", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo")

    const r = svc.handoffTerminal(session.id, terminalId)

    const s = svc.get(session.id)!
    const oldRef = s.terminals.find((t) => t.id === terminalId)
    expect(oldRef?.lastState).toBe("dead")
    expect(r?.terminalId).toBeTruthy()
    expect(r!.terminalId).not.toBe(terminalId)
    expect(s.terminals.find((t) => t.id === r!.terminalId)?.lastState).toBe("active")
  })

  it("returns undefined for an unknown session", () => {
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(new FakeTerminals() as any)
    expect(svc.handoffTerminal("nope", "nope")).toBeUndefined()
  })

  it("REFUSES handoff on a login terminal: no kill, no replacement spawn (CAPP-54 gate ② FIX B)", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    // A live interactive `claude /login` terminal (isLogin ref + fake.loginIds set).
    const login = svc.startLogin(s.id)!
    const spawnedBefore = term.spawned.length

    const r = svc.handoffTerminal(s.id, login.terminalId)

    // No-op: returns undefined, the login PTY is NOT killed, and NO replacement agent
    // terminal is spawned (an in-progress sign-in must never be silently discarded).
    expect(r).toBeUndefined()
    expect(term.killed).not.toContain(login.terminalId)
    expect(term.spawned.length).toBe(spawnedBefore)
    // The login ref is still live in the session.
    expect(svc.get(s.id)!.terminals.find((t) => t.id === login.terminalId)?.lastState).not.toBe("dead")
  })
})

describe("SessionService.setTerminalModel (BO-6)", () => {
  it("respawns a structured terminal: kills old, resumes the SAME convo with the new --model, updates the ref", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    // Register a HEADLESS terminal into a session by hand.
    const s = svc.create()
    const head = term.createHeadless(undefined, "/repo", s.id, undefined, undefined, "opus")
    svc.addTerminal(s.id, { id: head.id, name: head.name, cwd: head.cwd, lastState: "active", engine: "structured", model: "opus" })
    // It has captured a conversation id (so the respawn can --resume it).
    term.emit({ type: "convo", id: head.id, ccConversationId: "conv-keep" })

    const r = svc.setTerminalModel(s.id, head.id, "sonnet")

    // Old terminal killed; a fresh headless terminal spawned with resume + new model.
    expect(term.killed).toContain(head.id)
    const last = term.spawned[term.spawned.length - 1]
    expect(last.headless).toBe(true)
    expect(last.resumeConvId).toBe("conv-keep")
    expect(last.model).toBe("sonnet")
    // The ref is updated in place: new id, persisted new model.
    expect(r?.terminalId).toBe(last.id)
    const ref = svc.get(s.id)!.terminals.find((t) => t.id === last.id)
    expect(ref?.model).toBe("sonnet")
    expect(ref?.lastState).toBe("active")
  })

  it("is a no-op for an xterm (non-structured) terminal — it has no --model knob", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo") // create() → live-* (PTY, not headless)
    expect(svc.setTerminalModel(session.id, terminalId, "sonnet")).toBeUndefined()
    expect(term.killed).not.toContain(terminalId)
  })

  it("returns undefined for an unknown session / terminal / blank model", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    const head = term.createHeadless(undefined, "/repo", s.id)
    svc.addTerminal(s.id, { id: head.id, name: head.name, cwd: head.cwd, lastState: "active", engine: "structured" })
    expect(svc.setTerminalModel("nope", head.id, "sonnet")).toBeUndefined()
    expect(svc.setTerminalModel(s.id, "nope", "sonnet")).toBeUndefined()
    expect(svc.setTerminalModel(s.id, head.id, "   ")).toBeUndefined()
  })
})

describe("SessionService.setTerminalEffort (CAPP-46)", () => {
  it("respawns a structured terminal: kills old, resumes the SAME convo with the new --effort, updates the ref (preserving model)", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    const head = term.createHeadless(undefined, "/repo", s.id, undefined, undefined, "opus")
    svc.addTerminal(s.id, { id: head.id, name: head.name, cwd: head.cwd, lastState: "active", engine: "structured", model: "opus" })
    // It has captured a conversation id (so the respawn can --resume it).
    term.emit({ type: "convo", id: head.id, ccConversationId: "conv-keep" })

    const r = svc.setTerminalEffort(s.id, head.id, "high")

    // Old terminal killed; a fresh headless terminal spawned with resume + new effort.
    expect(term.killed).toContain(head.id)
    const last = term.spawned[term.spawned.length - 1]
    expect(last.headless).toBe(true)
    expect(last.resumeConvId).toBe("conv-keep")
    expect(last.effort).toBe("high")
    // The model is PRESERVED across the effort switch (passed through unchanged).
    expect(last.model).toBe("opus")
    // The ref is updated in place: new id, persisted new effort, same model.
    expect(r?.terminalId).toBe(last.id)
    const ref = svc.get(s.id)!.terminals.find((t) => t.id === last.id)
    expect(ref?.effort).toBe("high")
    expect(ref?.model).toBe("opus")
    expect(ref?.lastState).toBe("active")
  })

  it("a blank effort CLEARS the level: the respawn omits --effort and the ref's effort is undefined", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    const head = term.createHeadless(undefined, "/repo", s.id, undefined, undefined, "opus", "high")
    svc.addTerminal(s.id, { id: head.id, name: head.name, cwd: head.cwd, lastState: "active", engine: "structured", model: "opus", effort: "high" })
    term.emit({ type: "convo", id: head.id, ccConversationId: "conv-keep" })

    const r = svc.setTerminalEffort(s.id, head.id, "   ")

    const last = term.spawned[term.spawned.length - 1]
    // Blank value → undefined effort passed to the spawn (the real spawn then omits --effort).
    expect(last.effort).toBeUndefined()
    const ref = svc.get(s.id)!.terminals.find((t) => t.id === r?.terminalId)
    expect(ref?.effort).toBeUndefined()
  })

  it("is a no-op for an xterm (non-structured) terminal — it has no --effort knob", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo") // create() → live-* (PTY, not headless)
    expect(svc.setTerminalEffort(session.id, terminalId, "high")).toBeUndefined()
    expect(term.killed).not.toContain(terminalId)
  })

  it("returns undefined for an unknown session / terminal", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    const head = term.createHeadless(undefined, "/repo", s.id)
    svc.addTerminal(s.id, { id: head.id, name: head.name, cwd: head.cwd, lastState: "active", engine: "structured" })
    expect(svc.setTerminalEffort("nope", head.id, "high")).toBeUndefined()
    expect(svc.setTerminalEffort(s.id, "nope", "high")).toBeUndefined()
  })
})

describe("SessionService.setTerminalUltracode (CAPP-108)", () => {
  it("respawns a structured terminal: kills old, resumes the SAME convo with ultracode ON, suppresses effort, preserves model", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    const head = term.createHeadless(undefined, "/repo", s.id, undefined, undefined, "opus", "high")
    svc.addTerminal(s.id, { id: head.id, name: head.name, cwd: head.cwd, lastState: "active", engine: "structured", model: "opus", effort: "high" })
    term.emit({ type: "convo", id: head.id, ccConversationId: "conv-keep" })

    const r = svc.setTerminalUltracode(s.id, head.id, true)

    expect(term.killed).toContain(head.id)
    const last = term.spawned[term.spawned.length - 1]
    expect(last.headless).toBe(true)
    expect(last.resumeConvId).toBe("conv-keep")
    expect(last.ultracode).toBe(true)
    // ultracode ON forces xhigh, so --effort is suppressed (effort cleared on the spawn).
    expect(last.effort).toBeUndefined()
    expect(last.model).toBe("opus")
    // The ref is updated in place.
    expect(r?.terminalId).toBe(last.id)
    const ref = svc.get(s.id)!.terminals.find((t) => t.id === last.id)
    expect(ref?.ultracode).toBe(true)
    expect(ref?.model).toBe("opus")
  })

  it("turning ultracode OFF resumes the same convo with ultracode false (no --settings)", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    const head = term.createHeadless(undefined, "/repo", s.id, undefined, undefined, "opus", undefined, true)
    svc.addTerminal(s.id, { id: head.id, name: head.name, cwd: head.cwd, lastState: "active", engine: "structured", model: "opus", ultracode: true })
    term.emit({ type: "convo", id: head.id, ccConversationId: "conv-keep" })

    const r = svc.setTerminalUltracode(s.id, head.id, false)
    const last = term.spawned[term.spawned.length - 1]
    expect(last.ultracode).toBe(false)
    const ref = svc.get(s.id)!.terminals.find((t) => t.id === r?.terminalId)
    expect(ref?.ultracode).toBe(false)
  })

  it("is a no-op for an xterm (non-structured) terminal — it has no --settings knob", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo")
    expect(svc.setTerminalUltracode(session.id, terminalId, true)).toBeUndefined()
    expect(term.killed).not.toContain(terminalId)
  })

  it("returns undefined for an unknown session / terminal", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    const head = term.createHeadless(undefined, "/repo", s.id)
    svc.addTerminal(s.id, { id: head.id, name: head.name, cwd: head.cwd, lastState: "active", engine: "structured" })
    expect(svc.setTerminalUltracode("nope", head.id, true)).toBeUndefined()
    expect(svc.setTerminalUltracode(s.id, "nope", true)).toBeUndefined()
  })

  it("PERSISTS ultracode: it survives a fresh service load (round-trip)", () => {
    const a = new SessionService({ dir, now: () => 1 })
    const term = new FakeTerminals()
    a.attachTerminals(term as any)
    const s = a.create()
    const head = term.createHeadless(undefined, "/repo", s.id, undefined, undefined, "opus", undefined, true)
    a.addTerminal(s.id, { id: head.id, name: head.name, cwd: head.cwd, lastState: "active", engine: "structured", model: "opus", ultracode: true })

    const b = new SessionService({ dir, now: () => 2 })
    b.load()
    const ref = b.get(s.id)!.terminals.find((t) => t.id === head.id)
    expect(ref?.ultracode).toBe(true)
  })

  it("RE-APPLIES ultracode on reopen (a resume spawn): the ref's ultracode rides through to the spawn args", () => {
    const term = new FakeTerminals()
    term.structuredEngine = true // reopen's create() routes to the headless spawn
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    // A dead structured terminal ref carrying ultracode + a captured convo id.
    svc.addTerminal(s.id, {
      id: "head-dead",
      name: "x",
      cwd: "/repo",
      lastState: "dead",
      engine: "structured",
      model: "opus",
      ultracode: true,
      ccConversationId: "conv-reopen",
    })

    const r = svc.reopenTerminal(s.id, "head-dead")
    expect(r?.terminalId).toBeTruthy()
    const last = term.spawned[term.spawned.length - 1]
    // reopen re-passes the persisted ultracode (session-only → must ride every resume spawn).
    expect(last.ultracode).toBe(true)
    expect(last.resumeConvId).toBe("conv-reopen")
    // The ref adopts the spawn's posture.
    const ref = svc.get(s.id)!.terminals.find((t) => t.id === r?.terminalId)
    expect(ref?.ultracode).toBe(true)
  })

  it("a handoff carries the retired terminal's ultracode to the replacement (re-applied on the fresh spawn)", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    const head = term.createHeadless(undefined, "/repo", s.id, undefined, undefined, "opus", undefined, true)
    svc.addTerminal(s.id, { id: head.id, name: head.name, cwd: head.cwd, lastState: "active", engine: "structured", model: "opus", ultracode: true })

    const r = svc.handoffTerminal(s.id, head.id)
    expect(r?.terminalId).toBeTruthy()
    const last = term.spawned[term.spawned.length - 1]
    expect(last.headless).toBe(true)
    expect(last.ultracode).toBe(true)
  })
})

describe("SessionService.interruptAgent (BO-10)", () => {
  it("stops a structured terminal: kills old, respawns the SAME convo via --resume + same model, re-points the ref", async () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    const head = term.createHeadless(undefined, "/repo", s.id, undefined, undefined, "opus")
    svc.addTerminal(s.id, { id: head.id, name: head.name, cwd: head.cwd, lastState: "active", engine: "structured", model: "opus" })
    // It captured a conversation id, so the interrupt respawn can --resume it.
    term.emit({ type: "convo", id: head.id, ccConversationId: "conv-keep" })

    const r = await svc.interruptAgent(head.id)

    // Old proc killed; a fresh headless terminal resumed the SAME convo, SAME model.
    expect(term.killed).toContain(head.id)
    const last = term.spawned[term.spawned.length - 1]
    expect(last.headless).toBe(true)
    expect(last.resumeConvId).toBe("conv-keep")
    expect(last.model).toBe("opus") // model preserved across the interrupt (not changed)
    // Ref re-pointed in place at the new terminal id.
    expect(r?.terminalId).toBe(last.id)
    const ref = svc.get(s.id)!.terminals.find((t) => t.id === last.id)
    expect(ref?.lastState).toBe("active")
    expect(ref?.model).toBe("opus")
  })

  it("BO-11: when parked on a permission, closes the turn THROUGH the live proc (abort-drain) BEFORE killing", async () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    const head = term.createHeadless(undefined, "/repo", s.id, undefined, undefined, "opus")
    svc.addTerminal(s.id, { id: head.id, name: head.name, cwd: head.cwd, lastState: "active", engine: "structured", model: "opus" })
    term.emit({ type: "convo", id: head.id, ccConversationId: "conv-keep" })
    // The terminal is parked on a permission prompt (the half-open-turn hazard).
    term.pendingPermissionIds.add(head.id)

    const r = await svc.interruptAgent(head.id)

    // The parked permission was settled via abort-drain (deny THROUGH the live proc)…
    expect(term.aborted).toHaveLength(1)
    expect(term.aborted[0].id).toBe(head.id)
    expect(term.aborted[0].message).toMatch(/interrupted|stop/i)
    // …and ONLY THEN was the proc killed + resumed (turn closed first, so --resume is clean).
    expect(term.killed).toContain(head.id)
    const last = term.spawned[term.spawned.length - 1]
    expect(last.resumeConvId).toBe("conv-keep")
    expect(r?.terminalId).toBe(last.id)
  })

  it("BO-11: a generating turn (no pending permission) goes straight to kill+resume — no abort-drain", async () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    const head = term.createHeadless(undefined, "/repo", s.id, undefined, undefined, "opus")
    svc.addTerminal(s.id, { id: head.id, name: head.name, cwd: head.cwd, lastState: "active", engine: "structured", model: "opus" })
    term.emit({ type: "convo", id: head.id, ccConversationId: "conv-keep" })
    // No pending permission → nothing half-open to close.

    const r = await svc.interruptAgent(head.id)

    expect(term.aborted).toHaveLength(0) // no abort-drain when nothing is parked
    expect(term.killed).toContain(head.id)
    expect(r?.terminalId).toBe(term.spawned[term.spawned.length - 1].id)
  })

  // Set up a structured terminal parked on a permission, with the abort-drain PAUSED
  // (manual mode) so a teardown can race in DURING the drain window.
  function parkedHeadlessWithPausedDrain() {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    const head = term.createHeadless(undefined, "/repo", s.id, undefined, undefined, "opus")
    svc.addTerminal(s.id, { id: head.id, name: head.name, cwd: head.cwd, lastState: "active", engine: "structured", model: "opus" })
    term.emit({ type: "convo", id: head.id, ccConversationId: "conv-keep" })
    term.pendingPermissionIds.add(head.id)
    term.drainMode = "manual"
    return { term, svc, s, head }
  }

  it("BO-11 re-entrancy: a killSession DURING the abort-drain makes interruptAgent BAIL — no respawn, no zombie JSON, no re-add", async () => {
    const { term, svc, s, head } = parkedHeadlessWithPausedDrain()
    const sends: string[] = []
    svc.setMainWindow({ isDestroyed: () => false, webContents: { send: (ch: string) => sends.push(ch) } } as any)
    const jsonFile = join(dir, `${s.id}.json`)
    expect(existsSync(jsonFile)).toBe(true)
    const spawnsBefore = term.spawned.length

    const p = svc.interruptAgent(head.id) // runs to the await on the PARKED drain
    // Ctrl+K kills the whole session WHILE the drain is in flight.
    svc.killSession(s.id)
    expect(svc.get(s.id)).toBeUndefined()
    expect(existsSync(jsonFile)).toBe(false) // killSession unlinked it
    // The drain now resolves — interruptAgent resumes on the orphaned s/ref.
    term.pendingDrains[0].resolve(true)
    const r = await p

    expect(r).toBeUndefined() // BAILED
    expect(term.spawned.length).toBe(spawnsBefore) // createHeadless NOT called post-kill (no leaked proc)
    expect(svc.get(s.id)).toBeUndefined() // session stays gone
    expect(existsSync(jsonFile)).toBe(false) // persist() did NOT re-write a zombie file
    expect(sends).not.toContain("worksession:updated") // no killed sidebar row re-added
  })

  it("BO-11 re-entrancy: a closeTerminal DURING the abort-drain makes interruptAgent BAIL — the ref is not respawned/re-added", async () => {
    const { term, svc, s, head } = parkedHeadlessWithPausedDrain()
    const spawnsBefore = term.spawned.length

    const p = svc.interruptAgent(head.id)
    // Ctrl+W closes the terminal (drops the ref + kills the proc) mid-drain.
    svc.closeTerminal(s.id, head.id)
    expect(svc.get(s.id)!.terminals.some((t) => t.id === head.id)).toBe(false)
    term.pendingDrains[0].resolve(true)
    const r = await p

    expect(r).toBeUndefined() // BAILED — the ref no longer lives
    expect(term.spawned.length).toBe(spawnsBefore) // no respawn of the closed terminal
    expect(svc.get(s.id)!.terminals.some((t) => t.id === head.id)).toBe(false) // not re-added
  })

  it("BO-11 single-flight: two overlapping interrupts on the same terminal respawn EXACTLY once", async () => {
    const { term, svc, head } = parkedHeadlessWithPausedDrain()
    const spawnsBefore = term.spawned.length

    const p1 = svc.interruptAgent(head.id) // enters, registers in-flight, awaits the PARKED drain
    const p2 = svc.interruptAgent(head.id) // single-flight → no-op
    expect(await p2).toBeUndefined()
    expect(term.aborted).toHaveLength(1) // only the first call started a drain

    term.pendingDrains[0].resolve(true)
    const r1 = await p1
    expect(r1?.terminalId).toBeTruthy()
    expect(term.spawned.length - spawnsBefore).toBe(1) // EXACTLY one respawn

    // After it settles, the single-flight slot is released — a later interrupt is allowed.
    expect((svc as any).interrupting.has(head.id)).toBe(false)
  })

  it("is a no-op for an xterm (non-structured) terminal — Esc must stay load-bearing in the PTY", async () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const { terminalId } = svc.openSession("/repo") // create() → live-* PTY, not headless
    expect(await svc.interruptAgent(terminalId)).toBeUndefined()
    expect(term.killed).not.toContain(terminalId)
  })

  it("returns undefined for an unknown terminal", async () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    svc.create()
    expect(await svc.interruptAgent("nope")).toBeUndefined()
    expect(term.killed).toEqual([])
  })
})

describe("SessionService.setTerminalEngine (CAPP-39 gate ③ — the raw-view escape hatch)", () => {
  /** A registered, conversation-bound, NON-busy structured terminal — the happy path. */
  function structuredReady(model = "opus") {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    const head = term.createHeadless(undefined, "/repo", s.id, undefined, undefined, model)
    svc.addTerminal(s.id, { id: head.id, name: head.name, cwd: head.cwd, lastState: "active", engine: "structured", model })
    term.emit({ type: "convo", id: head.id, ccConversationId: "conv-keep" })
    return { term, svc, s, head }
  }

  it("structured → xterm: kills old, spawns an XTERM resuming the SAME convo, flips the ref engine, preserves the model", () => {
    const { term, svc, s, head } = structuredReady("sonnet")

    const r = svc.setTerminalEngine(s.id, head.id, "xterm")

    // Old proc killed; a fresh XTERM (not headless) terminal spawned, resuming the convo.
    expect(term.killed).toContain(head.id)
    const last = term.spawned[term.spawned.length - 1]
    expect(last.xterm).toBe(true)
    expect(last.headless).toBeUndefined()
    expect(last.resumeConvId).toBe("conv-keep")
    // Ref re-pointed in place: new id, engine flipped to xterm, cc + model PRESERVED.
    expect(r?.terminalId).toBe(last.id)
    const ref = svc.get(s.id)!.terminals.find((t) => t.id === last.id)
    expect(ref?.engine).toBe("xterm")
    expect(ref?.ccConversationId).toBe("conv-keep")
    expect(ref?.model).toBe("sonnet") // xterm spawn returns no model → ref.model untouched
  })

  it("xterm → structured: kills old, spawns a HEADLESS resuming the SAME convo, flips the ref engine, re-pins the model", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    // A registered xterm terminal (engine xterm, a captured convo, NOT headless) carrying
    // a previously-chosen structured model on the ref (a prior structured→xterm round-trip).
    const x = term.create(undefined, "/repo", s.id)
    svc.addTerminal(s.id, { id: x.id, name: x.name, cwd: x.cwd, lastState: "active", engine: "xterm", model: "sonnet" })
    term.emit({ type: "convo", id: x.id, ccConversationId: "conv-keep" })

    const r = svc.setTerminalEngine(s.id, x.id, "structured")

    expect(term.killed).toContain(x.id)
    const last = term.spawned[term.spawned.length - 1]
    expect(last.headless).toBe(true)
    expect(last.resumeConvId).toBe("conv-keep")
    // The preserved structured model is re-passed to the headless spawn (round-trip restore).
    expect(last.model).toBe("sonnet")
    const ref = svc.get(s.id)!.terminals.find((t) => t.id === last.id)
    expect(r?.terminalId).toBe(last.id)
    expect(ref?.engine).toBe("structured")
    expect(ref?.model).toBe("sonnet")
  })

  it("round-trip structured → xterm → structured preserves the chosen model end-to-end", () => {
    const { term, svc, s, head } = structuredReady("sonnet")

    const toRaw = svc.setTerminalEngine(s.id, head.id, "xterm")!
    expect(svc.get(s.id)!.terminals.find((t) => t.id === toRaw.terminalId)?.model).toBe("sonnet")

    const back = svc.setTerminalEngine(s.id, toRaw.terminalId, "structured")!
    const last = term.spawned[term.spawned.length - 1]
    // The model survived the xterm leg and is re-pinned onto the structured respawn.
    expect(last.model).toBe("sonnet")
    expect(svc.get(s.id)!.terminals.find((t) => t.id === back.terminalId)?.model).toBe("sonnet")
  })

  it("no-op when already on the target engine (returns the same id, no kill/respawn)", () => {
    const { term, svc, s, head } = structuredReady()
    const before = term.spawned.length
    const r = svc.setTerminalEngine(s.id, head.id, "structured")
    expect(r?.terminalId).toBe(head.id) // same id back
    expect(term.killed).not.toContain(head.id)
    expect(term.spawned.length).toBe(before) // nothing spawned
  })

  it("REFUSES while busy (generating / permission-parked) — Stop first, then switch", () => {
    const { term, svc, s, head } = structuredReady()
    term.busyIds.add(head.id)
    const before = term.spawned.length
    expect(svc.setTerminalEngine(s.id, head.id, "xterm")).toBeUndefined()
    expect(term.killed).not.toContain(head.id) // not killed
    expect(term.spawned.length).toBe(before) // not respawned
  })

  it("REFUSES when no conversation id is captured yet (a switch would orphan the chat)", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    const head = term.createHeadless(undefined, "/repo", s.id, undefined, undefined, "opus")
    // NO convo event emitted → ref.ccConversationId is undefined.
    svc.addTerminal(s.id, { id: head.id, name: head.name, cwd: head.cwd, lastState: "active", engine: "structured", model: "opus" })
    const before = term.spawned.length
    expect(svc.setTerminalEngine(s.id, head.id, "xterm")).toBeUndefined()
    expect(term.killed).not.toContain(head.id)
    expect(term.spawned.length).toBe(before)
  })

  it("REFUSES toggling a login terminal", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    const login = svc.startLogin(s.id)!
    const before = term.spawned.length
    expect(svc.setTerminalEngine(s.id, login.terminalId, "structured")).toBeUndefined()
    expect(term.killed).not.toContain(login.terminalId)
    expect(term.spawned.length).toBe(before)
  })

  it("returns undefined for an unknown session / terminal / invalid target engine", () => {
    const { svc, s, head } = structuredReady()
    expect(svc.setTerminalEngine("nope", head.id, "xterm")).toBeUndefined()
    expect(svc.setTerminalEngine(s.id, "nope", "xterm")).toBeUndefined()
    expect(svc.setTerminalEngine(s.id, head.id, "bogus" as any)).toBeUndefined()
  })

  it("emits worksession:updated and logs a spawn event on a successful switch", () => {
    const { svc, s, head } = structuredReady()
    const sends: string[] = []
    svc.setMainWindow({ isDestroyed: () => false, webContents: { send: (ch: string) => sends.push(ch) } } as any)
    svc.setTerminalEngine(s.id, head.id, "xterm")
    expect(sends).toContain("worksession:updated")
    const log = svc.get(s.id)!.eventLog ?? []
    expect(log.some((e) => e.kind === "spawn" && /raw terminal/i.test(e.text))).toBe(true)
  })
})

describe("SessionService model persistence (BO-6)", () => {
  it("spawnInto persists the spawn's model on the ref", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    // The real create() returns model; the fake returns whatever it was passed
    // (undefined here, since spawnInto doesn't pass one) — but the field is wired.
    const { session, terminalId } = svc.openSession("/repo")
    const ref = svc.get(session.id)!.terminals.find((t) => t.id === terminalId)!
    expect("model" in ref).toBe(true)
  })

  it("reopenTerminal re-passes the persisted ref.model so the choice survives restart", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo")
    // Simulate a structured terminal that the user switched to sonnet.
    const ref = svc.get(session.id)!.terminals[0]
    ref.engine = "structured"
    ref.model = "sonnet"
    term.emit({ type: "exit", id: terminalId }) // app-close: ref goes dead

    svc.reopenTerminal(session.id, ref.id)

    const last = term.spawned[term.spawned.length - 1]
    expect(last.model).toBe("sonnet")
  })
})

describe("SessionService.getSessionTimeline (ST-1)", () => {
  it("appends a spawn event at openSession and returns it", () => {
    const term = new FakeTerminals()
    let clock = 1000
    const svc = new SessionService({ dir, now: () => clock })
    svc.attachTerminals(term as any)

    clock = 1000
    const { session } = svc.openSession("/repo") // spawn event

    const tl = svc.getSessionTimeline(session.id)
    expect(tl.map((e) => e.kind)).toEqual(["spawn"])
    expect(tl[0].time).toBe(1000)
    expect(tl[0].text).toContain("Spawned terminal")
  })

  it("records retire on closeTerminal and handoff on handoffTerminal", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo")
    svc.handoffTerminal(session.id, terminalId)
    const fresh = svc.get(session.id)!.terminals.find((t) => t.lastState === "active")!
    svc.closeTerminal(session.id, fresh.id)
    const kinds = svc.getSessionTimeline(session.id).map((e) => e.kind)
    expect(kinds).toContain("spawn")
    expect(kinds).toContain("handoff")
    expect(kinds).toContain("retire")
  })

  it("the durable eventLog is persisted inside the versioned envelope", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000 })
    svc.attachTerminals(term as any)
    const { session } = svc.openSession("/repo") // spawn event
    const stored = JSON.parse(readFileSync(join(dir, `${session.id}.json`), "utf-8"))
    expect(stored.schemaVersion).toBe(1)
    expect(stored.data.eventLog.some((e: any) => e.kind === "spawn")).toBe(true)
  })

  it("caps the eventLog at ~500 entries (oldest dropped)", () => {
    const svc = new SessionService({ dir, now: () => 0 })
    const s = svc.create()
    // Drive the private logEvent directly (the public spawn/handoff paths would each
    // need a fresh PTY); the cap is a property of logEvent regardless of the kind.
    for (let i = 0; i < 600; i++) (svc as any).logEvent(s, "spawn", `event ${i}`)
    const log = svc.get(s.id)!.eventLog!
    expect(log.length).toBe(500)
    // oldest dropped: the surviving window is the last 500 events
    expect(log[0].text).toContain("event 100")
    expect(log[log.length - 1].text).toContain("event 599")
  })

  it("returns [] for an unknown session", () => {
    const svc = new SessionService({ dir, now: () => 1 })
    expect(svc.getSessionTimeline("nope")).toEqual([])
  })

  it("a LEGACY (no eventLog) persisted session loads and backfills a single 'created' event", () => {
    // A real on-disk file from before ST-1: a valid v1 envelope whose data has NO
    // eventLog field. It must load cleanly (additive optional field, no schema bump)
    // and getSessionTimeline must backfill a single creation entry from createdAt.
    const legacyData = {
      id: "legacy-no-log",
      name: "Pre-ST-1 session",
      status: "active",
      terminals: [],
      createdAt: 1000,
      updatedAt: 1500,
      // NOTE: no eventLog key at all
    }
    const file = join(dir, "legacy-no-log.json")
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, data: legacyData }, null, 2))

    const svc = new SessionService({ dir, now: () => 9999 })
    svc.load()
    const loaded = svc.get("legacy-no-log")!
    expect(loaded.name).toBe("Pre-ST-1 session")
    expect(loaded.eventLog).toBeUndefined() // field stays absent, nothing forged

    const tl = svc.getSessionTimeline("legacy-no-log")
    expect(tl).toHaveLength(1)
    expect(tl[0].kind).toBe("spawn")
    expect(tl[0].time).toBe(1000)
    expect(tl[0].text).toContain("created")
  })
})

describe("SessionService.startLogin (CAPP-39 gate ②)", () => {
  it("spawns an INTERACTIVE login terminal (createLogin, not headless) into the caller's session", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    // A structured (headless) session — startLogin must NOT spawn another headless.
    const s = svc.create()
    const head = term.createHeadless(undefined, "/repo", s.id)
    svc.addTerminal(s.id, { id: head.id, name: head.name, cwd: head.cwd, lastState: "active" })

    const r = svc.startLogin(s.id)

    expect(r?.terminalId).toBeDefined()
    const spawn = term.spawned.find((x) => x.id === r!.terminalId)
    expect(spawn?.login).toBe(true)
    // It went into the SAME session, as a tab; engine is xterm (interactive OAuth UI).
    const ref = svc.get(s.id)!.terminals.find((t) => t.id === r!.terminalId)
    expect(ref).toBeDefined()
    expect(ref!.engine).toBe("xterm")
    // It inherits the session's cwd (derived from the existing terminal).
    expect(spawn?.cwd).toBe("/repo")
  })

  it("falls back to the first session when no sessionId is given", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const s = svc.create()

    const r = svc.startLogin()
    expect(svc.get(s.id)!.terminals.some((t) => t.id === r!.terminalId)).toBe(true)
  })

  it("creates a session when none exists yet", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    expect(svc.list()).toHaveLength(0)

    const r = svc.startLogin()
    expect(r?.terminalId).toBeDefined()
    expect(svc.list()).toHaveLength(1)
    expect(svc.list()[0].terminals.some((t) => t.id === r!.terminalId)).toBe(true)
  })

  it("marks the login ref isLogin and STRIPS it from the persisted JSON (never resurrected on restart)", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    const agent = term.create(undefined, "/repo", s.id)
    svc.addTerminal(s.id, { id: agent.id, name: agent.name, cwd: agent.cwd, lastState: "active" })

    const r = svc.startLogin(s.id)!
    // In-memory the login terminal is a live tab so the user can complete sign-in…
    const liveRef = svc.get(s.id)!.terminals.find((t) => t.id === r.terminalId)!
    expect(liveRef.isLogin).toBe(true)
    // …but the ON-DISK record OMITS it (a second SessionService.load() never sees it).
    const onDisk = JSON.parse(readFileSync(join(dir, `${s.id}.json`), "utf-8"))
    expect(onDisk.data.terminals.some((t: any) => t.id === r.terminalId)).toBe(false)
    expect(onDisk.data.terminals.some((t: any) => t.isLogin)).toBe(false)
    // The normal agent terminal IS persisted (the strip is login-only).
    expect(onDisk.data.terminals.some((t: any) => t.id === agent.id)).toBe(true)

    // A fresh service loading the file restores NO login terminal — no ghost "Sign in".
    const reloaded = new SessionService({ dir, now: () => 2 })
    reloaded.load()
    expect(reloaded.get(s.id)!.terminals.some((t) => t.isLogin)).toBe(false)
    expect(reloaded.get(s.id)!.terminals.some((t) => t.id === r.terminalId)).toBe(false)
  })

  it("reopenTerminal REFUSES a login ref (no respawn of /login or a normal terminal)", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    const r = svc.startLogin(s.id)!
    const spawnsBefore = term.spawned.length

    // Defensive guard: even if a login ref reached reopen (e.g. a legacy persisted
    // one), it is a no-op — it must NOT spawn a new terminal.
    const reopened = svc.reopenTerminal(s.id, r.terminalId)
    expect(reopened).toBeUndefined()
    expect(term.spawned.length).toBe(spawnsBefore)
  })
})

describe("SessionService.listFolderConversations + openConversationInFolder (CAPP-75)", () => {
  it("lists a folder's conversations via the injected ccProjectsRoot (reusing the encoding)", () => {
    const root = mkdtempSync(join(tmpdir(), "ctui-sess-cc-"))
    try {
      // Write a transcript under <root>/<encoded(folder)>/<id>.jsonl. The encoding
      // is the SAME one the discovery reuses, so an empty list would mean a mismatch.
      const folder = "C:\\Users\\ryguy\\projects\\foo"
      const encoded = folder.replace(/[:/\\]/g, "-")
      const projDir = join(root, encoded)
      mkdirSync(projDir, { recursive: true })
      writeFileSync(
        join(projDir, "conv-1.jsonl"),
        JSON.stringify({ type: "user", message: { content: "resume me" } }) + "\n",
      )

      const svc = new SessionService({ dir, now: () => 1000, ccProjectsRoot: root })
      const out = svc.listFolderConversations(folder)
      expect(out).toHaveLength(1)
      expect(out[0].id).toBe("conv-1")
      expect(out[0].preview).toBe("resume me")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("returns [] when the folder has no Claude project dir", () => {
    const svc = new SessionService({ dir, now: () => 1000, ccProjectsRoot: dir })
    expect(svc.listFolderConversations("C:\\nope\\missing")).toEqual([])
  })

  it("restore spawns `--resume <id>` with the folder as cwd in a new work session", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000 })
    svc.attachTerminals(term as any)

    const result = svc.openConversationInFolder("C:\\Users\\ryguy\\projects\\foo", "conv-42")
    expect(result).toBeDefined()
    // A fresh work session was created with the restored terminal registered.
    const session = svc.get(result!.session.id)!
    expect(session.terminals).toHaveLength(1)
    expect(session.terminals[0].id).toBe(result!.terminalId)
    expect(session.terminals[0].ccConversationId).toBe("conv-42")

    // The spawn carried the conversation id (→ --resume) and the folder cwd.
    const spawn = term.spawned.find((s) => s.id === result!.terminalId)!
    expect(spawn.resumeConvId).toBe("conv-42")
    expect(spawn.cwd).toBe("C:\\Users\\ryguy\\projects\\foo")
    expect(spawn.sessionId).toBe(result!.session.id)
  })

  it("restore is a no-op for blank folder / id, or when terminals aren't attached", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    // No terminals attached yet.
    expect(svc.openConversationInFolder("/x", "conv-1")).toBeUndefined()

    const term = new FakeTerminals()
    svc.attachTerminals(term as any)
    expect(svc.openConversationInFolder("", "conv-1")).toBeUndefined()
    expect(svc.openConversationInFolder("/x", "")).toBeUndefined()
    expect(term.spawned).toHaveLength(0)
  })
})

describe("SessionService.renameSession (CAPP-82 — container rename)", () => {
  it("renames the work-session container, persists, and emits worksession:updated", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const sends: Array<{ ch: string; args: unknown[] }> = []
    svc.setMainWindow({
      isDestroyed: () => false,
      webContents: { send: (ch: string, ...args: unknown[]) => sends.push({ ch, args }) },
    } as any)
    const s = svc.create()

    const ok = svc.renameSession(s.id, "Renamed Container")
    expect(ok).toBe(true)
    expect(svc.get(s.id)!.name).toBe("Renamed Container")

    // emitted the same update channel every other container mutation uses, with the
    // renamed session payload
    const update = sends.find((m) => m.ch === "worksession:updated")
    expect(update).toBeDefined()
    expect((update!.args[0] as { id: string; name: string }).name).toBe("Renamed Container")

    // persisted to disk (survives a reload)
    const b = new SessionService({ dir, now: () => 2000 })
    b.load()
    expect(b.get(s.id)!.name).toBe("Renamed Container")
  })

  it("trims surrounding whitespace before applying", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    expect(svc.renameSession(s.id, "   Spaced Out   ")).toBe(true)
    expect(svc.get(s.id)!.name).toBe("Spaced Out")
  })

  it("rejects a blank / whitespace-only name (returns false, name unchanged, no emit)", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const sends: string[] = []
    svc.setMainWindow({
      isDestroyed: () => false,
      webContents: { send: (ch: string) => sends.push(ch) },
    } as any)
    const s = svc.create()
    const before = svc.get(s.id)!.name

    expect(svc.renameSession(s.id, "")).toBe(false)
    expect(svc.renameSession(s.id, "   ")).toBe(false)
    expect(svc.get(s.id)!.name).toBe(before)
    expect(sends).not.toContain("worksession:updated")
  })

  it("returns false for an unknown session id", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    expect(svc.renameSession("nope", "X")).toBe(false)
  })
})
describe("SessionService CAPP-108 ultracode — model-switch + effort preservation (review fixes)", () => {
  function setup() {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    // A STRUCTURED terminal on an xhigh-capable model with a saved effort level.
    svc.addTerminal(s.id, {
      id: "t1", name: "x", cwd: "/r", lastState: "active",
      engine: "structured", model: "opus", effort: "high",
    } as any)
    return { svc, term, sessionId: s.id }
  }

  it("switching to a NON-xhigh model forces ultracode OFF (no stranded --settings)", () => {
    const { svc, term, sessionId } = setup()
    const on = svc.setTerminalUltracode(sessionId, "t1", true)!
    expect(term.spawned.at(-1)!.ultracode).toBe(true)
    // Switch to sonnet (no xhigh): ultracode must be forced OFF, not stranded ON with no UI.
    svc.setTerminalModel(sessionId, on.terminalId, "sonnet")
    expect(term.spawned.at(-1)!.ultracode).toBe(false)
    expect(svc.get(sessionId)!.terminals[0].ultracode).toBeFalsy()
  })

  it("an xhigh→xhigh model switch PRESERVES ultracode (the keep branch)", () => {
    const { svc, term, sessionId } = setup()
    const on = svc.setTerminalUltracode(sessionId, "t1", true)!
    svc.setTerminalModel(sessionId, on.terminalId, "opus[1m]") // still xhigh-capable
    expect(term.spawned.at(-1)!.ultracode).toBe(true)
  })

  it("toggling ultracode ON then OFF RESTORES the saved --effort (not Claude's default)", () => {
    const { svc, term, sessionId } = setup()
    const on = svc.setTerminalUltracode(sessionId, "t1", true)!
    expect(term.spawned.at(-1)!.effort).toBeUndefined() // suppressed while ultracode is on
    expect(svc.get(sessionId)!.terminals[0].effort).toBe("high") // but the ref is kept intact
    svc.setTerminalUltracode(sessionId, on.terminalId, false)
    expect(term.spawned.at(-1)!.effort).toBe("high") // restored on the spawn
    expect(svc.get(sessionId)!.terminals[0].effort).toBe("high")
  })
})

// CAPP-117 — effort-switch consistency: choosing an EXPLICIT non-xhigh effort while
// ultracode is ON must force ultracode OFF (ultracode suppresses --effort, so the pick
// would otherwise silently do nothing); choosing xhigh (or clearing effort) KEEPS it.
// Mirrors the CAPP-108 model-switch describe.
describe("SessionService CAPP-117 effort-switch ultracode consistency", () => {
  function setup() {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000 })
    svc.attachTerminals(term as any)
    const s = svc.create()
    // A STRUCTURED terminal on an xhigh-capable model with a saved effort level.
    svc.addTerminal(s.id, {
      id: "t1", name: "x", cwd: "/r", lastState: "active",
      engine: "structured", model: "opus", effort: "high",
    } as any)
    return { svc, term, sessionId: s.id }
  }

  it("picking a NON-xhigh effort while ultracode is ON forces ultracode OFF and APPLIES the effort", () => {
    const { svc, term, sessionId } = setup()
    const on = svc.setTerminalUltracode(sessionId, "t1", true)!
    expect(term.spawned.at(-1)!.ultracode).toBe(true)
    expect(term.spawned.at(-1)!.effort).toBeUndefined() // suppressed while ultracode is on

    svc.setTerminalEffort(sessionId, on.terminalId, "low")

    const last = term.spawned.at(-1)!
    expect(last.ultracode).toBe(false) // forced off so the pick can take
    expect(last.effort).toBe("low") // and the chosen effort actually applies
    expect(svc.get(sessionId)!.terminals[0].ultracode).toBeFalsy()
    expect(svc.get(sessionId)!.terminals[0].effort).toBe("low")
  })

  it("picking `xhigh` KEEPS ultracode (xhigh is what ultracode already forces)", () => {
    const { svc, term, sessionId } = setup()
    const on = svc.setTerminalUltracode(sessionId, "t1", true)!

    svc.setTerminalEffort(sessionId, on.terminalId, "xhigh")

    expect(term.spawned.at(-1)!.ultracode).toBe(true) // kept
    expect(svc.get(sessionId)!.terminals[0].ultracode).toBe(true)
  })

  it("CLEARING the effort (blank) KEEPS ultracode", () => {
    const { svc, term, sessionId } = setup()
    const on = svc.setTerminalUltracode(sessionId, "t1", true)!

    svc.setTerminalEffort(sessionId, on.terminalId, "   ")

    expect(term.spawned.at(-1)!.ultracode).toBe(true) // kept
    expect(svc.get(sessionId)!.terminals[0].ultracode).toBe(true)
  })
})

// CAPP-113 — the config models.xhigh override, END-TO-END through the model-switch
// keepUltra classification: the `xhighModels` seam (wired to resolveXhighModels in
// ipc.ts) must actually feed modelSupportsXhigh, so a config-declared xhigh model
// PRESERVES ultracode where the built-in matcher alone would force it off.
describe("SessionService CAPP-113 xhighModels config-override (keepUltra)", () => {
  function setup(xhighModels?: () => string[]) {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000, xhighModels })
    svc.attachTerminals(term as any)
    const s = svc.create()
    // A STRUCTURED terminal on an xhigh-capable model (mirrors the CAPP-108 setup).
    svc.addTerminal(s.id, {
      id: "t1", name: "x", cwd: "/r", lastState: "active",
      engine: "structured", model: "opus",
    } as any)
    return { svc, term, sessionId: s.id }
  }

  it("switching to a config-declared xhigh model KEEPS ultracode (the seam feeds keepUltra)", () => {
    const { svc, term, sessionId } = setup(() => ["zeus"])
    const on = svc.setTerminalUltracode(sessionId, "t1", true)!
    expect(term.spawned.at(-1)!.ultracode).toBe(true)

    svc.setTerminalModel(sessionId, on.terminalId, "zeus")

    const last = term.spawned.at(-1)!
    expect(last.model).toBe("zeus")
    expect(last.ultracode).toBe(true) // kept — config declared zeus xhigh-capable
    expect(svc.get(sessionId)!.terminals[0].ultracode).toBe(true)
  })

  it("CONTROL: without the override the same switch forces ultracode OFF (built-in matcher unchanged)", () => {
    const { svc, term, sessionId } = setup() // no xhighModels seam → default () => []
    const on = svc.setTerminalUltracode(sessionId, "t1", true)!
    expect(term.spawned.at(-1)!.ultracode).toBe(true)

    svc.setTerminalModel(sessionId, on.terminalId, "zeus")

    expect(term.spawned.at(-1)!.ultracode).toBe(false)
    expect(svc.get(sessionId)!.terminals[0].ultracode).toBeFalsy()
  })
})
