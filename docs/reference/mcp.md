# MCP Server & Tool Catalog

## Server

- HTTP/SSE on random localhost port, started on app launch
- Config written to `{tmpdir}/claudetui/mcp-config.json`
- Each spawned Claude session gets `--mcp-config` pointing to this file
- Tools map 1:1 to service methods
- The server ships an `instructions` string (`SERVER_INSTRUCTIONS` in `electron/mcp/server.ts`) via the MCP initialize result. Claude Code surfaces this as an "MCP Server Instructions" block, so a freshly spawned session gets a map of the tool groups up front without having to load each (deferred) tool schema to discover them. **Keep it in sync when adding tool groups.**

## Tool groups

Session/workspace tools map 1:1 to `SessionService` / `WorkspaceService` methods. Additional tool groups:

### Panels (`PanelService` → ModalHost, pop-out via `CompanionService`)

Panels render **modal-by-default in the main window** (the `ModalHost`); the user can pop any panel out to the separate companion window (its `surface` flips `"modal"` → `"window"`). `PanelService` routes every panel event to the main-window mirror and ALSO to the companion for popped-out panels; `CompanionService` manages the companion `BrowserWindow` lifecycle (created only on pop-out, placement clamped to the display work area). Full panel-system architecture: `docs/reference/panels.md`.

- `show_panel` — show a `diff`, `image`, `markdown`, `table`, `git`, or `code` panel. `git` renders a `git_status` result (branch, ahead/behind, staged/unstaged files) plus optional `git_log` commits; `code` renders `{ code, language?, filename?, startLine?, highlightLines?: number[], wrap? }` — a read-only code excerpt with gutter line numbers and per-line highlighting (distinct from `diff`, which compares two versions); `table` renders a text grid; `markdown` renders `{ content }`; `image` renders `{ src }`. (The R5 retrenchment cut the zero-use long-tail panel types — heatmap/kanban/stat/log/progress/timeline/tree/chart/test/notes — down to this durable set.) The `context-inspector` and `session-overview` types are opened by the app, not driven directly by Claude.
- `show_form` — show an interactive form and **wait** for the user to submit; returns the field values (or `{ cancelled: true }`)
- `ask_user` (CAPP-107) — ask the human a question mid-task: option cards (2–8) + optional free text, composed over the SAME form path (the QuestionForm↔ask_user payload contract lives in `src/lib/questionSubmit.ts`), blocks until answered, and raises a tier-1 NEEDS YOU entry quoting the question (`formPendingReason` in `panels.ts`). Use this — Claude Code's native AskUserQuestion tool does NOT exist on the headless `-p` wire (spike-verified: absent from init tools, no arming flag).
- `update_panel` / `hide_panel` / `hide_all_panels` / `list_panels`

### Testing/self-verification (`AppService`)

- `take_screenshot` — capture the ClaudeTUI window as a PNG
- `get_app_state` — current window/session/workspace state for assertions
- `run_build` — build the project and return success/error output

### Notifications (`NotificationService`)

- `notify` — show a toast (`info` / `success` / `warning` / `error`). Surfaces even when the calling session's terminal isn't focused — use it to announce task completion, request input, or report errors. Auto-dismisses after `timeout` ms (0 = sticky). Rendered by `ToastHost` (`src/components/ToastHost.tsx`).

### Session activity / orchestration (`SessionService`)

- A session is marked **active** while it produces terminal output and flips to **idle** after `idleThresholdMs` (1.5s) of quiet — i.e. Claude finished or is waiting for input. A shared 1s timer drives this and emits `terminal:state` events, which the renderer uses to animate the status dot (active = pulsing green, idle = steady yellow).
- `get_session_activity` — snapshot of every session's `state` and `idleMs` (ms since last output). Tells you at a glance which background session needs attention.
- `wait_for_session_idle` — block until a session's output goes quiet (it finished working) or `timeout_ms` elapses, then return its recent output. Optionally inject `input` first (with `submit` to press Enter) to delegate a task and wait for completion instead of polling. Injecting input resets the quiet clock, sidestepping the startup race before the session's first output.

### Attention queue (`AttentionService`)

Service behavior and renderer detail: `docs/reference/services.md` (§AttentionService).

- `get_attention_queue` — read-only ordered snapshot (see if the human is already backed up before raising another checkpoint).
- `request_attention` — put yourself on the queue as a tier-2 `asked` entry (`reason`, plus `session_id`/`terminal_id` defaulting to the caller's identity) when you're blocked on the user but didn't raise a form.

### Scheduler (`SchedulerService`)

On-device scheduled/recurring Claude runs — set up a recurring watch ("check X every 20 minutes between 08:00 and 22:00") or a one-shot future run; each fire spawns a headless structured terminal into the schedule's durable work session on this machine (full native toolset — web, git, local MCP — unlike cloud scheduling). Recurrence kinds: `interval` (everyMinutes + optional local time window, wrap-around supported + days), `daily` (at HH:mm + days), `once` (ISO datetime). Service internals + UI: `docs/reference/services.md` (§SchedulerService).

- `schedule_create` / `schedule_list` / `schedule_update` (enable/disable/edit; "" clears cwd/model/effort) / `schedule_delete` / `schedule_run_now` — identity-bound: `workspace_id` defaults to the CALLER's owning session's workspace, never `getActiveId`. Run history rides the schedule snapshot.

### Clipboard (`ClipboardService`)

- `write_clipboard` / `read_clipboard` — put text on the user's system clipboard (hand them a finished command, regex, or snippet to paste elsewhere) or read back what they just copied. Thin wrapper over Electron's `clipboard`.

### Shell (`ShellService`)

- `open_external` — open a URL in the user's default browser (e.g. pop open a localhost dev server you just started) or other default app for the scheme.
- `reveal_path` — reveal a file/folder in the OS file manager (Explorer/Finder), selecting it. Thin wrapper over Electron's `shell`.

### Git — read-only (`GitService`)

All tools resolve a working dir from `session_id` (falls back to the first open session, then the app cwd) and return structured JSON — no parsing raw terminal output. Read-only by design: write-side git (stage/commit/push/branch/stash) is deliberately **not** exposed — that plumbing belongs to the agent's own shell (see `docs/roadmap/00-identity.md`).

- `git_status` (branch, ahead/behind, staged vs. unstaged changes), `git_log` (recent commits), `git_diff` (optionally scoped to one file and/or `--staged`), `git_show` (drill into a single commit/`ref` — full metadata, the `--stat` summary, and the patch; defaults to HEAD), `git_blame` (line-by-line authorship of a file — commit/author/date/summary per line, optional `start_line`/`end_line` range), `git_branches` (list local + remote-tracking branches: name, current, remote).

### Diff panel (`FileService` → `PanelService`)

- `diff_files` — open the interactive (review-enabled) diff panel comparing two files: `old_path` + `new_path` (two files on disk), `old_path` + `new_content` (preview a proposed rewrite), or just `new_path`/`new_content` (show as all additions). Unlike `git_diff` (tracked working-tree changes only) this compares any files. Reads via `FileService` (the only surviving `FileService` method), renders via the shared `DiffPanel` (so users can select hunks and send a review request). Paths resolve against a session's working dir (or absolute).

### App UI control (`UiService`)

Drive the same view actions a user triggers by keyboard/menu — so Claude can ask the app to, e.g., "enter focus mode". These are **renderer-only** view states (no service owned the data), so `UiService` bridges them: each tool calls a `UiService` method that emits a `ui:*` event the renderer listens for (mount-time listeners in `App.tsx`, registered via `preload.ts`). The boolean-toggle tools take an optional desired state; omit it to flip the current value.

- `set_focus_mode` — distraction-free mode (hides sidebar + tab bar). `enabled?`
- `open_command_palette` — the Ctrl+Shift+P fuzzy action menu. `open?`
- `show_keyboard_shortcuts` — the Ctrl+/ shortcuts overlay. `open?`
- `open_history_search` — the Ctrl+Shift+F session-output search overlay. `open?`
- `export_session_log` — download a session's captured output as `.txt` (defaults to active session). `session_id?`
- `get_config` — read the current config (theme, default command/args, scan paths).

### Work sessions (`SessionService` — the durable container)

`create_work_session` / `list_work_sessions` / `work_session_status`, `register_terminal`, `set_terminal_activity`. Spawned terminals bind identity via the SSE URL (`?sid=&tid=`) so these tools default to the caller's own ids. Durable KNOWLEDGE lives in Claude's native memory (CLAUDE.md / CLAUDE.local.md / auto-memory), not the app (retrenched in R3a). Container model + resume-fidelity detail: `docs/reference/services.md` (§SessionService).

- `post_output` (CAPP-132) — post a DELIVERABLE (`kind: "link" | "file" | "note"` + `title`, plus `url` / `path` / `text` per kind) to the calling session's durable OUTPUTS feed, surfaced in the Agent Rail's OUTPUTS section (FIFO, capped 200/session). Identity-bound — the terminal id defaults to the caller's own — and routes to `TerminalService.postExplicitOutput`, which forwards it immediately AND suppresses a matching stream-DERIVED draft this turn (explicit beats derived). For ARTIFACTS the user opens/keeps (PR link, report file, findings note), NOT progress chatter. Files (Write/Edit/NotebookEdit) and result-text links are ALSO captured automatically with no agent cooperation; `post_output` just gives the important ones a proper title. Never a blocking gate (tier-1 contract untouched). Design: `docs/roadmap/rail-outputs-feed-design.md`.

### Context Inspector (workspaces group)

`inspect_workspace_context` — READ-ONLY, identity-bound to the caller's OWNING session's workspace, never `getActiveId`. Full detail: `docs/reference/services.md` (§ContextInspectorService).

## How to add a renderer-only UI action to MCP

When a feature lives purely in React state (no service), expose it through `UiService` rather than inventing a service for it:

1. **UiService method** — add `setFoo(value?)` to `electron/services/ui.ts` that calls `this.emit("ui:foo", value)`.
2. **Preload listener** — add `onUiFoo` to `electron/preload.ts` (`ipcRenderer.on("ui:foo", ...)`, `?? undefined` so omitted = toggle).
3. **MCP tool** — add `server.tool("foo", ...)` in `electron/mcp/tools.ts` calling `ui.setFoo(...)`.
4. **Renderer wiring** — in `App.tsx`'s mount `useEffect`, register `window.api.onUiFoo(...)` to update React state, and add a `removeAllListeners("ui:foo")` to the cleanup. If the handler needs a fresh closure (like `export_session_log` does over `activeId`), stash it in a ref synced by its own effect.
