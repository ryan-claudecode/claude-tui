# Sessions-as-Containers: Context Engine Wiring (Plan 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the durable `SessionService` *container* (built in Plan 1) into the MCP server and expose the headless context-engine + container-CRUD tool surface, so Claude can create work-session containers, register terminals into them, record/correct findings, set a summary, report per-terminal activity, and pull a context primer — all E2E-verifiable via `scripts/mcp-client.mjs` without touching the renderer.

**Architecture:** The container already exists and is unit-tested (`electron/services/sessions.ts`, `SessionService`). This plan adds two small service methods (per-terminal activity + a most-recent-active `status` lookup mirroring `MissionService.status`), instantiates the container as a shared singleton in `ipc.ts` (with `load()` on boot for durability across restarts), threads it through the `startMcpServer` → `registerTools` chain as a new parameter, registers the MCP tool group, and updates `SERVER_INSTRUCTIONS`. No renderer changes; no spawn-lifecycle changes (those are Plan 3).

**Tech Stack:** TypeScript, Electron, @modelcontextprotocol/sdk, zod, vitest@4.1.8. Build: `npm run build` (electron-vite/esbuild). Test: `npx vitest run`. E2E smoke: `node scripts/mcp-client.mjs <tool> '<jsonArgs>'`.

---

## Scope & Boundaries

**In scope (Plan 2):** headless MCP surface for the container — all-new tool names (`create_work_session`, `list_work_sessions`, `work_session_status`, `register_terminal`, `set_terminal_activity`, `session_note`, `get_session_context`, `set_session_summary`) that do NOT collide with the existing `*_session` tools (which operate on terminals via `TerminalService`).

**Out of scope (deferred to Plan 3):** routing real terminal spawns through the container, the React sidebar tree / tabbar / Overview panel, seed-prompt hijack, idle-flush auto-summary, lazy-spawn, `claude --resume` reattach, `ccConversationId` capture, and parsed-fallback (B) activity detection from PTY output. Plan 2's `set_terminal_activity` is the A-primary (Claude self-reports) path only.

## File Structure

- **Modify** `electron/services/sessions.ts` — add `activity?`/`activityAt?` fields to `TerminalRef`; add `setTerminalActivity`, `setTerminalState`, and `status(id?)` methods to `SessionService`. (~30 new lines.)
- **Modify** `electron/services/sessions.test.ts` — add tests for the three new methods.
- **Modify** `electron/ipc.ts` — import `SessionService`, instantiate `workSessionService` singleton, `load()` it inside `setupIpc`, pass it to `startMcpServer`.
- **Modify** `electron/mcp/server.ts` — add `SessionService` import + `workSessionService` param to `startMcpServer`, forward it to `registerTools`, and extend `SERVER_INSTRUCTIONS` with the new tool group.
- **Modify** `electron/mcp/tools.ts` — add `SessionService` import + `workSessions` param to `registerTools`, register the eight context-engine tools.

---

### Task 1: Per-terminal activity + state on the container

**Files:**
- Modify: `electron/services/sessions.ts` (`TerminalRef` interface; new methods on `SessionService`)
- Test: `electron/services/sessions.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to the end of `electron/services/sessions.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: FAIL — `setTerminalActivity`, `setTerminalState`, and `status` are not functions on `SessionService`.

- [ ] **Step 3: Add the fields and methods**

In `electron/services/sessions.ts`, extend the `TerminalRef` interface (add the two optional fields after `lastState`):

```ts
export interface TerminalRef {
  id: string
  name: string
  cwd: string
  ccConversationId?: string
  lastState: "active" | "idle" | "dead"
  /** Rich-presence "what this terminal is doing now" line (Claude self-reports it). */
  activity?: string
  /** Epoch ms when `activity` was last set. */
  activityAt?: number
}
```

Then add these three methods to the `SessionService` class. Put `setTerminalActivity` and `setTerminalState` right after `nameTerminal` (they are terminal mutators), and `status` right after `list()` (it is a lookup):

```ts
  setTerminalActivity(sessionId: string, terminalId: string, activity: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const t = s.terminals.find((x) => x.id === terminalId)
    if (!t) return
    t.activity = activity
    t.activityAt = this.now()
    this.persist(s)
  }

  setTerminalState(sessionId: string, terminalId: string, state: "active" | "idle" | "dead"): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const t = s.terminals.find((x) => x.id === terminalId)
    if (!t) return
    t.lastState = state
    this.persist(s)
  }
```

And the lookup (mirrors `MissionService.status` — most-recently-updated active when id omitted):

```ts
  /** Lookup by id; with no id, the most-recently-updated *active* session (resume entry point). */
  status(id?: string): WorkSession | undefined {
    if (id) return this.sessions.get(id)
    return [...this.sessions.values()]
      .filter((s) => s.status === "active")
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: PASS (all prior + 6 new tests green).

- [ ] **Step 5: Commit**

```bash
git add electron/services/sessions.ts electron/services/sessions.test.ts
git commit -m "feat(sessions): add per-terminal activity/state + most-recent-active status lookup to container"
```

---

### Task 2: Wire the container singleton into ipc.ts and the MCP server signatures

**Files:**
- Modify: `electron/ipc.ts:40-75` (instantiate), `electron/ipc.ts:77-134` (load + pass to startMcpServer)
- Modify: `electron/mcp/server.ts:4-37` (import), `:61-96` (param), `:110-146` (forward to registerTools)
- Modify: `electron/mcp/tools.ts:1-76` (import + param)

This task is pure plumbing — it threads the new singleton through the chain without registering any tool yet, so it must build cleanly with the parameter unused-but-typed. (TypeScript won't error on an unused function parameter.)

- [ ] **Step 1: Instantiate the container in ipc.ts**

In `electron/ipc.ts`, add the import near the other service imports (after the `MissionService` import at line 36):

```ts
import { SessionService } from "./services/sessions"
```

Then add the singleton. Place it right after the `missionService` block (after line 75), so it sits at the end of the exported singletons:

```ts
export const workSessionService = new SessionService()
```

- [ ] **Step 2: Load persisted containers on boot + pass to startMcpServer**

In `electron/ipc.ts`, inside `setupIpc`, add a `load()` call. Put it next to `workspaceService.discover(...)` (around line 93):

```ts
  workSessionService.load()
```

Then add `workSessionService` as the final argument to the `startMcpServer(...)` call (currently ending with `missionService,` at line 130). Change:

```ts
    missionService,
  )
  sessionService.setMcpConfigPath(configPath)
```

to:

```ts
    missionService,
    workSessionService,
  )
  sessionService.setMcpConfigPath(configPath)
```

- [ ] **Step 3: Thread the param through server.ts**

In `electron/mcp/server.ts`, add the import after the `MissionService` import (line 37):

```ts
import type { SessionService } from "../services/sessions"
```

Add the parameter to `startMcpServer` (after `missionService: MissionService,` at line 95):

```ts
  missionService: MissionService,
  workSessionService: SessionService,
): Promise<{ port: number; configPath: string }> {
```

And forward it in the `registerTools(...)` call inside `makeServer` (after `missionService,` at line 145):

```ts
      missionService,
      workSessionService,
    )
    return server
```

- [ ] **Step 4: Thread the param through tools.ts**

In `electron/mcp/tools.ts`, add the import after the `MissionService` import (line 36):

```ts
import type { SessionService } from "../services/sessions"
```

Add the parameter to `registerTools` (after `mission: MissionService,` at line 75):

```ts
  mission: MissionService,
  workSessions: SessionService,
) {
```

- [ ] **Step 5: Build to verify the chain type-checks**

Run: `npm run build`
Expected: exit 0, no type errors. (`workSessions` is an unused-but-declared parameter — allowed.)

- [ ] **Step 6: Commit**

```bash
git add electron/ipc.ts electron/mcp/server.ts electron/mcp/tools.ts
git commit -m "chore(mcp): thread work-session container singleton through startMcpServer/registerTools"
```

---

### Task 3: Register the context-engine MCP tool group

**Files:**
- Modify: `electron/mcp/tools.ts` (add eight tools after the mission tools, before the panel tools at line ~414)

- [ ] **Step 1: Add the tool group**

In `electron/mcp/tools.ts`, insert this block immediately after the `mission_finish` tool (line 412) and before the `// Rich panel tools` comment (line 414):

```ts
  // Work sessions — the durable *container* of many terminals that accumulates
  // findings (the context engine). Distinct from create_session et al., which
  // operate on individual terminals. A work session holds a summary, a corrected
  // findings ledger, and the terminals registered into it.
  server.tool(
    "create_work_session",
    "Create a new durable work-session container (a goal-scoped grouping of terminals that accumulates findings). Returns the WorkSession.",
    {},
    async () => {
      const s = workSessions.create()
      return { content: [{ type: "text" as const, text: JSON.stringify(s, null, 2) }] }
    },
  )

  server.tool(
    "list_work_sessions",
    "List all work-session containers.",
    {},
    async () => {
      return { content: [{ type: "text" as const, text: JSON.stringify(workSessions.list(), null, 2) }] }
    },
  )

  server.tool(
    "work_session_status",
    "Load a work-session container's full state — the resume entry point. Omit session_id for the most-recently-updated active session.",
    { session_id: z.string().optional() },
    async ({ session_id }) => {
      const s = workSessions.status(session_id)
      return { content: [{ type: "text" as const, text: s ? JSON.stringify(s, null, 2) : "No active work session" }] }
    },
  )

  server.tool(
    "register_terminal",
    "Register a terminal into a work-session container (so its findings and activity roll up to the session). The first terminal's name seeds the session name while it's still 'Untitled session'.",
    {
      session_id: z.string(),
      terminal_id: z.string().describe("The terminal/session id from create_session"),
      name: z.string(),
      cwd: z.string(),
    },
    async ({ session_id, terminal_id, name, cwd }) => {
      workSessions.addTerminal(session_id, { id: terminal_id, name, cwd, lastState: "active" })
      const s = workSessions.get(session_id)
      return { content: [{ type: "text" as const, text: s ? JSON.stringify(s, null, 2) : "Work session not found" }] }
    },
  )

  server.tool(
    "set_terminal_activity",
    "Report what a registered terminal is doing right now (rich-presence line shown under the session). Optionally update its state (active/idle/dead).",
    {
      session_id: z.string(),
      terminal_id: z.string(),
      activity: z.string().describe("Short present-tense line, e.g. 'running the test suite'"),
      state: z.enum(["active", "idle", "dead"]).optional(),
    },
    async ({ session_id, terminal_id, activity, state }) => {
      workSessions.setTerminalActivity(session_id, terminal_id, activity)
      if (state) workSessions.setTerminalState(session_id, terminal_id, state)
      return { content: [{ type: "text" as const, text: workSessions.deriveStatus(session_id) }] }
    },
  )

  server.tool(
    "session_note",
    "Record an authoritative finding into the work session's ledger. If this corrects an earlier note, pass its id as 'corrects' — the old note is demoted to ruled-out (never deleted) and linked to this one.",
    {
      session_id: z.string(),
      text: z.string().describe("The finding, in your own words"),
      corrects: z.string().optional().describe("id of a prior note this supersedes"),
    },
    async ({ session_id, text, corrects }) => {
      const n = workSessions.addNote(session_id, text, corrects ? { corrects } : {})
      return { content: [{ type: "text" as const, text: n ? JSON.stringify(n) : "Work session not found" }] }
    },
  )

  server.tool(
    "set_session_summary",
    "Set/replace the work session's running summary (the top-of-context goal + current-state blurb).",
    { session_id: z.string(), summary: z.string() },
    async ({ session_id, summary }) => {
      workSessions.setSummary(session_id, summary)
      return { content: [{ type: "text" as const, text: "ok" }] }
    },
  )

  server.tool(
    "get_session_context",
    "Pull the work session's context primer: summary, then active findings, then a ruled-out/corrected section. This is what a terminal reads to inherit everything the session knows.",
    { session_id: z.string() },
    async ({ session_id }) => {
      const ctx = workSessions.getContext(session_id)
      return { content: [{ type: "text" as const, text: ctx ?? "Work session not found" }] }
    },
  )
```

- [ ] **Step 2: Build to verify it type-checks**

Run: `npm run build`
Expected: exit 0, no errors.

- [ ] **Step 3: Run the unit suite (no regressions)**

Run: `npx vitest run`
Expected: PASS (mission + sessions suites, including Task 1's new tests).

- [ ] **Step 4: Commit**

```bash
git add electron/mcp/tools.ts
git commit -m "feat(mcp): add work-session container + context-engine tool group"
```

---

### Task 4: Update SERVER_INSTRUCTIONS with the new tool group

**Files:**
- Modify: `electron/mcp/server.ts:44-57` (`SERVER_INSTRUCTIONS`)

- [ ] **Step 1: Add the tool-group line**

In `electron/mcp/server.ts`, in the `SERVER_INSTRUCTIONS` template, insert a new bullet immediately after the "Mission orchestration" bullet (line 55) and before the closing `Notes:` paragraph. Add:

```
- Work sessions (context engine) — create_work_session / list_work_sessions / work_session_status (omit session_id for the most-recent active one) build a durable *container* that groups many terminals and accumulates knowledge. register_terminal adds a terminal to it; set_terminal_activity reports what a terminal is doing now; session_note records authoritative findings (pass 'corrects' to supersede a wrong one); set_session_summary sets the running summary; get_session_context pulls the primer (summary + findings + ruled-out) a terminal reads to inherit what the session knows. Distinct from create_session et al., which manage individual terminals.
```

(Insert it as a new line within the backtick string, keeping the leading `- `.)

- [ ] **Step 2: Build to verify the string still parses**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add electron/mcp/server.ts
git commit -m "docs(mcp): announce work-session context-engine tool group in SERVER_INSTRUCTIONS"
```

---

### Task 5: E2E smoke test via the MCP client harness

This verifies the full live chain (running app → SSE → MCP tools → container → atomic persist) end-to-end. It is a manual smoke run (the project has no automated MCP-client test harness; tools are thin wrappers covered structurally by the service unit tests).

- [ ] **Step 1: Launch the app**

Run (background): `npm run dev`
Wait for the window to appear and `MCP server running on port <N>` in the log (the harness reads `{tmpdir}/claudetui/mcp-config.json`).

- [ ] **Step 2: Drive the full context-engine flow**

Run each in sequence; capture the `id` returned by `create_work_session` and substitute it for `<SID>`:

```bash
node scripts/mcp-client.mjs create_work_session '{}'
node scripts/mcp-client.mjs register_terminal '{"session_id":"<SID>","terminal_id":"t1","name":"Fix auth race","cwd":"/repo"}'
node scripts/mcp-client.mjs set_terminal_activity '{"session_id":"<SID>","terminal_id":"t1","activity":"reading middleware"}'
node scripts/mcp-client.mjs session_note '{"session_id":"<SID>","text":"bug is in auth"}'
node scripts/mcp-client.mjs session_note '{"session_id":"<SID>","text":"actually it is the list endpoint","corrects":"<NOTE_ID_FROM_PREVIOUS>"}'
node scripts/mcp-client.mjs set_session_summary '{"session_id":"<SID>","summary":"Goal: fix the auth race. Patching the list endpoint."}'
node scripts/mcp-client.mjs get_session_context '{"session_id":"<SID>"}'
node scripts/mcp-client.mjs work_session_status '{}'
```

Expected:
- `create_work_session` → a WorkSession JSON with `name: "Untitled session"`, empty `terminals`/`notes`.
- `register_terminal` → session now has `terminals: [{ id:"t1", name:"Fix auth race", ... }]` and `name` inherited to `"Fix auth race"`.
- `set_terminal_activity` → returns `"1 Terminal Working"`.
- second `session_note` → the first note's `status` becomes `superseded` (verify in the next call).
- `get_session_context` → text containing `Goal: fix the auth race` first, then `actually it is the list endpoint` under Findings, then a `Ruled out / corrected` section showing `~~bug is in auth~~ → actually it is the list endpoint`.
- `work_session_status` `{}` → returns the same session (most-recent active).

- [ ] **Step 3: Verify durability (load on restart)**

Stop the app. Confirm the JSON exists on disk:

Run: `ls ~/.claude-tui/sessions/`
Expected: a `<SID>.json` file. (On next `npm run dev`, `workSessionService.load()` rehydrates it — optionally re-run `work_session_status '{}'` after relaunch to confirm it survives.)

- [ ] **Step 4: Final full verification**

Run: `npx vitest run && npm run build`
Expected: all tests PASS, build exit 0.

- [ ] **Step 5: Commit any cleanup**

If Step 2/3 surfaced no code changes, nothing to commit. Otherwise fix + commit with a `fix(...)` message describing the issue found.

---

## Self-Review

**1. Spec coverage:** Plan 2 covers the headless context-engine surface from the design's "Context engine" section: `session_note` (write + correct), `get_session_context` (read primer), `set_session_summary`, plus container CRUD (`create_work_session`/`work_session_status`/`list_work_sessions`/`register_terminal`) and A-primary `set_terminal_activity`. Deferred-by-design (Plan 3): seed hijack, idle-flush summary, lazy-spawn, `--resume`, `ccConversationId` capture, parsed-fallback activity, and all renderer/sidebar/tabbar/Overview UI.

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every command shows expected output. The only intentional human-substituted values are `<SID>`/`<NOTE_ID>` in the live E2E smoke (Task 5), which are runtime ids by nature.

**3. Type consistency:** New singleton named `workSessionService` (ipc.ts) / param `workSessionService` (server.ts) / param `workSessions` (tools.ts) — distinct from the existing `sessionService`/`sessions` (which is `TerminalService`). Methods referenced (`create`, `list`, `status`, `get`, `addTerminal`, `setTerminalActivity`, `setTerminalState`, `addNote`, `setSummary`, `getContext`, `deriveStatus`, `load`) all exist on `SessionService` after Task 1, matching the Plan 1 container and the new methods added here.
