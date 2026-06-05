# Sessions-as-Containers 3b — Resume Fidelity, Idle-Flush, Overview & Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add resume fidelity (Claude Code `--resume` reattach), automatic idle-flush summaries, a parsed activity fallback, a Session Overview panel with the observer seam, the sidebar restructure (drop the caret/dropdown — terminals show only for the selected session), and the `Ctrl+H` retire-&-continue handoff — completing the sessions-as-containers spec.

**Architecture:** Builds directly on the two-tier model already shipped (3a): `TerminalService` (runtime PTYs) + `SessionService` (durable containers in `~/.claude-tui/sessions/<id>.json`). New work is split cleanly: backend logic lands in the two services (DI'd, unit-tested with vitest); the Overview panel and sidebar restructure are renderer changes following the existing `Service → IPC → Preload → Renderer` pattern. The MCP context-engine tools (`session_note`, `get_session_context`, `set_terminal_activity`, `set_session_summary`) already exist and are identity-bound per connection — this plan consumes them, it does not redefine them.

**Tech Stack:** Electron + electron-vite, React 19 + TypeScript, xterm.js, node-pty, @modelcontextprotocol/sdk (SSE), vitest 4.1.8.

**Verification commands (used throughout):**
- Typecheck: `npx tsc --noEmit -p tsconfig.json`
- Unit tests: `npx vitest run`
- Build: `npm run build`

---

## File Structure

**Modified files:**
- `electron/services/terminals.ts` — add cwd→project-dir encoding, transcript-id resolution, a `convo` event, `--resume` spawn support, and expose `write`/`getOutput` to the container via the `TerminalLike` interface.
- `electron/services/sessions.ts` — record `ccConversationId`; idle-flush orchestration (debounced, dirty-gated); parsed-activity fallback; structured context getter; `handoffTerminal`; resume-aware `reopenTerminal`.
- `electron/services/sessions.test.ts` — unit tests for every new `SessionService` behavior.
- `electron/services/terminals.test.ts` — NEW: unit tests for the pure helpers (cwd encoder, transcript resolver, resume-args decision, activity-line parser).
- `electron/ipc.ts` — one new handler: `worksession:overview` (structured context) and `worksession:handoff`.
- `electron/preload.ts` — expose `getSessionOverview`, `handoffTerminal`.
- `src/App.tsx` — open the Overview panel; `Ctrl+H` handoff; sidebar/terminal selection changes; pass terminal-reveal model to `Sidebar`.
- `src/components/Sidebar.tsx` — restructure: no caret/dropdown; the selected session expands to show its terminals inline.
- `src/components/panels/SessionOverviewPanel.tsx` — NEW: the bird's-eye panel.
- `src/components/PanelDrawer.tsx` — route the new `session-overview` panel type.
- `src/App.css` — styles for the restructured sidebar + overview panel.
- `CLAUDE.md` + `electron/mcp/server.ts` (`SERVER_INSTRUCTIONS`) — document the idle-flush behavior and the resume model.

**New durable field:** `TerminalRef.ccConversationId` already exists in the type (sessions.ts:9) but is never written — Task 1/2 make it real.

---

## Task 1: Capture Claude Code's conversation id (resume foundation)

**Why:** `--resume <id>` reattaches a terminal to its real Claude Code chat. CC writes each conversation to `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. We resolve the newest transcript created after a terminal spawns and record its uuid on the `TerminalRef`.

**Files:**
- Create: `electron/services/terminals.test.ts`
- Modify: `electron/services/terminals.ts`

- [ ] **Step 1: Write the failing test for the cwd→project-dir encoder**

Create `electron/services/terminals.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { encodeProjectDir } from "./terminals"

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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run electron/services/terminals.test.ts`
Expected: FAIL — `encodeProjectDir` is not exported.

- [ ] **Step 3: Implement and export `encodeProjectDir`**

In `electron/services/terminals.ts`, add near the top (after the imports, before the class):

```ts
/**
 * Encode an absolute cwd into the directory name Claude Code uses under
 * ~/.claude/projects/. CC replaces every path separator and the drive colon
 * with "-": "C:\\Users\\ryguy\\app" -> "C--Users-ryguy-app".
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[:\\/]/g, "-")
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run electron/services/terminals.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing test for the transcript resolver**

Append to `electron/services/terminals.test.ts`:

```ts
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

    // An old transcript (before spawn) and a new one (after spawn).
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
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run electron/services/terminals.test.ts`
Expected: FAIL — `resolveTranscriptId` is not exported.

- [ ] **Step 7: Implement `resolveTranscriptId`**

In `electron/services/terminals.ts`, update the fs import to include `readdirSync` and `statSync`:

```ts
import { existsSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs"
```

Add after `encodeProjectDir`:

```ts
/**
 * Resolve the Claude Code conversation id for a terminal by finding the newest
 * transcript .jsonl in ~/.claude/projects/<encoded-cwd>/ whose mtime is at or
 * after the terminal's spawn time (minus a small skew). Returns the uuid (file
 * basename) or undefined if CC hasn't written one yet.
 *
 * `projectsRoot` is injectable for tests; production passes
 * join(homedir(), ".claude", "projects").
 */
export function resolveTranscriptId(
  projectsRoot: string,
  cwd: string,
  spawnedAt: number,
): string | undefined {
  const dir = join(projectsRoot, encodeProjectDir(cwd))
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return undefined
  }
  const skewMs = 2000
  let best: { id: string; mtime: number } | undefined
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue
    let mtime: number
    try {
      mtime = statSync(join(dir, f)).mtimeMs
    } catch {
      continue
    }
    if (mtime < spawnedAt - skewMs) continue
    if (!best || mtime > best.mtime) best = { id: f.slice(0, -".jsonl".length), mtime }
  }
  return best?.id
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run electron/services/terminals.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 9: Commit**

```bash
git add electron/services/terminals.ts electron/services/terminals.test.ts
git commit -m "feat(terminals): cwd->project-dir encoder + transcript-id resolver"
```

---

## Task 2: Emit the conversation id + record it on the TerminalRef

**Why:** Task 1 gives the pure resolver. Now wire it: after a terminal spawns, poll briefly for CC's transcript, then emit a `convo` event the container records onto the durable `TerminalRef.ccConversationId`.

**Files:**
- Modify: `electron/services/terminals.ts`
- Modify: `electron/services/sessions.ts`
- Modify: `electron/services/sessions.test.ts`

- [ ] **Step 1: Add the `convo` event type and a projects-root field to TerminalService**

In `electron/services/terminals.ts`, extend the event union (currently at ~line 33):

```ts
export type TerminalEvent =
  | { type: "created"; info: TerminalInfo }
  | { type: "state"; id: string; state: "active" | "idle" | "dead" }
  | { type: "exit"; id: string }
  | { type: "convo"; id: string; ccConversationId: string }
```

Add a field + setter to the class (near `mcpServerUrl`):

```ts
/** Root of Claude Code's per-project transcript store; injectable for tests. */
private ccProjectsRoot = join(homedir(), ".claude", "projects")
```

And add `homedir` to the os import:

```ts
import { tmpdir, homedir } from "os"
```

- [ ] **Step 2: Poll for the transcript id after spawn and emit `convo`**

In `electron/services/terminals.ts`, at the end of `create(...)` — right before `return info` — add:

```ts
    this.captureConversationId(id, sessionCwd, Date.now())
```

Then add the method (after `create`):

```ts
/**
 * Poll briefly for the Claude Code transcript this terminal just started
 * writing, and emit a `convo` event once found so the container can record
 * ccConversationId for --resume. Best-effort: gives up after a few seconds
 * (the durable session record, not CC internals, is the source of truth).
 */
private captureConversationId(id: string, cwd: string, spawnedAt: number): void {
  let attempts = 0
  const timer = setInterval(() => {
    attempts++
    const convoId = resolveTranscriptId(this.ccProjectsRoot, cwd, spawnedAt)
    if (convoId) {
      this.emitEvent({ type: "convo", id, ccConversationId: convoId })
      clearInterval(timer)
    } else if (attempts >= 10 || !this.sessions.has(id)) {
      clearInterval(timer)
    }
  }, 1000)
}
```

- [ ] **Step 3: Write the failing test — container records ccConversationId on `convo`**

`FakeTerminals` (in `electron/services/sessions.test.ts`, ~line 245) ALREADY has an `emit(e)` passthrough and stores its callback in `cb` — use `term.emit(...)`, NOT `fire`. The suite uses the `dir` variable from the top-level `beforeEach` (NOT a `tmpDir()` helper). Add this test (e.g. after the "SessionService reconciliation" describe block):

```ts
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
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: FAIL — ccConversationId stays undefined (no handler yet).

- [ ] **Step 5: Handle the `convo` event in SessionService**

In `electron/services/sessions.ts`, extend the `TerminalLike.onEvent` event type to include `convo`:

```ts
onEvent(cb: (e: { type: "created" | "state" | "exit" | "convo"; id?: string; state?: "active" | "idle" | "dead"; info?: { id: string }; ccConversationId?: string }) => void): () => void
```

In `attachTerminals`, extend the handler:

```ts
terminals.onEvent((e) => {
  if (e.type === "state" && e.id && e.state) this.reconcile(e.id, e.state)
  else if (e.type === "exit" && e.id) this.reconcile(e.id, "dead")
  else if (e.type === "convo" && e.id && e.ccConversationId) {
    this.recordConversationId(e.id, e.ccConversationId)
  }
})
```

Add the method (near `reconcile`):

```ts
/** Persist Claude Code's conversation id onto the terminal ref for --resume. */
private recordConversationId(terminalId: string, ccConversationId: string): void {
  const s = this.sessionOf(terminalId)
  if (!s) return
  const t = s.terminals.find((x) => x.id === terminalId)
  if (!t || t.ccConversationId === ccConversationId) return
  t.ccConversationId = ccConversationId
  this.persist(s)
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

Run: `npx tsc --noEmit -p tsconfig.json` (expect clean).

```bash
git add electron/services/terminals.ts electron/services/sessions.ts electron/services/sessions.test.ts
git commit -m "feat(sessions): record ccConversationId via terminal convo event"
```

---

## Task 3: Resume-aware spawn (`claude --resume <id>`)

**Why:** When reopening a stopped terminal that has a `ccConversationId` whose transcript still exists, reattach to the real chat. Otherwise spawn fresh (the always-works fallback). The decision is a pure function so it's unit-testable.

**Files:**
- Modify: `electron/services/terminals.ts`
- Modify: `electron/services/terminals.test.ts`
- Modify: `electron/services/sessions.ts`
- Modify: `electron/services/sessions.test.ts`

- [ ] **Step 1: Write the failing test for the resume-args decision**

Append to `electron/services/terminals.test.ts`:

```ts
import { resumeArgs } from "./terminals"

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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run electron/services/terminals.test.ts`
Expected: FAIL — `resumeArgs` is not exported.

- [ ] **Step 3: Implement `resumeArgs`**

In `electron/services/terminals.ts`, add after `resolveTranscriptId`:

```ts
/**
 * The extra CLI args to reattach a terminal to its prior Claude Code chat:
 * ["--resume", id] when we have an id AND its transcript still exists on disk,
 * otherwise [] (spawn fresh — the always-works fallback).
 */
export function resumeArgs(
  projectsRoot: string,
  cwd: string,
  ccConversationId: string | undefined,
): string[] {
  if (!ccConversationId) return []
  const file = join(projectsRoot, encodeProjectDir(cwd), `${ccConversationId}.jsonl`)
  return existsSync(file) ? ["--resume", ccConversationId] : []
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run electron/services/terminals.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Thread a resume id through `create`**

In `electron/services/terminals.ts`, change the `create` signature to accept an optional resume id:

```ts
create(name?: string, cwd?: string, sessionId?: string, resumeConvId?: string): TerminalInfo {
```

Inside `create`, after `const args = [...this.defaultArgs]` and before the mcp-config block, insert the resume args:

```ts
    const args = [...this.defaultArgs]
    for (const a of resumeArgs(this.ccProjectsRoot, sessionCwd, resumeConvId)) args.push(a)
```

(Leave the existing `--mcp-config` push right after.)

Update the `TerminalLike` interface in `electron/services/sessions.ts` to match:

```ts
create(name?: string, cwd?: string, sessionId?: string, resumeConvId?: string): { id: string; name: string; cwd: string; state: string }
```

- [ ] **Step 6: Write the failing test — reopenTerminal passes the stored ccConversationId**

In `electron/services/sessions.test.ts`, make `FakeTerminals.create` accept a 4th arg `resumeConvId` and capture it (extend the `spawned` array element type to `{ id; name?; cwd?; sessionId?; resumeConvId? }` and push it). Use the existing `dir` variable from `beforeEach` and `term.emit(...)` (the fake already has `emit`, not `fire`). Drive the dead-ref via the app-restart path (`emit` an `exit`, which `reconcile` folds to `dead` while KEEPING the ref) — NOT `closeTerminal` (which intentionally drops the ref to create an empty-but-live session). Then add:

```ts
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
```

> **Do NOT change `closeTerminal`.** Resume fidelity flows through the app-restart path: `load()` reads dead refs (with their persisted `ccConversationId`) from disk, and clicking one calls `reopenTerminal`. `closeTerminal` (Ctrl+W) deliberately drops the ref to form the empty-but-live session — that invariant and its test stay intact.

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: FAIL — `reopenTerminal` doesn't pass a resume id yet.

- [ ] **Step 8: Make `reopenTerminal` resume-aware**

In `electron/services/sessions.ts`, update `reopenTerminal` to forward the stored id:

```ts
reopenTerminal(sessionId: string, terminalId: string): { terminalId: string } | undefined {
  const s = this.sessions.get(sessionId)
  if (!s || !this.terminals) return undefined
  const ref = s.terminals.find((t) => t.id === terminalId)
  if (!ref) return undefined
  const info = this.terminals.create(ref.name, ref.cwd, s.id, ref.ccConversationId)
  ref.id = info.id
  ref.lastState = "active"
  s.status = "active"
  this.persist(s)
  this.emit("worksession:updated", s)
  return { terminalId: info.id }
}
```

If Step 6's note applies, also change `closeTerminal` so it marks the ref `dead` rather than removing it:

```ts
closeTerminal(sessionId: string, terminalId: string): void {
  const s = this.sessions.get(sessionId)
  if (!s) return
  this.terminals?.kill(terminalId)
  const t = s.terminals.find((x) => x.id === terminalId)
  if (t) t.lastState = "dead"
  s.status = s.terminals.some((x) => x.lastState === "active" || x.lastState === "idle") ? "active" : "stopped"
  this.persist(s)
  this.emit("worksession:updated", s)
}
```

- [ ] **Step 9: Run the tests + typecheck**

Run: `npx vitest run` (expect all pass) then `npx tsc --noEmit -p tsconfig.json` (clean).

- [ ] **Step 10: Commit**

```bash
git add electron/services/terminals.ts electron/services/terminals.test.ts electron/services/sessions.ts electron/services/sessions.test.ts
git commit -m "feat(sessions): resume-aware reopen via claude --resume <id>"
```

---

## Task 4: Idle-flush summary (debounced, dirty-gated)

**Why:** When a terminal finishes a chunk of work (goes idle) and has accumulated new notes since the last summary refresh, that same terminal's Claude should fold them into the running summary. We trigger it by injecting a short prompt — but only when it's safe and worthwhile (debounced, and only if notes are "dirty").

**Design decision (the safe trigger):** auto-injecting on *every* idle would race with the user typing and burn a turn each time. Instead: mark a session "summary-dirty" whenever `addNote` fires; on a terminal's `active → idle` transition, start a grace timer; if still idle after `idleFlushGraceMs` AND the session is dirty AND we haven't flushed within `idleFlushMinIntervalMs`, inject one summary-refresh prompt and clear the dirty flag. This is conservative by construction (no notes → no flush) and is exactly what `Ctrl+H` (Task 8) forces immediately.

**Files:**
- Modify: `electron/services/sessions.ts`
- Modify: `electron/services/sessions.test.ts`

- [ ] **Step 1: Add `write` to the TerminalLike interface**

In `electron/services/sessions.ts`, extend `TerminalLike`:

```ts
export interface TerminalLike {
  create(name?: string, cwd?: string, sessionId?: string, resumeConvId?: string): { id: string; name: string; cwd: string; state: string }
  kill(id: string): boolean
  write(id: string, data: string): void
  getOutput(id: string, maxChars?: number): string | null
  onEvent(cb: (e: { type: "created" | "state" | "exit" | "convo"; id?: string; state?: "active" | "idle" | "dead"; info?: { id: string }; ccConversationId?: string }) => void): () => void
}
```

(`TerminalService` already implements `write` and `getOutput` — this just exposes them to the container. Update `FakeTerminals` in the test to add `write(id, data) { this.writes.push({ id, data }) }` with `writes: Array<{ id: string; data: string }> = []`, and `output = new Map<string, string>()` with `getOutput(id) { return this.output.get(id) ?? null }`.)

> **MUST FIX an existing test that conflicts.** The "SessionService identity-bound spawn" test (sessions.test.ts ~line 359) currently asserts `expect("write" in term).toBe(false)` to prove no seed-paste happens. Once `FakeTerminals` gains `write`, that assertion is wrong. Replace it with an assertion that spawn itself injects nothing — change that line to:
>
> ```ts
> // spawning injects nothing (no seed-paste); write is only used by idle-flush/handoff
> expect(term.writes.length).toBe(0)
> ```
>
> Keep the rest of that test (the `sessionId` assertions) intact.

- [ ] **Step 2: Add dirty-tracking + flush config to SessionService**

In `electron/services/sessions.ts`, add fields:

```ts
/** Sessions with notes added since their last summary refresh. */
private summaryDirty = new Set<string>()
/** Last idle-flush injection time per session (debounce). */
private lastFlushAt = new Map<string, number>()
private readonly idleFlushMinIntervalMs = 60_000
```

Add an injectable grace via opts. Extend `SessionServiceOpts`:

```ts
export interface SessionServiceOpts {
  dir?: string
  now?: () => number
  idleFlushGraceMs?: number
}
```

And in the constructor:

```ts
this.idleFlushGraceMs = opts.idleFlushGraceMs ?? 8000
```

with the field `private idleFlushGraceMs: number`.

In `addNote`, after a note is pushed and before `this.persist(s)`, mark dirty:

```ts
this.summaryDirty.add(sessionId)
```

In `setSummary`, clear it:

```ts
this.summaryDirty.delete(sessionId)
```

- [ ] **Step 3: Write the failing test for the flush decision**

Idle-flush uses a real `setTimeout` grace. Inject `idleFlushGraceMs: 0` so the grace fires on the next tick, and `await` a microtask flush. Add to `electron/services/sessions.test.ts`:

```ts
const tick = () => new Promise((r) => setTimeout(r, 5))

describe("SessionService idle-flush", () => {
  it("injects a summary-refresh prompt when idle + dirty", async () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir: tmpDir(), now: () => 1, idleFlushGraceMs: 0 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo")
    svc.addNote(session.id, "found the bug") // marks dirty

    term.fire({ type: "state", id: terminalId, state: "idle" }) // active -> idle
    await tick()

    const injected = term.writes.find((w) => w.id === terminalId)
    expect(injected).toBeTruthy()
    expect(injected!.data).toContain("set_session_summary")
  })

  it("does NOT inject when there are no new notes (clean)", async () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir: tmpDir(), now: () => 1, idleFlushGraceMs: 0 })
    svc.attachTerminals(term as any)
    const { terminalId } = svc.openSession("/repo")
    term.fire({ type: "state", id: terminalId, state: "idle" })
    await tick()
    expect(term.writes.length).toBe(0)
  })
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: FAIL — no injection happens (no flush logic).

- [ ] **Step 5: Implement idle-flush in `reconcile`**

In `electron/services/sessions.ts`, in `reconcile`, after `t.lastState = state` and the status recompute, add a trigger when transitioning to idle:

```ts
if (state === "idle") this.scheduleIdleFlush(s.id, terminalId)
```

Add the method:

```ts
/**
 * After a terminal goes idle, refresh the session summary IF new notes have
 * landed since the last refresh. The terminal that did the work distills it —
 * we inject one prompt asking it to call set_session_summary. Debounced so we
 * never flush more than once per idleFlushMinIntervalMs, and gated on dirty so
 * an idle terminal with nothing new is left alone.
 */
private scheduleIdleFlush(sessionId: string, terminalId: string): void {
  setTimeout(() => {
    const s = this.sessions.get(sessionId)
    if (!s || !this.terminals) return
    const t = s.terminals.find((x) => x.id === terminalId)
    if (!t || t.lastState !== "idle") return // moved on; don't interrupt
    if (!this.summaryDirty.has(sessionId)) return
    const last = this.lastFlushAt.get(sessionId) ?? 0
    if (this.now() - last < this.idleFlushMinIntervalMs) return

    this.summaryDirty.delete(sessionId)
    this.lastFlushAt.set(sessionId, this.now())
    const prompt =
      "Before you go quiet: fold any new findings into the session summary now. " +
      "Call set_session_summary with the updated goal + current-state blurb so a " +
      "fresh terminal inherits it. Keep it concise."
    this.terminals.write(terminalId, `\x1b[200~${prompt}\x1b[201~\r`)
  }, this.idleFlushGraceMs)
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

Run: `npx tsc --noEmit -p tsconfig.json` (clean).

```bash
git add electron/services/sessions.ts electron/services/sessions.test.ts
git commit -m "feat(sessions): debounced, dirty-gated idle-flush summary refresh"
```

---

## Task 5: Parsed-activity fallback

**Why:** The rich-presence activity line is self-reported via `set_terminal_activity`. When Claude is heads-down and hasn't narrated, the line goes stale. Fall back to the latest parsed Claude Code activity line from captured output (e.g. `● Edit(sessions.ts)`) so the row never looks frozen while work is clearly happening.

**Files:**
- Modify: `electron/services/terminals.ts` (pure parser, exported)
- Modify: `electron/services/terminals.test.ts`
- Modify: `electron/services/sessions.ts` (use it in the effective-activity getter)
- Modify: `electron/services/sessions.test.ts`

- [ ] **Step 1: Write the failing test for the activity-line parser**

Append to `electron/services/terminals.test.ts`:

```ts
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
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run electron/services/terminals.test.ts`
Expected: FAIL — `parseActivityLine` is not exported.

- [ ] **Step 3: Implement `parseActivityLine`**

In `electron/services/terminals.ts`, add after `parseActivityLine`'s siblings (anywhere at module scope):

```ts
/**
 * Best-effort: pull the most recent Claude Code tool-call line ("● Edit(x)")
 * from captured (ANSI-stripped) output, returning the part after the bullet.
 * Used as the activity fallback when self-narration goes stale.
 */
export function parseActivityLine(output: string): string | undefined {
  const lines = output.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*[●○*]\s+(.+\(.+\).*)$/)
    if (m) return m[1].trim()
  }
  return undefined
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run electron/services/terminals.test.ts`
Expected: PASS (varies; all green).

- [ ] **Step 5: Write the failing test for effective-activity fallback in SessionService**

The container should prefer self-reported activity, but fall back to the parsed line when the self-report is stale (older than a threshold) while the terminal is active. Add to `electron/services/sessions.test.ts`:

```ts
describe("SessionService effective activity", () => {
  it("falls back to parsed output when self-report is stale", () => {
    const term = new FakeTerminals()
    term.output.set("__will-set__", "") // see note
    let clock = 1000
    const svc = new SessionService({ dir: tmpDir(), now: () => clock })
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
    const svc = new SessionService({ dir: tmpDir(), now: () => 5000 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo")
    svc.setTerminalActivity(session.id, terminalId, "running tests")
    expect(svc.effectiveActivity(session.id, terminalId)).toBe("running tests")
  })
})
```

> **Note:** make `FakeTerminals` hold `output = new Map<string, string>()` and `getOutput(id) { return this.output.get(id) ?? null }`.

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: FAIL — `effectiveActivity` is undefined.

- [ ] **Step 7: Implement `effectiveActivity`**

In `electron/services/sessions.ts`, import the parser at the top:

```ts
import { parseActivityLine } from "./terminals"
```

Add a field for the staleness threshold and the method:

```ts
private readonly activityStaleMs = 20_000

/**
 * The activity line to display for a terminal: the self-reported phrase when
 * it's fresh, otherwise the latest parsed CC tool-call line while the terminal
 * is still active (so a heads-down terminal never looks frozen).
 */
effectiveActivity(sessionId: string, terminalId: string): string | undefined {
  const s = this.sessions.get(sessionId)
  const t = s?.terminals.find((x) => x.id === terminalId)
  if (!t) return undefined
  const fresh = t.activity && this.now() - (t.activityAt ?? 0) < this.activityStaleMs
  if (fresh) return t.activity
  if (t.lastState === "active" && this.terminals) {
    const parsed = parseActivityLine(this.terminals.getOutput(terminalId, 4000) ?? "")
    if (parsed) return parsed
  }
  return t.activity // last-known (may be stale) if nothing parsed
}
```

- [ ] **Step 8: Surface effective activity in the worksession payload**

So the renderer gets it, enrich the emitted session. In `electron/services/sessions.ts`, add a helper that returns the session with each terminal's `activity` replaced by `effectiveActivity`, and use it in `emit("worksession:updated", ...)` calls. Add:

```ts
/** A copy of the session with each terminal's activity resolved for display. */
private withEffectiveActivity(s: WorkSession): WorkSession {
  return {
    ...s,
    terminals: s.terminals.map((t) => ({ ...t, activity: this.effectiveActivity(s.id, t.id) })),
  }
}
```

Replace the `this.emit("worksession:updated", s)` calls with `this.emit("worksession:updated", this.withEffectiveActivity(s))`. (Leave `persist(s)` writing the raw record — we only enrich the wire payload, not disk.)

- [ ] **Step 9: Run tests + typecheck**

Run: `npx vitest run` (all pass), `npx tsc --noEmit -p tsconfig.json` (clean).

- [ ] **Step 10: Commit**

```bash
git add electron/services/terminals.ts electron/services/terminals.test.ts electron/services/sessions.ts electron/services/sessions.test.ts
git commit -m "feat(sessions): parsed-output activity fallback when self-report stale"
```

---

## Task 6: Structured context getter + IPC/preload wiring for the Overview

**Why:** The Overview panel needs structured data (summary, active notes, ruled-out pairs, terminals, provisionalFindings), not the markdown string `getContext` returns. Add a structured getter and expose it over IPC.

**Files:**
- Modify: `electron/services/sessions.ts`
- Modify: `electron/services/sessions.test.ts`
- Modify: `electron/ipc.ts`
- Modify: `electron/preload.ts`

- [ ] **Step 1: Write the failing test for `getOverview`**

Add to `electron/services/sessions.test.ts`:

```ts
describe("SessionService.getOverview", () => {
  it("returns structured summary, notes, ruled-out pairs, terminals", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir: tmpDir(), now: () => 1 })
    svc.attachTerminals(term as any)
    const { session } = svc.openSession("/repo")
    svc.setSummary(session.id, "Fixing the auth race")
    const n1 = svc.addNote(session.id, "race is in spawnInto")!
    svc.addNote(session.id, "actually it's in reconcile", { corrects: n1.id })

    const ov = svc.getOverview(session.id)!
    expect(ov.summary).toBe("Fixing the auth race")
    expect(ov.notes.map((n) => n.text)).toContain("actually it's in reconcile")
    expect(ov.ruledOut[0].text).toBe("race is in spawnInto")
    expect(ov.ruledOut[0].correction).toBe("actually it's in reconcile")
    expect(ov.terminals.length).toBe(1)
    expect(ov.provisionalFindings).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: FAIL — `getOverview` is undefined.

- [ ] **Step 3: Implement `getOverview`**

In `electron/services/sessions.ts`, add an exported result type and the method:

```ts
export interface SessionOverview {
  id: string
  name: string
  status: "active" | "stopped"
  summary: string
  notes: Note[]
  ruledOut: Array<{ id: string; text: string; correction?: string }>
  provisionalFindings: Note[]
  terminals: Array<TerminalRef & { activity?: string }>
}

getOverview(sessionId: string): SessionOverview | undefined {
  const s = this.sessions.get(sessionId)
  if (!s) return undefined
  const ruledOut = s.notes
    .filter((n) => n.status === "superseded")
    .map((n) => ({
      id: n.id,
      text: n.text,
      correction: s.notes.find((c) => c.id === n.supersededBy)?.text,
    }))
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    summary: s.summary,
    notes: s.notes.filter((n) => n.status === "active"),
    ruledOut,
    provisionalFindings: s.provisionalFindings,
    terminals: s.terminals.map((t) => ({ ...t, activity: this.effectiveActivity(s.id, t.id) })),
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the IPC handler**

In `electron/ipc.ts`, next to the existing `worksession:context` handler (~line 185), add:

```ts
  ipcMain.handle("worksession:overview", (_e, sessionId: string) =>
    workSessionService.getOverview(sessionId),
  )
```

- [ ] **Step 6: Expose it in preload**

In `electron/preload.ts`, next to the worksession invokes (~line 27), add:

```ts
  getSessionOverview: (sessionId: string) =>
    ipcRenderer.invoke("worksession:overview", sessionId),
```

- [ ] **Step 7: Typecheck + commit**

Run: `npx tsc --noEmit -p tsconfig.json` (clean).

```bash
git add electron/services/sessions.ts electron/services/sessions.test.ts electron/ipc.ts electron/preload.ts
git commit -m "feat(sessions): structured getOverview + worksession:overview IPC"
```

---

## Task 7: Session Overview panel (renderer) + sidebar restructure

**Why:** Surface the accumulated knowledge (the magic-terminal cure) in a bird's-eye panel, and simplify the sidebar per the new direction: drop the caret/dropdown — the **selected** session expands inline to show its terminals; unselected sessions are single rows.

**Files:**
- Create: `src/components/panels/SessionOverviewPanel.tsx`
- Modify: `src/components/PanelDrawer.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.css`

- [ ] **Step 1: Create the Overview panel component**

Create `src/components/panels/SessionOverviewPanel.tsx`:

```tsx
import ReactMarkdown from "react-markdown"

interface RuledOut { id: string; text: string; correction?: string }
interface Note { id: string; text: string }
interface TermRow { id: string; name: string; lastState: string; activity?: string }

export interface OverviewProps {
  id: string
  name: string
  status: string
  summary: string
  notes: Note[]
  ruledOut: RuledOut[]
  provisionalFindings: Note[]
  terminals: TermRow[]
  onReopenTerminal?: (terminalId: string) => void
}

export default function SessionOverviewPanel(props: OverviewProps) {
  const { name, summary, notes, ruledOut, provisionalFindings, terminals } = props
  return (
    <div className="overview-panel">
      <h2 className="overview-title">{name}</h2>

      <section className="overview-section">
        <h3>Summary</h3>
        {summary.trim() ? (
          <ReactMarkdown>{summary}</ReactMarkdown>
        ) : (
          <div className="overview-empty">No summary yet.</div>
        )}
      </section>

      <section className="overview-section">
        <h3>Findings</h3>
        {notes.length ? (
          <ul className="overview-notes">
            {notes.map((n) => <li key={n.id}>{n.text}</li>)}
          </ul>
        ) : (
          <div className="overview-empty">No findings recorded.</div>
        )}
      </section>

      {ruledOut.length > 0 && (
        <details className="overview-section">
          <summary>Ruled out / corrected ({ruledOut.length})</summary>
          <ul className="overview-ruledout">
            {ruledOut.map((r) => (
              <li key={r.id}>
                <span className="struck">{r.text}</span>
                {r.correction && <span className="correction"> → {r.correction}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Observer seam: provisional findings get a promote/dismiss action here.
          Empty until the observer ships. */}
      {provisionalFindings.length > 0 && (
        <section className="overview-section">
          <h3>Provisional (needs validation)</h3>
          <ul className="overview-notes">
            {provisionalFindings.map((n) => (
              <li key={n.id}>
                {n.text}
                <button className="overview-mini" disabled>Promote</button>
                <button className="overview-mini" disabled>Dismiss</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="overview-section">
        <h3>Terminals</h3>
        <ul className="overview-terminals">
          {terminals.map((t) => (
            <li key={t.id}>
              <span className={`status-dot ${t.lastState}`} />
              <span className="overview-term-name">{t.name}</span>
              <span className="overview-term-activity">
                {t.lastState === "dead" ? "Stopped" : t.activity ?? "Idle"}
              </span>
              {t.lastState === "dead" && props.onReopenTerminal && (
                <button className="overview-mini" onClick={() => props.onReopenTerminal!(t.id)}>
                  Reopen
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <button className="overview-push" disabled title="Available once workspaces exist">
        Push context to workspace
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Route the panel type in PanelDrawer**

In `src/components/PanelDrawer.tsx`, import the component and add a case. Find the `PanelContent` switch and add:

```tsx
import SessionOverviewPanel from "./panels/SessionOverviewPanel"
```

```tsx
    case "session-overview":
      return <SessionOverviewPanel {...(panel.props as any)} />
```

- [ ] **Step 3: Open the Overview from App.tsx**

In `src/App.tsx`, add a callback near `openMission`:

```tsx
const openOverview = useCallback(async (sessionId: string) => {
  const ov = await window.api.getSessionOverview(sessionId)
  if (!ov) return
  const panel: PanelState = {
    id: `overview-${sessionId}`,
    type: "session-overview" as any,
    position: "right",
    props: {
      ...ov,
      onReopenTerminal: (terminalId: string) => handleSelectTerminal(sessionId, terminalId),
    },
    visible: true,
  }
  setPanels((prev) => [...prev.filter((p) => p.id !== panel.id), panel])
  setDrawerCollapsed(false)
}, [handleSelectTerminal])
```

Add `getSessionOverview` to the `Window.api` type (find the `interface` for `window.api` in App.tsx or its `.d.ts`) — add:

```ts
getSessionOverview: (sessionId: string) => Promise<any>
```

- [ ] **Step 4: Add a way to trigger it — a session-row affordance + command palette entry**

In `src/App.tsx`, add a command-palette command (find the commands array used by `CommandPalette`):

```tsx
{ id: "session-overview", label: "Show session overview", run: () => activeSessionId && openOverview(activeSessionId) },
```

- [ ] **Step 5: Restructure the Sidebar (drop caret; selected session reveals terminals)**

Replace the body of `src/components/Sidebar.tsx`'s sessions map (the `sessions.map((s) => {...})` block, lines ~48-89) with this — no caret, terminals render only for the active session, and an "overview" affordance:

```tsx
        {sessions.map((s) => {
          const working = s.terminals.filter((t) => t.lastState === "active").length
          const dot = s.status === "stopped" ? "dead" : working > 0 ? "active" : "idle"
          const label =
            s.terminals.length === 0 ? "Empty"
            : s.status === "stopped" ? "Stopped"
            : working > 0 ? `${working} Terminal${working === 1 ? "" : "s"} Working`
            : "Idle"
          const selected = activeSessionId === s.id
          const [busy] = [...s.terminals].sort(
            (a, b) => (b.lastState === "active" ? 1 : 0) - (a.lastState === "active" ? 1 : 0),
          )
          return (
            <div key={s.id} className="session-group">
              <div
                className={`session-item ${selected ? "active" : ""}`}
                onClick={() => onSelectSession(s.id)}
              >
                <span className={`status-dot ${dot}`} />
                <span className="session-name">{s.name}</span>
                <span className="session-label">{label}</span>
                <button
                  className="session-overview-btn"
                  title="Session overview"
                  onClick={(e) => { e.stopPropagation(); onShowOverview?.(s.id) }}
                >
                  ⊕
                </button>
              </div>
              {!selected && busy?.activity && s.status !== "stopped" && (
                <div className="activity-line">{busy.activity}</div>
              )}
              {selected && s.terminals.map((t) => (
                <div
                  key={t.id}
                  className={`terminal-item ${activeTerminalId === t.id ? "active" : ""}`}
                  onClick={(e) => { e.stopPropagation(); onSelectTerminal(s.id, t.id) }}
                >
                  <span className={`status-dot ${t.lastState}`} />
                  <span className="terminal-name">{t.name}</span>
                  <span className="activity-inline">
                    {t.lastState === "dead" ? "Stopped" : t.lastState === "active" ? (t.activity ?? "") : "Idle"}
                  </span>
                </div>
              ))}
            </div>
          )
        })}
```

Add `onShowOverview?: (sessionId: string) => void` to the `Props` interface and to the destructured params.

- [ ] **Step 6: Pass `onShowOverview` from App.tsx**

In `src/App.tsx`, find the `<Sidebar .../>` render and add the prop:

```tsx
onShowOverview={openOverview}
```

- [ ] **Step 7: Style the restructured sidebar + overview panel**

In `src/App.css`, add (near the existing `.session-item` / `.terminal-item` rules):

```css
.session-overview-btn {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--fg-dim, #8b949e);
  cursor: pointer;
  font-size: 13px;
  opacity: 0;
  transition: opacity 0.12s;
}
.session-item:hover .session-overview-btn { opacity: 1; }
.session-overview-btn:hover { color: var(--fg, #c9d1d9); }

.overview-panel { padding: 12px 16px; overflow-y: auto; font-size: 13px; }
.overview-title { margin: 0 0 12px; font-size: 15px; }
.overview-section { margin-bottom: 16px; }
.overview-section h3 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-dim, #8b949e); }
.overview-empty { color: var(--fg-dim, #8b949e); font-style: italic; }
.overview-notes, .overview-ruledout, .overview-terminals { margin: 0; padding-left: 18px; }
.overview-terminals { list-style: none; padding-left: 0; }
.overview-terminals li { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.overview-term-activity { color: var(--fg-dim, #8b949e); margin-left: auto; }
.overview-ruledout .struck { text-decoration: line-through; color: var(--fg-dim, #8b949e); }
.overview-ruledout .correction { color: var(--fg, #c9d1d9); }
.overview-mini { font-size: 11px; padding: 1px 6px; margin-left: 6px; }
.overview-push { margin-top: 8px; opacity: 0.6; }
```

- [ ] **Step 8: Build + verify the renderer compiles**

Run: `npx tsc --noEmit -p tsconfig.json` (clean) then `npm run build` (green).

- [ ] **Step 9: Commit**

```bash
git add src/components/panels/SessionOverviewPanel.tsx src/components/PanelDrawer.tsx src/components/Sidebar.tsx src/App.tsx src/App.css
git commit -m "feat(renderer): Session Overview panel + sidebar restructure (no dropdown)"
```

---

## Task 8: Ctrl+H — retire & continue (explicit handoff)

**Why:** One keystroke for the deliberate "start clean, lose nothing" move: force the summary current, spawn a fresh primed terminal in the same session, retire the bloated one.

**Files:**
- Modify: `electron/services/sessions.ts`
- Modify: `electron/services/sessions.test.ts`
- Modify: `electron/ipc.ts`
- Modify: `electron/preload.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write the failing test for `handoffTerminal`**

Add to `electron/services/sessions.test.ts`:

```ts
describe("SessionService.handoffTerminal", () => {
  it("spawns a fresh terminal in the same session and retires the old one", () => {
    const term = new FakeTerminals()
    const svc = new SessionService({ dir: tmpDir(), now: () => 1 })
    svc.attachTerminals(term as any)
    const { session, terminalId } = svc.openSession("/repo")

    const r = svc.handoffTerminal(session.id, terminalId)

    const s = svc.get(session.id)!
    // old retired (dead), new one present and active
    const oldRef = s.terminals.find((t) => t.id === terminalId)
    expect(oldRef?.lastState).toBe("dead")
    expect(r?.terminalId).toBeTruthy()
    expect(r!.terminalId).not.toBe(terminalId)
    expect(s.terminals.find((t) => t.id === r!.terminalId)?.lastState).toBe("active")
  })

  it("returns undefined for an unknown session", () => {
    const svc = new SessionService({ dir: tmpDir(), now: () => 1 })
    svc.attachTerminals(new FakeTerminals() as any)
    expect(svc.handoffTerminal("nope", "nope")).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: FAIL — `handoffTerminal` is undefined.

- [ ] **Step 3: Implement `handoffTerminal`**

In `electron/services/sessions.ts`:

```ts
/**
 * Retire & continue: force an immediate summary flush on the active terminal,
 * spawn a fresh primed terminal in the same session, and mark the old one dead.
 * The fresh terminal inherits everything via get_session_context on entry.
 */
handoffTerminal(sessionId: string, terminalId: string): { terminalId: string } | undefined {
  const s = this.sessions.get(sessionId)
  if (!s || !this.terminals) return undefined
  const old = s.terminals.find((t) => t.id === terminalId)
  if (!old) return undefined

  // Force a summary flush now if dirty (bypass debounce — explicit user intent).
  if (this.summaryDirty.has(sessionId)) {
    this.summaryDirty.delete(sessionId)
    this.lastFlushAt.set(sessionId, this.now())
    const prompt =
      "You're being retired. Fold all findings into the session summary NOW via " +
      "set_session_summary, then stop."
    this.terminals.write(terminalId, `\x1b[200~${prompt}\x1b[201~\r`)
  }

  const info = this.terminals.create(undefined, old.cwd, s.id)
  s.terminals.push({ id: info.id, name: info.name, cwd: info.cwd, lastState: "active" })
  this.terminals.kill(terminalId)
  old.lastState = "dead"
  s.status = "active"
  this.persist(s)
  this.emit("worksession:updated", this.withEffectiveActivity(s))
  return { terminalId: info.id }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire IPC + preload**

In `electron/ipc.ts` (near the other worksession handlers):

```ts
  ipcMain.handle("worksession:handoff", (_e, sessionId: string, terminalId: string) =>
    workSessionService.handoffTerminal(sessionId, terminalId),
  )
```

In `electron/preload.ts`:

```ts
  handoffTerminal: (sessionId: string, terminalId: string) =>
    ipcRenderer.invoke("worksession:handoff", sessionId, terminalId),
```

- [ ] **Step 6: Bind Ctrl+H in App.tsx**

In `src/App.tsx`, find the keyboard handler `useEffect` (the one handling Ctrl+N etc.). Add a branch. First add the handler callback near the others:

```tsx
const handleHandoff = useCallback(async () => {
  if (!activeSessionId || !activeTerminalId) return
  const r = await window.api.handoffTerminal(activeSessionId, activeTerminalId)
  if (r?.terminalId) setActiveTerminalId(r.terminalId)
}, [activeSessionId, activeTerminalId])
```

Add `handoffTerminal` to the `Window.api` type:

```ts
handoffTerminal: (sessionId: string, terminalId: string) => Promise<{ terminalId: string } | undefined>
```

In the keydown switch, add (matching the existing `e.ctrlKey && e.key === "..."` style):

```tsx
if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "h") {
  e.preventDefault()
  handleHandoff()
  return
}
```

Ensure `handleHandoff` is in the effect's dependency array (or accessed via a ref if the effect is mount-only — match the file's existing pattern; if other handlers like `handleNewSession` are in the deps, add `handleHandoff` there too).

- [ ] **Step 7: Typecheck + build + commit**

Run: `npx tsc --noEmit -p tsconfig.json` (clean), `npm run build` (green), `npx vitest run` (all pass).

```bash
git add electron/services/sessions.ts electron/services/sessions.test.ts electron/ipc.ts electron/preload.ts src/App.tsx
git commit -m "feat(sessions): Ctrl+H retire-and-continue handoff"
```

---

## Task 9: Docs + SERVER_INSTRUCTIONS + final E2E

**Why:** Keep the source-of-truth docs in sync (CLAUDE.md describes every tool group; SERVER_INSTRUCTIONS is the spawned terminal's map) and prove the whole flow end-to-end.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `electron/mcp/server.ts` (`SERVER_INSTRUCTIONS`)
- Create: `scripts/e2e-resume.mjs`

- [ ] **Step 1: Update SERVER_INSTRUCTIONS**

In `electron/mcp/server.ts`, in the work-session guidance paragraph, append a sentence about idle-flush so terminals expect the injected prompt:

```
When you finish a chunk of work and go quiet, you may receive a short prompt asking you to refresh the session summary via set_session_summary — do it concisely; it's how a fresh terminal inherits your progress. On Ctrl+H you'll be asked to flush and retire.
```

- [ ] **Step 2: Update CLAUDE.md**

In `CLAUDE.md`, under the work-session / context-engine tool group description, add a short bullet documenting: ccConversationId resume (`--resume` on reopen, fresh fallback), idle-flush summary, parsed-activity fallback, the Session Overview panel (`session-overview` panel type), and `Ctrl+H` handoff. Add `Ctrl+H` to the Keyboard Shortcuts table if not already present (it is listed; confirm the description now reads "Retire & continue (handoff)").

- [ ] **Step 3: Write the E2E driver**

Create `scripts/e2e-resume.mjs` (mirrors `scripts/e2e-identity.mjs`):

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"

const port = process.argv[2]
const base = `http://127.0.0.1:${port}/sse`
const connect = async (url) => {
  const c = new Client({ name: "e2e", version: "1.0.0" }, { capabilities: {} })
  await c.connect(new SSEClientTransport(new URL(url)))
  return c
}
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args })
  return (r.content || []).map((x) => x.text ?? "").join("\n")
}

const admin = await connect(base)
const session = JSON.parse(await call(admin, "create_work_session"))
const sid = session.id
const tid = "term-resume-e2e"
await call(admin, "register_terminal", { session_id: sid, terminal_id: tid, name: "e2e", cwd: "/repo" })

const term = await connect(`${base}?sid=${encodeURIComponent(sid)}&tid=${encodeURIComponent(tid)}`)
await call(term, "session_note", { text: "root cause is the boot race" })
await call(term, "set_session_summary", { summary: "Fixing the boot race; root cause found." })

const ctx = await call(term, "get_session_context")
console.log("context primer contains summary:", ctx.includes("boot race"))
console.log("context primer contains finding:", ctx.includes("root cause"))

await admin.close()
await term.close()
process.exit(0)
```

- [ ] **Step 4: Run the full verification**

Run: `npx tsc --noEmit -p tsconfig.json` (clean), `npx vitest run` (all pass), `npm run build` (green).

Then manually (requires the app running): launch `npm run dev`, note the MCP port from the console, run `node scripts/e2e-resume.mjs <port>`, and confirm both lines print `true`.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md electron/mcp/server.ts scripts/e2e-resume.mjs
git commit -m "docs: document resume/idle-flush/overview/handoff + e2e driver"
```

---

## Manual Validation Checklist (human, after Task 9)

These require a real `claude` CLI and interaction — not headlessly verifiable:

- [ ] Open a terminal, do work, close it, reopen → lands back in the same chat (`--resume`), context intact.
- [ ] Delete the transcript file, reopen → fresh terminal, `get_session_context` still primes it (fallback).
- [ ] Let a terminal finish work with new notes → after the idle grace, it gets the summary-refresh prompt and updates the summary.
- [ ] Heads-down terminal (no narration) → sidebar activity line shows the parsed `Edit(...)` line, not frozen.
- [ ] Click the ⊕ on a session → Overview panel shows summary, findings, ruled-out, terminals, disabled push button.
- [ ] Select a session → its terminals appear inline (no caret); other sessions are single rows.
- [ ] `Ctrl+H` → summary flushes, a fresh terminal opens in the session, the old one retires.

---

## Self-Review Notes (addressed during planning)

- **Spec coverage:** ccConversationId resume (Tasks 1-3), idle-flush summary (Task 4), parsed-activity fallback (Task 5), Overview panel + observer seam (Tasks 6-7), sidebar restructure per the user's new direction (Task 7), Ctrl+H handoff (Task 8), docs/E2E (Task 9). All spec items present.
- **Type consistency:** `ccConversationId` (existing field), `effectiveActivity`/`getOverview`/`handoffTerminal`/`scheduleIdleFlush`/`recordConversationId` are used with identical names across tasks. `TerminalLike` is extended once (Tasks 2/3/4) and every later task assumes the extended shape.
- **Known integration point to verify before coding:** `closeTerminal`'s current semantics (removes ref vs. marks dead) — Task 3 Step 6/8 flags this; the resume path needs the ref to survive close as `dead`. Confirm and adjust there.
- **Renderer caveat:** App.tsx's keyboard effect and `Window.api` typing differ across the file's existing patterns; Tasks 7/8 say to match the file's established style (deps array vs. ref) rather than prescribing one blindly.
