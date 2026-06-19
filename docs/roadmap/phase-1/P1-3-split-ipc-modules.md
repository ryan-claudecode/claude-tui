# P1-3 — Split ipc.ts into domain handler modules

- **Phase:** 1 · **Depends on:** P1-1 (merged: `a01cec0`) · **Worktree:** yes · **Size:** S–M (~3 hours)
- **Why:** `electron/ipc.ts` constructs every service, wires cross-service dependencies,
  starts the MCP server, AND registers all renderer IPC handlers — the project's
  remaining god-file. Splitting handler registration by domain makes each independently
  reviewable and keeps construction/wiring readable ([identity doc](../00-identity.md)).

## Current state (verified 2026-06-10, post-P1-1)

- `electron/ipc.ts` — 249 lines after P1-1's service cut: service instantiation +
  exports at top; `setupIpc(win)` registers all `ipcMain.handle`/`ipcMain.on` handlers,
  wires services to the window, starts the MCP server (inside the P0-2 try/catch with
  `dialog.showErrorBox`), and calls `missionService.start()`.

## Scope (structure decided — implement as written)

Create `electron/ipc/` with handler modules, each exporting
`registerXxxHandlers(deps)`:

| Module | Channels |
|--------|----------|
| `terminal-handlers.ts` | `terminal:*` (write/resize/rename/output/search/state events) |
| `worksession-handlers.ts` | `worksession:*` (open/add/reopen/close/kill/context/overview/handoff) |
| `panel-handlers.ts` | `panel:*` + notification channels |
| `mission-handlers.ts` | `mission:*` |
| `app-handlers.ts` | workspaces, config, theme, drops (`saveDroppedImage`), window controls if registered here |

- `ipc.ts` keeps: service construction + exports (unchanged), `setupIpc` as orchestration
  (window wiring, the MCP startup try/catch block verbatim, `missionService.start()`,
  then one call per `registerXxxHandlers`).
- MOVE, not rewrite: channel names and handler bodies relocate verbatim. The exported
  service singletons stay exported from `ipc.ts` (main.ts imports them — don't break it).

## Non-goals

- No channel renames, no new channels, no handler behavior changes.
- Do NOT touch `electron/mcp/tools.ts` or `electron/mcp/tools/` (P1-2 owns those — may be
  in flight concurrently).
- No preload.ts changes.

## Acceptance criteria

- The set of registered channels is IDENTICAL before/after: capture
  `grep -o 'ipcMain\.\(handle\|on\)("[^"]*"' -r electron/` sorted, compare pre/post — include
  both lists (or their diff: empty) in your report.
- `ipc.ts` ≤ ~150 lines; each handler module ≤ ~120 lines.
- `npm run build` and `npm test` pass.
- Commit only `electron/ipc.ts` + new `electron/ipc/*` files, by explicit path.

## Files

- Create: `electron/ipc/{terminal,worksession,panel,mission,app}-handlers.ts`
- Modify: `electron/ipc.ts`
