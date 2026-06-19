# P1-1 — Cut the MCP tool surface to its on-thesis core

- **Phase:** 1 · **Depends on:** none · **Worktree:** yes · **Size:** L (~1 day)
- **Why:** ~150 MCP tools ship to every spawned session (~12–15k tokens of schema each),
  and roughly half duplicate Claude Code's native abilities — actively competing with
  better native tools for the model's attention while diluting what this app is. This is
  the single highest-leverage change in Phase 1: subtraction as identity
  ([identity doc](../00-identity.md), kill-list section).

## Current state (verified 2026-06-10, post-Phase-0)

- `electron/mcp/tools.ts` — ~2,250 lines, all tools registered unconditionally in
  `registerTools(...)`.
- `electron/mcp/server.ts` — `startMcpServer(...)` takes ~36 service parameters and passes
  them to `registerTools`; `SERVER_INSTRUCTIONS` (top of file) describes all tool groups.
- `electron/ipc.ts` — instantiates every service and passes them to `startMcpServer`.
- Utility services live one-per-file under `electron/services/`.

## Scope

### 1. Delete these tool groups from `tools.ts` AND their backing services

| Cut | Service file to delete |
|-----|------------------------|
| All encode/hash/uuid/jwt tools | `electron/services/encode.ts` |
| All JSON utility tools (json_keys, query_json, format_json, …) | `electron/services/json.ts` |
| All CSV tools | `electron/services/csv.ts` |
| All regex tools | `electron/services/regex.ts` |
| All text-transform/count/lines tools | `electron/services/text.ts` |
| All color tools | `electron/services/color.ts` |
| All math tools | `electron/services/math.ts` |
| All URL tools | `electron/services/url.ts` |
| All time/date tools | `electron/services/time.ts` |
| System-info tools | `electron/services/system.ts` |
| `run_command` | `electron/services/commands.ts` |
| Task-queue tools | `electron/services/taskqueue.ts` |
| Snippet tools (save/list/send/delete_snippet) | `electron/services/snippets.ts` |
| HTTP tools (http_request, download_file) | `electron/services/http.ts` |
| Port tools (check_port, wait_for_port) | `electron/services/ports.ts` |
| Process tools (find/kill process, list_processes) | `electron/services/process.ts` |
| File-search tools (find_files, grep_code) | `electron/services/filesearch.ts` |
| File-edit tools (replace_in_file, insert_in_file) | `electron/services/edit.ts` |
| File I/O tools (read_file, write_file, tail_file, stat/copy/move/delete/mkdir) | **keep `files.ts`** — `diff_files` reads through it; delete only the tool definitions, then remove any `FileService` methods left with zero callers |
| Git write + deep-read extras: git_stage, git_unstage, git_commit, git_branch, git_checkout, git_push, git_pull, git_stash*, git_tags, git_remotes, git_file_at_ref, git_file_history, git_search_log | **keep `git.ts`** — read tools remain; remove service methods left with zero callers |

**Keep** (the on-thesis core): sessions/panes + history + broadcast, work-session context
engine, missions, workspaces, all panel/form tools (including `diff_files` and
`show_notes`/notes), notifications, clipboard, shell (open_external/reveal_path),
templates, layouts, run_build/run_tests/take_screenshot/get_app_state, all `ui.*` app-control
tools, and read-only git: git_status, git_log, git_diff, git_show, git_blame, git_branches.
Expected result: **~70 tools**, every one justified by a pillar.

### 2. Deletion protocol (per service)

Before deleting a service file, grep the whole repo for its class name and import path.
Only `ipc.ts`, `server.ts`, and `tools.ts` should reference utility services — remove
those references (instantiation, params, imports). If anything ELSE references one
(renderer, another service), STOP for that service, leave it in place, note it in your
report instead of forcing the cut.

### 3. Rewrite `SERVER_INSTRUCTIONS`

Restructure around the three pillars (continuity / agent-rendered UI / orchestration) per
the identity doc. Describe only surviving groups. Keep the "IF YOU WERE SPAWNED AS A
TERMINAL IN A WORK SESSION" block — it's load-bearing onboarding for spawned sessions.

### 4. Update CLAUDE.md

Remove the cut tool groups from the "MCP Tools" section; adjust the service table.

### 5. Measure

Report before/after: tool count (count `server.tool(` occurrences) and `tools.ts` line
count. Target ≥45% tool-count reduction.

## Non-goals

- Do NOT split `tools.ts` into modules (P1-2 does that next, on the slimmed file).
- Do NOT touch panel components, the renderer, or any kept service's behavior.
- Do NOT remove IPC handlers in `ipc.ts` that the RENDERER uses (only MCP-side wiring of
  deleted services). If a deleted service has renderer IPC handlers, check `preload.ts`
  first — if exposed there, verify with grep whether any component calls it; report if so.

## Acceptance criteria

- `npm run build` and `npm test` pass; no dangling imports (tsc is the proof).
- Grep proves zero references to each deleted service.
- Tool count reported before/after; `SERVER_INSTRUCTIONS` mentions only surviving tools.
- CLAUDE.md updated.
- Commit only the files you actually changed/deleted, staged by explicit path.

## Files

- Modify: `electron/mcp/tools.ts`, `electron/mcp/server.ts`, `electron/ipc.ts`, `CLAUDE.md`
- Delete: the service files listed above (verify-then-delete protocol)
- Possibly modify: `electron/preload.ts` (only if a deleted service leaks there — report it)
