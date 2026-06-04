# Sessions-as-Containers: Two-Tier Renderer + Spawn Orchestration (Plan 3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the durable work-session *container* (built headless in Plans 1–2) the real organizing unit of the app: route terminal spawns through it, render a two-level session tree, scope the tab bar to the selected session's terminals, install the two-tier keymap, auto-pull `get_session_context` into every new terminal (native handoff), and show aggregate/per-terminal status — all driven by the existing PTY transport.

**Architecture:** `SessionService` (the container) gains a reference to `TerminalService` (the PTY service) and becomes the spawn orchestrator: creating a session spawns its first terminal, registers it, and seeds it; closing/killing flow through it. `TerminalService` grows a tiny `onEvent` hook so the container can reconcile live PTY state (`active`/`idle`/`dead`) into its persisted terminal refs and recompute session status. A new `worksession:*` IPC tier exposes the container to the renderer; the proven terminal-tier `session:*` channels (xterm output/input/resize) are **untouched**. `App.tsx` moves to two-tier state (`WorkSession ⊃ Terminal`), the sidebar renders the tree, and the tab bar shows the active session's terminals.

**Tech Stack:** Electron, React, TypeScript, xterm.js, node-pty, @modelcontextprotocol/sdk, vitest@4.1.8. Build: `npm run build`. Test: `npx vitest run`. UI verification: `take_screenshot` MCP tool / `npm run dev` + manual.

---

## Scope & Boundaries

**In scope (Plan 3a):**
- `TerminalService.onEvent` hook (additive; existing `sendToRenderer` calls preserved).
- `SessionService` orchestration: `attachTerminals`, reconciliation, `openSession`, `addTerminalToSession`, `closeTerminal`, `killSession`, `reopenTerminal`, seed-prompt hijack, `worksession:*` event emission.
- New `worksession:*` IPC channels + preload API + renderer event subscriptions.
- `App.tsx` two-tier state + types (`Session`→`Terminal`, new `WorkSession`), boot loads records with **zero auto-spawn**.
- `Sidebar` two-level tree (expand caret for 2+ terminals, activity line, aggregate dot).
- `TabBar` scoped to the selected session's terminals.
- Keymap: `Ctrl+N` (session), `Ctrl+T` (terminal), `Ctrl+W` (close terminal → empty-but-live), `Ctrl+K` (kill session, confirm), `Ctrl+1–9` (session), `Alt+1–9` (terminal), `Ctrl+Tab`/`Ctrl+Shift+Tab` (cycle terminals).
- Status rendering: aggregate session dot + per-terminal dot + self-reported activity line.

**Out of scope (Plan 3b):** `ccConversationId` capture + `claude --resume` true reattach (3a reopen = fresh, context-primed via the seed); idle-flush auto-summary; Session Overview panel + observer-seam promote/dismiss UI; parsed-fallback (B) activity; `Ctrl+H` retire-and-continue. Also out: the cosmetic rename of `session:*` IPC channels to `terminal:*` (kept as-is to protect the working xterm transport).

**Key pragmatic decision — terminal identity in 3a:** a `TerminalRef.id` always equals its *current live PTY id*. On reopen, a fresh PTY is spawned (new id) and the ref's `id` is updated in place (name/cwd carried over). True stable-identity resume via `ccConversationId` is Plan 3b. This keeps the renderer's xterm routing (keyed by live id on the existing `session:data` channel) unchanged.

## File Structure

- **Modify** `electron/services/terminals.ts` — add `TerminalEvent` type + `onEvent(cb)` listener set + `emitEvent` calls beside the existing created/state/exit `sendToRenderer` calls.
- **Modify** `electron/services/sessions.ts` — add `TerminalLike` interface, `attachTerminals`, `setMainWindow`, reconciliation, orchestration methods, `buildSeedPrompt`, event emission.
- **Modify** `electron/services/sessions.test.ts` — unit tests for reconciliation, orchestration, seed prompt (with a fake `TerminalLike`).
- **Modify** `electron/ipc.ts` — wire `workSessionService.attachTerminals(sessionService)` + `setMainWindow`; add `worksession:*` handlers.
- **Modify** `electron/preload.ts` — `worksession:*` invoke methods + `onWorkSession*` event subscriptions.
- **Modify** `src/App.tsx` — two-tier types/state, boot load, event wiring, new keymap, handlers.
- **Modify** `src/components/Sidebar.tsx` — two-level tree.
- **Modify** `src/components/TabBar.tsx` — tabs = active session's terminals.
- **Modify** `src/App.css` — tree/activity-line/aggregate-dot styles using existing tokens.

---

### Task 1: `TerminalService.onEvent` reconciliation hook

**Files:**
- Modify: `electron/services/terminals.ts` (type + listener set + emit calls)
- Test: `electron/services/terminals.test.ts` (new file)

The container needs to learn when a PTY changes state or exits. Add an in-process listener that fires the same data already sent to the renderer.

- [ ] **Step 1: Write the failing test**

Create `electron/services/terminals.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest"
import { TerminalService } from "./terminals"

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
    // exit fires async from the pty; assert no *new* synchronous delivery after unsubscribe
    expect(events.length).toBe(before)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run electron/services/terminals.test.ts`
Expected: FAIL — `svc.onEvent is not a function`.

- [ ] **Step 3: Add the hook**

In `electron/services/terminals.ts`, add the event type near the top exports (after the `TerminalActivity` interface):

```ts
export type TerminalEvent =
  | { type: "created"; info: TerminalInfo }
  | { type: "state"; id: string; state: "active" | "idle" | "dead" }
  | { type: "exit"; id: string }
```

Inside the `TerminalService` class, add a listener set and helpers (place near the other private fields / `setMainWindow`):

```ts
  private eventListeners = new Set<(e: TerminalEvent) => void>()

  /** Subscribe to in-process terminal lifecycle events. Returns an unsubscribe fn. */
  onEvent(cb: (e: TerminalEvent) => void): () => void {
    this.eventListeners.add(cb)
    return () => this.eventListeners.delete(cb)
  }

  private emitEvent(e: TerminalEvent): void {
    for (const cb of this.eventListeners) cb(e)
  }
```

Then emit alongside each existing renderer send. At the `create` end (right after `this.sendToRenderer("session:created", info)`, line ~206):

```ts
    this.sendToRenderer("session:created", info)
    this.emitEvent({ type: "created", info })
```

At each `session:state` send (the idle monitor at line ~92, the `markActive` flip at line ~103, and `waitForIdle` at line ~319 if it sends one) add immediately after the send:

```ts
    this.emitEvent({ type: "state", id, state })
```

(Use the same `id`/`state` variable in scope at each site.)

At the `session:exit` send (line ~131) add after it:

```ts
    this.emitEvent({ type: "exit", id })
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run electron/services/terminals.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/terminals.ts electron/services/terminals.test.ts
git commit -m "feat(terminals): add in-process onEvent hook for container reconciliation"
```

---

### Task 2: Container ⟷ terminal reconciliation

**Files:**
- Modify: `electron/services/sessions.ts` (`TerminalLike`, `attachTerminals`, `setMainWindow`, reconcile + emit)
- Test: `electron/services/sessions.test.ts`

`SessionService` subscribes to terminal events and folds them into its persisted refs: a `state` event updates the matching ref's `lastState`; an `exit` marks it `dead`; session `status` becomes `active` if any ref is live (`active`/`idle`), else `stopped`. Each reconciliation persists and emits `worksession:updated`.

- [ ] **Step 1: Write the failing tests**

Add to `electron/services/sessions.test.ts`:

```ts
// Minimal fake of the slice of TerminalService the container uses.
class FakeTerminals {
  private n = 0
  killed: string[] = []
  written: Array<{ id: string; data: string }> = []
  private cb: ((e: any) => void) | null = null
  create(name?: string, cwd?: string) {
    const id = `live-${++this.n}`
    return { id, name: name ?? id, cwd: cwd ?? "/", state: "active" as const }
  }
  kill(id: string) { this.killed.push(id); return true }
  write(id: string, data: string) { this.written.push({ id, data }) }
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: FAIL — `svc.attachTerminals is not a function`.

- [ ] **Step 3: Implement**

In `electron/services/sessions.ts`, add the imported-shape interface near the top (after the existing interfaces):

```ts
/** The slice of TerminalService the container drives. */
export interface TerminalLike {
  create(name?: string, cwd?: string): { id: string; name: string; cwd: string; state: string }
  kill(id: string): boolean
  write(id: string, data: string): void
  onEvent(cb: (e: { type: "created" | "state" | "exit"; id?: string; state?: "active" | "idle" | "dead"; info?: { id: string } }) => void): () => void
}

interface MainWinLike {
  webContents: { send: (channel: string, ...args: unknown[]) => void }
  isDestroyed(): boolean
}
```

Add fields + setters to the class (near the existing private fields):

```ts
  private terminals?: TerminalLike
  private mainWin: MainWinLike | null = null

  attachTerminals(terminals: TerminalLike): void {
    this.terminals = terminals
    terminals.onEvent((e) => {
      if (e.type === "state" && e.id && e.state) this.reconcile(e.id, e.state)
      else if (e.type === "exit" && e.id) this.reconcile(e.id, "dead")
    })
  }

  setMainWindow(win: MainWinLike): void { this.mainWin = win }

  private emit(channel: string, ...args: unknown[]): void {
    if (this.mainWin && !this.mainWin.isDestroyed()) this.mainWin.webContents.send(channel, ...args)
  }

  /** Find the session owning a live terminal id. */
  private sessionOf(terminalId: string): WorkSession | undefined {
    return [...this.sessions.values()].find((s) => s.terminals.some((t) => t.id === terminalId))
  }

  /** Fold a live terminal's state into its ref + recompute session status; persist + emit. */
  private reconcile(terminalId: string, state: "active" | "idle" | "dead"): void {
    const s = this.sessionOf(terminalId)
    if (!s) return
    const t = s.terminals.find((x) => x.id === terminalId)
    if (!t) return
    t.lastState = state
    s.status = s.terminals.some((x) => x.lastState === "active" || x.lastState === "idle") ? "active" : "stopped"
    this.persist(s)
    this.emit("worksession:updated", s)
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: PASS (all prior + 2 new).

- [ ] **Step 5: Commit**

```bash
git add electron/services/sessions.ts electron/services/sessions.test.ts
git commit -m "feat(sessions): reconcile live terminal state into container refs + status"
```

---

### Task 3: Spawn orchestration (`openSession`/`addTerminalToSession`/`closeTerminal`/`killSession`/`reopenTerminal`)

**Files:**
- Modify: `electron/services/sessions.ts`
- Test: `electron/services/sessions.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `electron/services/sessions.test.ts` (reuses `FakeTerminals`):

```ts
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
```

Add `existsSync` to the test file's `fs` import if not already present (it is — line 2 imports `existsSync`).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: FAIL — orchestration methods undefined.

- [ ] **Step 3: Implement**

In `electron/services/sessions.ts` add an `unlinkSync` import and the methods. Update the fs import line:

```ts
import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "fs"
```

Add the methods to the class (after the orchestration setters from Task 2):

```ts
  /** Create a session + spawn & register its first terminal. */
  openSession(cwd?: string): { session: WorkSession; terminalId: string } {
    const session = this.create()
    const terminalId = this.spawnInto(session, cwd)
    return { session, terminalId }
  }

  /** Spawn & register an additional terminal in an existing session. */
  addTerminalToSession(sessionId: string, cwd?: string): { terminalId: string } | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    const terminalId = this.spawnInto(s, cwd)
    return { terminalId }
  }

  /** Shared spawn path: create PTY, register a ref, seed it, persist + emit. */
  private spawnInto(s: WorkSession, cwd?: string): string {
    if (!this.terminals) throw new Error("terminals not attached")
    const info = this.terminals.create(undefined, cwd)
    s.terminals.push({ id: info.id, name: info.name, cwd: info.cwd, lastState: "active" })
    s.status = "active"
    this.persist(s)
    this.emit("worksession:updated", s)
    this.seedTerminal(s, info.id)
    return info.id
  }

  /** Close a terminal: kill its PTY, drop the ref, keep the session alive (empty-but-live). */
  closeTerminal(sessionId: string, terminalId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    this.terminals?.kill(terminalId)
    s.terminals = s.terminals.filter((t) => t.id !== terminalId)
    s.status = s.terminals.some((t) => t.lastState === "active" || t.lastState === "idle") ? "active" : "stopped"
    this.persist(s)
    this.emit("worksession:updated", s)
  }

  /** Kill the whole session: every PTY + the on-disk record. */
  killSession(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    for (const t of s.terminals) this.terminals?.kill(t.id)
    this.sessions.delete(sessionId)
    try { unlinkSync(join(this.dir, `${sessionId}.json`)) } catch { /* already gone */ }
    this.emit("worksession:removed", sessionId)
  }

  /** Reopen a dead/stale terminal ref with a fresh primed PTY (3a: fresh, not --resume). */
  reopenTerminal(sessionId: string, terminalId: string): { terminalId: string } | undefined {
    const s = this.sessions.get(sessionId)
    if (!s || !this.terminals) return undefined
    const ref = s.terminals.find((t) => t.id === terminalId)
    if (!ref) return undefined
    const info = this.terminals.create(ref.name, ref.cwd)
    ref.id = info.id
    ref.lastState = "active"
    s.status = "active"
    this.persist(s)
    this.emit("worksession:updated", s)
    this.seedTerminal(s, info.id)
    return { terminalId: info.id }
  }
```

(`seedTerminal` is defined in Task 4; for this task add a temporary no-op so tests compile, then Task 4 replaces it:)

```ts
  private seedTerminal(_s: WorkSession, _liveId: string): void { /* implemented in Task 4 */ }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/sessions.ts electron/services/sessions.test.ts
git commit -m "feat(sessions): spawn orchestration — open/add/close/kill/reopen terminals through the container"
```

---

### Task 4: Seed-prompt hijack (native handoff)

**Files:**
- Modify: `electron/services/sessions.ts` (`buildSeedPrompt` + real `seedTerminal`)
- Test: `electron/services/sessions.test.ts`

Every spawned terminal gets a session-aware preamble written to it after a boot delay, instructing Claude to pull `get_session_context`, narrate via `set_terminal_activity`, and pin findings via `session_note`. This is what makes a fresh terminal inherit the session's knowledge.

- [ ] **Step 1: Write the failing tests**

Add to `electron/services/sessions.test.ts`:

```ts
import { vi } from "vitest" // ensure imported at top (add if missing)

describe("SessionService seed prompt", () => {
  it("buildSeedPrompt embeds the session id + the three context-engine tools", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    const seed = svc.buildSeedPrompt(s)
    expect(seed).toContain(s.id)
    expect(seed).toContain("get_session_context")
    expect(seed).toContain("set_terminal_activity")
    expect(seed).toContain("session_note")
  })

  it("seeds a freshly spawned terminal after the boot delay", () => {
    vi.useFakeTimers()
    const term = new FakeTerminals()
    const svc = new SessionService({ dir, now: () => 1000 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo")
    expect(term.written).toHaveLength(0) // not yet — waiting for boot
    vi.advanceTimersByTime(5000)
    const w = term.written.find((x) => x.id === terminalId)
    expect(w).toBeDefined()
    expect(w!.data).toContain("get_session_context")
    expect(w!.data.endsWith("\r")).toBe(true)
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: FAIL — `buildSeedPrompt` undefined / no write scheduled.

- [ ] **Step 3: Implement**

In `electron/services/sessions.ts`, add a delay constant near the top of the file (after imports):

```ts
/** How long to wait for Claude to boot before writing the seed preamble. */
const SEED_DELAY_MS = 4000
```

Replace the temporary `seedTerminal` no-op from Task 3 with:

```ts
  /** The session-aware preamble: read on entry, narrate + write on insight. */
  buildSeedPrompt(s: WorkSession): string {
    return [
      `You are a terminal in work session "${s.name}" (id: ${s.id}).`,
      `First, call get_session_context with session_id "${s.id}" to load what prior terminals discovered — root causes, gotchas, and ruled-out approaches.`,
      `As you work: call set_terminal_activity with a short present-tense phrase whenever your focus changes (e.g. "running the test suite").`,
      `Whenever you learn something a fresh terminal would otherwise re-discover, call session_note to pin it; if an earlier note was wrong, call session_note with "corrects" to set the record straight.`,
      `Then wait for my first instruction.`,
    ].join(" ")
  }

  private seedTerminal(s: WorkSession, liveId: string): void {
    if (!this.terminals) return
    const terminals = this.terminals
    const prompt = this.buildSeedPrompt(s)
    setTimeout(() => terminals.write(liveId, `${prompt}\r`), SEED_DELAY_MS)
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/sessions.ts electron/services/sessions.test.ts
git commit -m "feat(sessions): seed-prompt hijack — new terminals auto-pull session context"
```

---

### Task 5: Wire the container into ipc.ts + `worksession:*` IPC handlers

**Files:**
- Modify: `electron/ipc.ts`

- [ ] **Step 1: Attach terminals + main window**

In `electron/ipc.ts`, inside `setupIpc`, near `workSessionService.load()` (added in Plan 2), add the wiring **before** `load()` so reconciliation is live as records load:

```ts
  workSessionService.attachTerminals(sessionService)
  workSessionService.setMainWindow(win)
  workSessionService.load()
```

- [ ] **Step 2: Add the IPC handlers**

In `electron/ipc.ts`, alongside the existing `session:*` handlers (around line 141–165), add:

```ts
  ipcMain.handle("worksession:list", () => workSessionService.list())
  ipcMain.handle("worksession:open", (_e, cwd?: string) => workSessionService.openSession(cwd))
  ipcMain.handle("worksession:add-terminal", (_e, sessionId: string, cwd?: string) =>
    workSessionService.addTerminalToSession(sessionId, cwd))
  ipcMain.handle("worksession:reopen-terminal", (_e, sessionId: string, terminalId: string) =>
    workSessionService.reopenTerminal(sessionId, terminalId))
  ipcMain.handle("worksession:close-terminal", (_e, sessionId: string, terminalId: string) =>
    workSessionService.closeTerminal(sessionId, terminalId))
  ipcMain.handle("worksession:kill", (_e, sessionId: string) => workSessionService.killSession(sessionId))
  ipcMain.handle("worksession:context", (_e, sessionId: string) => workSessionService.getContext(sessionId))
```

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add electron/ipc.ts
git commit -m "feat(ipc): wire container orchestration + worksession:* handlers"
```

---

### Task 6: Preload `worksession:*` API

**Files:**
- Modify: `electron/preload.ts`

- [ ] **Step 1: Add invoke methods + event subscriptions**

In `electron/preload.ts`, in the `window.api` object (alongside the session methods, ~line 5–14), add:

```ts
  listWorkSessions: () => ipcRenderer.invoke("worksession:list"),
  openWorkSession: (cwd?: string) => ipcRenderer.invoke("worksession:open", cwd),
  addTerminal: (sessionId: string, cwd?: string) => ipcRenderer.invoke("worksession:add-terminal", sessionId, cwd),
  reopenTerminal: (sessionId: string, terminalId: string) => ipcRenderer.invoke("worksession:reopen-terminal", sessionId, terminalId),
  closeTerminal: (sessionId: string, terminalId: string) => ipcRenderer.invoke("worksession:close-terminal", sessionId, terminalId),
  killWorkSession: (sessionId: string) => ipcRenderer.invoke("worksession:kill", sessionId),
  getWorkSessionContext: (sessionId: string) => ipcRenderer.invoke("worksession:context", sessionId),
```

Add the event subscriptions (alongside the `onSession*` handlers, ~line 70–89):

```ts
  onWorkSessionUpdated: (cb: (session: any) => void) =>
    ipcRenderer.on("worksession:updated", (_e, session) => cb(session)),
  onWorkSessionRemoved: (cb: (id: string) => void) =>
    ipcRenderer.on("worksession:removed", (_e, id) => cb(id)),
```

- [ ] **Step 2: Build to verify**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add electron/preload.ts
git commit -m "feat(preload): expose worksession:* API + update events to the renderer"
```

---

### Task 7: `App.tsx` two-tier state + boot load (no auto-spawn)

**Files:**
- Modify: `src/App.tsx`

This converts the renderer from a flat `Session[]` to `WorkSession[]` (each with `terminals: Terminal[]`), tracks `activeSessionId` + `activeTerminalId`, loads records on boot **without spawning**, and reconciles `worksession:updated`/`removed`. Terminal xterm output still flows on the existing `session:*` channels keyed by live terminal id.

- [ ] **Step 1: Replace the types**

In `src/App.tsx`, replace the `Session` interface (lines 75–80) with:

```ts
interface Terminal {
  id: string
  name: string
  cwd: string
  lastState: "active" | "idle" | "dead"
  activity?: string
}

interface WorkSession {
  id: string
  name: string
  status: "active" | "stopped"
  summary: string
  terminals: Terminal[]
}
```

- [ ] **Step 2: Replace the state**

Replace the `sessions`/`activeId` state (lines 83–86 area) with:

```ts
  const [sessions, setSessions] = useState<WorkSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null)
```

Keep `splitLeft`/`splitRight` (now terminal ids within the active session).

Add a derived helper right after the state declarations:

```ts
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null
  const activeTerminals = activeSession?.terminals ?? []
```

- [ ] **Step 3: Boot load (no spawn)**

Replace the initial session-load effect with one that pulls records only:

```ts
  useEffect(() => {
    window.api.listWorkSessions().then((list: WorkSession[]) => {
      setSessions(list)
      if (list.length) {
        setActiveSessionId(list[0].id)
        setActiveTerminalId(list[0].terminals[0]?.id ?? null)
      }
    })
  }, [])
```

- [ ] **Step 4: Replace event wiring**

In the mount-time event `useEffect`, replace the `onSessionCreated`/`onSessionExit` handlers (which assumed flat sessions) with container-tier reconciliation, and keep `onSessionState`/`onSessionData`/`onSplitSet`/`onSplitClose` for the terminal tier:

```ts
    window.api.onWorkSessionUpdated((updated: WorkSession) => {
      setSessions((prev) => {
        const i = prev.findIndex((s) => s.id === updated.id)
        if (i === -1) return [...prev, updated]
        const next = [...prev]
        next[i] = updated
        return next
      })
      setActiveSessionId((cur) => cur ?? updated.id)
      setActiveTerminalId((cur) => cur ?? updated.terminals[updated.terminals.length - 1]?.id ?? null)
    })
    window.api.onWorkSessionRemoved((id: string) => {
      setSessions((prev) => prev.filter((s) => s.id !== id))
      setActiveSessionId((cur) => (cur === id ? null : cur))
    })
```

Update the cleanup block to `removeAllListeners("worksession:updated")` and `removeAllListeners("worksession:removed")`, and drop the now-unused `session:created`/`session:exit`/`session:renamed` listeners + their cleanups (the container owns membership now). Keep `session:state` removal only if you still subscribe to it; the container already reconciles state, so you may drop the renderer's `onSessionState` too. Keep `session:data` wiring (it lives in `TerminalPane`, not here).

- [ ] **Step 5: Update handlers**

Replace the session lifecycle handlers (lines 274–321 area):

```ts
  const handleNewSession = () => { window.api.openWorkSession("") }
  const handleNewTerminal = () => {
    if (activeSessionId) window.api.addTerminal(activeSessionId, "")
    else window.api.openWorkSession("")
  }
  const handleCloseTerminal = () => {
    if (activeSessionId && activeTerminalId) window.api.closeTerminal(activeSessionId, activeTerminalId)
  }
  const handleKillSession = () => {
    if (!activeSessionId) return
    if (window.confirm("Kill this session and all its terminals? This deletes its record.")) {
      window.api.killWorkSession(activeSessionId)
    }
  }
  const handleSelectSession = (id: string) => {
    setActiveSessionId(id)
    const s = sessions.find((x) => x.id === id)
    setActiveTerminalId(s?.terminals[0]?.id ?? null)
  }
  const handleSelectTerminal = (sessionId: string, terminalId: string) => {
    setActiveSessionId(sessionId)
    const s = sessions.find((x) => x.id === sessionId)
    const ref = s?.terminals.find((t) => t.id === terminalId)
    if (ref && ref.lastState === "dead") {
      window.api.reopenTerminal(sessionId, terminalId) // 3a: fresh primed reopen
    } else {
      setActiveTerminalId(terminalId)
    }
  }
```

- [ ] **Step 6: Build to verify it compiles**

Run: `npm run build`
Expected: exit 0. (Sidebar/TabBar prop mismatches are fixed in Tasks 8–9; if the build flags them, proceed to those tasks and re-build at Task 10. To keep this task self-contained, temporarily pass the existing props shape and resolve in 8–9.)

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "feat(app): two-tier session/terminal state, boot loads records with no auto-spawn"
```

---

### Task 8: Sidebar two-level tree

**Files:**
- Modify: `src/components/Sidebar.tsx`, `src/App.css`

- [ ] **Step 1: Rework the props + render**

Replace the `Props` interface and sessions section in `src/components/Sidebar.tsx`:

```tsx
interface TerminalRow { id: string; name: string; lastState: string; activity?: string }
interface SessionRow { id: string; name: string; status: string; terminals: TerminalRow[] }

interface Props {
  sessions: SessionRow[]
  activeSessionId: string | null
  activeTerminalId: string | null
  workspaces: Array<{ name: string }>
  onNewSession: () => void
  onKillSession: () => void
  onSelectSession: (id: string) => void
  onSelectTerminal: (sessionId: string, terminalId: string) => void
  onSelectWorkspace?: (index: number) => void
}
```

Derive the aggregate dot + label and render the tree. Replace the sessions `.map` with:

```tsx
{sessions.map((s) => {
  const working = s.terminals.filter((t) => t.lastState === "active").length
  const dot = s.status === "stopped" ? "dead" : working > 0 ? "active" : "idle"
  const label =
    s.terminals.length === 0 ? "Empty"
    : s.status === "stopped" ? "Stopped"
    : working > 0 ? `${working} Terminal${working === 1 ? "" : "s"} Working`
    : "Idle"
  const expandable = s.terminals.length >= 2
  const [busy] = [...s.terminals].sort((a, b) => (b.lastState === "active" ? 1 : 0) - (a.lastState === "active" ? 1 : 0))
  return (
    <div key={s.id} className="session-group">
      <div
        className={`session-item ${activeSessionId === s.id ? "active" : ""}`}
        onClick={() => onSelectSession(s.id)}
      >
        {expandable && <span className="tree-caret">▾</span>}
        <span className={`status-dot ${dot}`} />
        <span className="session-name">{s.name}</span>
        <span className="session-label">{label}</span>
      </div>
      {!expandable && busy?.activity && s.status !== "stopped" && (
        <div className="activity-line">{busy.activity}</div>
      )}
      {expandable && s.terminals.map((t) => (
        <div
          key={t.id}
          className={`terminal-item ${activeTerminalId === t.id ? "active" : ""}`}
          onClick={(e) => { e.stopPropagation(); onSelectTerminal(s.id, t.id) }}
        >
          <span className={`status-dot ${t.lastState}`} />
          <span className="terminal-name">{t.name}</span>
          <span className="activity-inline">{t.lastState === "active" ? (t.activity ?? "") : "Idle"}</span>
        </div>
      ))}
    </div>
  )
})}
```

- [ ] **Step 2: Add styles**

In `src/App.css`, after the `.session-item` block (~line 234), add:

```css
.session-group { display: flex; flex-direction: column; }
.tree-caret { color: var(--text-3); font-size: 10px; width: 10px; }
.session-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-label { color: var(--text-3); font-size: 11px; margin-left: auto; }
.activity-line { color: var(--text-3); font-size: 11px; padding: 2px 0 4px 26px; font-style: italic; }
.terminal-item { display: flex; align-items: center; gap: var(--s-2); padding: 4px 8px 4px 24px; border-radius: var(--r-sm); cursor: pointer; transition: background var(--fast) var(--ease); }
.terminal-item:hover { background: var(--bg-4); }
.terminal-item.active { background: var(--bg-5); }
.terminal-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.activity-inline { color: var(--text-3); font-size: 10px; font-style: italic; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 3: Pass the new props from App.tsx**

In `src/App.tsx` where `<Sidebar … />` renders, pass:

```tsx
<Sidebar
  sessions={sessions}
  activeSessionId={activeSessionId}
  activeTerminalId={activeTerminalId}
  workspaces={workspaces}
  onNewSession={handleNewSession}
  onKillSession={handleKillSession}
  onSelectSession={handleSelectSession}
  onSelectTerminal={handleSelectTerminal}
  onSelectWorkspace={(i) => window.api.activateWorkspace(i)}
/>
```

- [ ] **Step 4: Build to verify**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar.tsx src/App.css src/App.tsx
git commit -m "feat(sidebar): two-level session tree with aggregate status + activity line"
```

---

### Task 9: TabBar = active session's terminals

**Files:**
- Modify: `src/components/TabBar.tsx`, `src/App.tsx`

- [ ] **Step 1: Rework TabBar props/render**

Replace `src/components/TabBar.tsx` props + map so tabs reflect the active session's terminals:

```tsx
interface Props {
  terminals: Array<{ id: string; name: string; lastState: string }>
  activeTerminalId: string | null
  splitId: string | null
  onSelectTerminal: (id: string) => void
  onCloseTerminal: (id: string) => void
  onRenameTerminal: (id: string, newName: string) => void
}
```

Update the `.map` to iterate `terminals`, keying/labelling by terminal, using `activeTerminalId` for the `active` class and `onSelectTerminal`/`onCloseTerminal` for clicks. (Rename still uses double-click → input → `onRenameTerminal`.)

- [ ] **Step 2: Wire from App.tsx**

Replace the `<TabBar … />` usage:

```tsx
<TabBar
  terminals={activeTerminals}
  activeTerminalId={activeTerminalId}
  splitId={splitRight}
  onSelectTerminal={(id) => setActiveTerminalId(id)}
  onCloseTerminal={(id) => activeSessionId && window.api.closeTerminal(activeSessionId, id)}
  onRenameTerminal={(id, name) => window.api.renameSession(id, name)}
/>
```

(`renameSession` is the existing terminal-tier rename — unchanged; it renames the live PTY/ref label.)

- [ ] **Step 3: Point the terminal panes at the active terminal**

Where the main area renders `<TerminalPane sessionId={activeId} … />` / `<SplitView … />`, replace `activeId` with `activeTerminalId` and render one `TerminalPane` per terminal in `activeTerminals` (so panes persist across tab switches), each `active={t.id === activeTerminalId}`:

```tsx
{activeTerminals.map((t) => (
  <TerminalPane
    key={t.id}
    sessionId={t.id}
    active={t.id === activeTerminalId}
    theme={config?.theme}
    fontFamily={config?.theme?.fontFamily}
    fontSize={config?.theme?.fontSize}
  />
))}
```

(Split view keeps using `splitLeft`/`splitRight` as terminal ids.)

- [ ] **Step 4: Build to verify**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/TabBar.tsx src/App.tsx
git commit -m "feat(tabbar): scope tabs to the active session's terminals"
```

---

### Task 10: Two-tier keymap

**Files:**
- Modify: `src/App.tsx` (the keydown handler, ~lines 433–514)

- [ ] **Step 1: Update the shortcut handler**

In the capture-phase keydown handler, set the two tiers. Replace the session-related branches:

```ts
    // Ctrl+N — new session
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
      e.preventDefault(); e.stopPropagation(); handleNewSession(); return
    }
    // Ctrl+T — new terminal in the active session (or a new session if none)
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "t") {
      e.preventDefault(); e.stopPropagation(); handleNewTerminal(); return
    }
    // Ctrl+W — close the active terminal (session stays alive if it was the last)
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "w") {
      e.preventDefault(); e.stopPropagation(); handleCloseTerminal(); return
    }
    // Ctrl+K — kill the active session (confirm)
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault(); e.stopPropagation(); handleKillSession(); return
    }
    // Ctrl+1–9 — switch session
    if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault(); e.stopPropagation()
      const s = sessions[Number(e.key) - 1]
      if (s) handleSelectSession(s.id)
      return
    }
    // Alt+1–9 — switch terminal within the active session
    if (e.altKey && !e.ctrlKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault(); e.stopPropagation()
      const t = activeTerminals[Number(e.key) - 1]
      if (t) setActiveTerminalId(t.id)
      return
    }
    // Ctrl+Tab / Ctrl+Shift+Tab — cycle terminals within the active session
    if (e.ctrlKey && e.key === "Tab") {
      e.preventDefault(); e.stopPropagation()
      if (activeTerminals.length) {
        const i = Math.max(0, activeTerminals.findIndex((t) => t.id === activeTerminalId))
        const next = e.shiftKey
          ? (i - 1 + activeTerminals.length) % activeTerminals.length
          : (i + 1) % activeTerminals.length
        setActiveTerminalId(activeTerminals[next].id)
      }
      return
    }
```

Remove the old `Ctrl+H` handoff branch (deferred to 3b) and the old flat `Ctrl+1–9` switch. Keep the panel/palette/drawer/zen/help/escape branches unchanged.

- [ ] **Step 2: Update the effect dependency array**

Ensure the keydown `useEffect` deps include `sessions`, `activeSessionId`, `activeTerminalId`, `activeTerminals` (or use refs as the existing code does for `activeId`). Mirror the existing pattern — if the current handler reads via a ref to avoid stale closures, add `activeTerminalsRef`/`sessionsRef` synced by their own effects.

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat(app): two-tier keymap (Ctrl+N/T/W/K session+terminal, Alt+1-9, Ctrl+Tab)"
```

---

### Task 11: Build, screenshot E2E, and manual verification

**Files:** none (verification)

- [ ] **Step 1: Full build + unit suite**

Run: `npx vitest run && npm run build`
Expected: all tests PASS, build exit 0.

- [ ] **Step 2: Launch + drive the two-tier flow**

Run (background): `npm run dev`. After `MCP server running on port <N>`:

1. Window shows the sidebar with **no terminals spawned** if prior session records exist on disk (verify: no `claude` processes at boot beyond what you click).
2. Press `Ctrl+N` → a new session appears with one terminal; xterm boots; after ~4s the seed preamble is auto-typed and Claude calls `get_session_context`.
3. Press `Ctrl+T` → a second terminal joins the session; the sidebar row gains an expand caret showing both terminals; the tab bar shows two tabs.
4. `Alt+2` / `Ctrl+Tab` → switches terminals; `Ctrl+2` → switches sessions.
5. `Ctrl+W` on the last terminal → session stays in the tree (empty-but-live, "Empty"/"Stopped"); `Ctrl+K` → confirm dialog → session disappears.
6. Use `take_screenshot` (MCP) to capture the tree + tabs for a visual check.

- [ ] **Step 3: Durability + lazy spawn**

Restart the app. Confirm: sidebar renders prior sessions/terminals from disk, **zero** PTYs spawn until you click a terminal; clicking a dead terminal reopens a fresh primed PTY (it pulls `get_session_context` on boot).

- [ ] **Step 4: Commit any fixes**

If verification surfaced issues, fix + commit with a `fix(...)` message. Otherwise nothing to commit.

---

## Self-Review

**1. Spec coverage (Plan 3a slice):** Two-level sidebar tree (§Navigation) ✓; tabbar = session's terminals ✓; lazy spawn / no auto-spawn at boot (§Persistence) ✓; empty-but-live + Ctrl+W/Ctrl+K (§Lifecycle) ✓; seed-prompt hijack / native handoff (§Context Engine, §Implicit Handoffs) ✓; status model dots + activity line A-self-report (§Status Model) ✓; keymap (§Keymap) ✓. Deferred to 3b (explicitly): `--resume`/`ccConversationId`, idle-flush summary, Overview panel + observer seam UI, parsed-fallback activity, Ctrl+H — all listed in Scope.

**2. Placeholder scan:** Service/IPC/preload tasks contain complete code + exact commands. UI tasks contain real JSX/CSS. The one deliberately deferred body is `seedTerminal` in Task 3 (temporary no-op) which Task 4 replaces — sequenced, not a placeholder.

**3. Type consistency:** `TerminalLike` (sessions.ts) matches `TerminalService`'s real signatures (`create(name?, cwd?)`, `kill(id)`, `write(id, data)`, `onEvent(cb)`) verified against the service. `TerminalRef.id` == live PTY id invariant is stated and upheld by `spawnInto`/`reopenTerminal`. Renderer `WorkSession`/`Terminal` types mirror the persisted `WorkSession`/`TerminalRef` shapes (status `"active"|"stopped"`, lastState `"active"|"idle"|"dead"`). `worksession:updated` payload is the full `WorkSession`, consumed identically in preload + App.tsx.

**4. Risk note:** The xterm transport stays on the proven `session:*` channels keyed by live terminal id — Plan 3a adds the container tier without disturbing PTY I/O, limiting blast radius. The App.tsx rework is the largest single task; Tasks 7–10 each end in a green build so regressions surface immediately.
