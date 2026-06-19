# P1-2 — Split tools.ts into domain modules

- **Phase:** 1 · **Depends on:** P1-1 (merged: `a01cec0`) · **Worktree:** yes · **Size:** M (~half day)
- **Why:** Even slimmed to 75 tools, `electron/mcp/tools.ts` is a 1,061-line single file.
  Phase 2 adds tools (attention queue, worktree workers); each domain needs a home that
  one person (or agent) can hold in context ([identity doc](../00-identity.md)).

## Current state (verified 2026-06-10, post-P1-1)

- `electron/mcp/tools.ts` — 1,061 lines, 75 `server.tool(` registrations, one exported
  `registerTools(server, ...17 services, identity)` plus the `TerminalIdentity` type.
- `electron/mcp/server.ts` — 186 lines; calls `registerTools` once per SSE connection.

## Scope (structure decided — implement as written)

Create `electron/mcp/tools/` with one module per domain, each exporting a
`registerXxxTools(server, deps)` function taking ONLY the services that domain uses:

| Module | Tool groups |
|--------|-------------|
| `sessions.ts` | sessions/panes, session history/output search, broadcast, wait_for_session_idle, session activity |
| `worksessions.ts` | work-session container + context engine tools |
| `missions.ts` | all mission_* tools |
| `panels.ts` | show_panel/show_form/update/hide/list, diff_files, show_notes + notes tools |
| `git.ts` | the 6 read-only git tools |
| `app.ts` | screenshot/app-state/run_build/run_tests, notify, clipboard, shell (open_external/reveal_path), workspaces, templates, layouts, get_config |
| `ui.ts` | the ui-control tools (focus mode, palette, shortcuts, history search, export log) |

- `tools.ts` itself becomes the composition root: keeps the `TerminalIdentity` export and
  a `registerTools(...)` with an **unchanged signature** that calls the seven module
  functions. `server.ts` should not need to change (verify with git diff).
- This is a MOVE, not a rewrite: tool names, descriptions, schemas, and handler bodies
  are relocated verbatim. Shared helpers (e.g. working-dir resolution from session_id, the
  JSON-result wrapper) move to `electron/mcp/tools/shared.ts` if used by >1 module.

## Non-goals

- No tool additions/removals/renames; no schema or description edits.
- No service changes, no ipc.ts changes (P1-3 owns that file — do NOT touch it).
- No deferred-loading work.

## Acceptance criteria

- `grep -c "server.tool("` summed across `electron/mcp/tools/*.ts` + `tools.ts` == 75.
- Every new module ≤ ~400 lines; `tools.ts` ≤ ~120 lines.
- `npm run build` and `npm test` pass; `git diff` on `server.ts` is empty (or trivially
  import-only — justify if so).
- Commit only `electron/mcp/tools.ts` + new `electron/mcp/tools/*` files, by explicit path.

## Files

- Create: `electron/mcp/tools/{sessions,worksessions,missions,panels,git,app,ui,shared}.ts`
- Modify: `electron/mcp/tools.ts`
