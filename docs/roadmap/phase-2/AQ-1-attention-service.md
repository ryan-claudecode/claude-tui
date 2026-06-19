# AQ-1 — AttentionService: detection, policy, MCP (main process)

- **Phase:** 2 · **Spec:** [attention-queue-design.md](./attention-queue-design.md) (read it FIRST — it is the authority on semantics) · **Depends on:** — · **Worktree:** yes · **Size:** L (~1 day)
- **Why:** see spec Problem section. This item builds everything except the renderer.

## Current state (verified 2026-06-11)

- `electron/services/panels.ts` — `pendingForms: Map<panelId, resolver>` (line ~25);
  `showForm()` (~94) creates the pending promise; `submitForm()` (~102) resolves;
  `hide()` (~68-72) and `hideAll()` (~82-85) resolve as cancelled. NO events emitted, and
  `showForm` does not know which session asked for the form.
- `electron/services/terminals.ts` — `Terminal { state, lastActivity }` (~160-164); the
  shared 1s `idleTimer` flips active→idle (~280-289) and `markActive` flips back
  (~293-300); both paths call `this.emitEvent({ type: "state", ... })` — subscribe via
  the existing `eventListeners`/`onEvent` seam (same one SessionService uses). Output
  tails available via `outputBuffers`. NO `activeSince` field yet. `parseActivityLine`
  is the precedent for tail parsing.
- `electron/services/notifications.ts` — `NotificationState` (line 5) has NO session
  attribution.
- MCP identity is available inside tool modules (`electron/mcp/tools/*.ts`, see
  `worksessions.ts` for the identity-defaulting pattern); `SERVER_INSTRUCTIONS` lives in
  `electron/mcp/server.ts`. Config uses the versioned loader (`electron/config.ts`).
- Service construction/wiring happens in `electron/ipc.ts` (post-P1-3 it is the
  orchestration root).

## Scope

1. **`electron/services/attention.ts`** — implement the spec's data model + policy
   exactly: tier ordering, one-entry-per-terminal with higher-tier replacement and
   `since` preservation, 10s burst guardrail, runtime-only state. API:
   `list()`, `dismiss(id)`, `seen(terminalId)`, `request(sessionId, terminalId, reason)`.
   Emits `attention:updated` (full snapshot) via an injected `sendToRenderer` (same
   pattern as other services). On tier-1 enqueue: fire a toast through
   `NotificationService` AND, when the main window is not focused and
   `attention.osNotifications !== false`, an Electron `Notification`; its click handler
   shows/focuses the main window and emits `attention:jump` with the entry id (renderer
   consumption is AQ-2's job). Window-focus state via an injected `isWindowFocused`
   callback (testable).
2. **PanelService events + attribution** — add a lightweight event seam (callback set,
   like TerminalService's) emitting `form-pending { panelId, origin }` and
   `form-resolved { panelId }` on the three resolve paths. Extend `showForm` with an
   optional `origin?: { sessionId?: string; terminalId?: string }`; thread the caller's
   MCP identity into it from the `show_form` tool (`electron/mcp/tools/panels.ts`).
3. **Terminals: burst + prompt detection** — add `activeSince` (set on create/reopen and
   on every idle→active flip) and include burst length in the idle `state` event (or a
   parallel event — your call, keep it minimal). Add a pure exported
   `detectPromptState(tail: string): boolean` answering "is Claude Code sitting at its
   input prompt?". Seed fixtures from real Claude Code idle output (DO NOT launch
   claude/the app to capture more — these are from real screenshots today):
   the input box renders as a `>` prompt on its own bordered line above a footer line
   containing `bypass permissions on (shift+tab to cycle)`; a busy session instead shows
   a spinner/status line (e.g. `● <tool>(…)` activity lines per `parseActivityLine`).
   Treat the pattern set as extensible: clear named constants + fixture tests so wrong
   guesses are cheap to fix.
4. **Notification attribution** — optional `sessionId` on `NotificationState`; thread
   caller identity from the `notify` MCP tool. Error/warning notifications WITH a
   sessionId enqueue tier-2 `error` entries; without, behavior unchanged.
5. **MCP tools** (`electron/mcp/tools/sessions.ts`): `get_attention_queue` (read-only
   JSON snapshot) and `request_attention` (reason required; ids default to caller
   identity like the work-session tools; enqueues tier 2 `asked` with an
   agent-requested-prefixed reason). Add one SERVER_INSTRUCTIONS line.
6. **Config** — optional `attention?: { osNotifications?: boolean }` in `TuiConfig`
   (additive; no schema version bump). Default true.
7. **Wiring** — construct + subscribe AttentionService in `electron/ipc.ts`.

## Non-goals

- NO renderer/preload/UI changes (AQ-2 owns `useAttention`, Sidebar, Ctrl+J, the
  `attention:seen`/`attention:dismiss` IPC handlers, and CLAUDE.md UI docs).
- No persistence, no snooze, no per-tier config (spec Out-of-scope list).

## Acceptance criteria

- `electron/services/attention.test.ts` covers the spec's test matrix: tier replacement
  + `since` preservation, burst guardrail, seen-clears-tier-2/3, blocked persists until
  form resolve, dismiss, terminal/session-kill cleanup, ordering, `request()`. Fake
  emitters only — the suite stays hermetic (P1-6).
- `detectPromptState` fixture tests (≥4 fixtures: prompt-idle, busy-with-activity-line,
  mid-output, empty).
- `npm run build` + `npm test` green. No UI behavior change.
- Commit only files you changed, by explicit path.

## Files

- Create: `electron/services/attention.ts`, `electron/services/attention.test.ts`
- Modify: `electron/services/panels.ts`, `electron/services/terminals.ts`,
  `electron/services/notifications.ts`, `electron/services/terminals.test.ts` (if the
  activeSince/idle-event change touches existing tests), `electron/mcp/tools/sessions.ts`,
  `electron/mcp/tools/panels.ts` (origin threading), `electron/mcp/server.ts`
  (SERVER_INSTRUCTIONS line), `electron/config.ts`, `electron/ipc.ts`
