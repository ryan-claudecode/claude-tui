# ClaudeTUI

Cross-platform desktop app for managing multiple Claude Code sessions. Electron + React + xterm.js + MCP.

## Run

```bash
npm run dev    # build + launch
npm run build  # build only
npm start      # launch (requires prior build)
```

## Architecture

Three layers — service layer is the core, everything else is a thin adapter on top.

```
┌────────────────────────────────────────────────┐
│  Renderer (React)          MCP Server (HTTP)   │
│  src/App.tsx               electron/mcp/       │
│  src/components/           (Claude connects     │
│                             via --mcp-config)   │
├────────────────────────────────────────────────┤
│  IPC Handlers              MCP Tool Handlers   │
│  electron/ipc.ts           electron/mcp/       │
│  (one-line wrappers)       tools.ts            │
├────────────────────────────────────────────────┤
│           Service Layer (source of truth)       │
│  electron/services/sessions.ts                 │
│  electron/services/workspaces.ts               │
├────────────────────────────────────────────────┤
│  node-pty    config.ts    workspace/discovery   │
└────────────────────────────────────────────────┘
```

## Key Files

### Electron (main process)

| File | Purpose |
|------|---------|
| `electron/main.ts` | App entry — creates window, calls setupIpc |
| `electron/ipc.ts` | IPC handlers — thin wrappers calling services |
| `electron/preload.ts` | contextBridge — exposes API to renderer |
| `electron/services/sessions.ts` | **SessionService** — all session ops (create, kill, rename, handoff, split, etc.) |
| `electron/services/workspaces.ts` | **WorkspaceService** — workspace discovery + activation |
| `electron/services/panels.ts` | **PanelService** — rich UI panel state + form callbacks |
| `electron/services/app.ts` | **AppService** — app-level ops (screenshot, app state, build) |
| `electron/services/ui.ts` | **UiService** — bridges renderer-only view actions (focus mode, drawer, palette, etc.) to MCP by emitting `ui:*` events |
| `electron/services/mission.ts` | **MissionService** — durable, on-disk orchestration missions + Supervisor loop (Conductor respawn, stalled-worker reaping, usage-limit pause/resume) |
| `electron/mcp/server.ts` | MCP HTTP/SSE server lifecycle |
| `electron/mcp/tools.ts` | MCP tool definitions — calls services |
| `electron/config.ts` | Loads ~/.claude-tui/config.json |
| `electron/workspace/discovery.ts` | Scans for workspace.json files |

### Renderer (React)

| File | Purpose |
|------|---------|
| `src/App.tsx` | Root layout, state management, keyboard shortcuts |
| `src/components/Sidebar.tsx` | Workspace + session lists, action buttons |
| `src/components/TabBar.tsx` | Session tabs, rename, close |
| `src/components/TerminalPane.tsx` | xterm.js terminal wrapper |
| `src/components/SplitView.tsx` | Side-by-side terminal panes |
| `src/components/StatusBar.tsx` | Bottom info bar |
| `src/components/PanelDrawer.tsx` | Sliding drawer — routes panel `type` to a component |
| `src/components/panels/*.tsx` | Panel components — Diff, Form, Image, Markdown, Table |
| `src/components/DropZone.tsx` | Drag-and-drop image overlay |
| `src/App.css` | All styles (design-token system at the top) |

## How to Add a New Feature

Every feature follows the same 4-step pattern. Example: adding a "pause session" feature.

### Step 1: Add to service

`electron/services/sessions.ts`:
```typescript
pause(id: string): boolean {
  const session = this.sessions.get(id)
  if (!session) return false
  session.state = "paused"
  this.sendToRenderer("session:paused", id)
  return true
}
```

### Step 2: Add IPC handler

`electron/ipc.ts`:
```typescript
ipcMain.handle("session:pause", (_e, id) => sessionService.pause(id))
```

### Step 3: Add MCP tool

`electron/mcp/tools.ts`:
```typescript
server.tool("pause_session", "Pause a session", {
  id: z.string().describe("Session ID"),
}, async ({ id }) => {
  const ok = sessions.pause(id)
  return { content: [{ type: "text", text: ok ? "Paused" : "Not found" }] }
})
```

### Step 4: Expose to renderer (if UI needed)

`electron/preload.ts`:
```typescript
pauseSession: (id: string) => ipcRenderer.invoke("session:pause", id),
```

`src/App.tsx` — add to Window.api type, add handler, wire to UI.

That's it. Service → IPC → MCP → Preload. Each is one function call or one object.

## Session Spawning

Sessions spawn Claude via shell wrapper for PATH resolution:
- Windows: `powershell.exe -NoLogo -NoProfile -Command claude --dangerously-skip-permissions --mcp-config {path}`
- macOS/Linux: `bash -l -c "claude --dangerously-skip-permissions --mcp-config {path}"`

The `--mcp-config` flag auto-connects Claude to the ClaudeTUI MCP server so Claude can control the app.

## MCP Server

- HTTP/SSE on random localhost port, started on app launch
- Config written to `{tmpdir}/claudetui/mcp-config.json`
- Each spawned Claude session gets `--mcp-config` pointing to this file
- Tools map 1:1 to service methods
- The server ships an `instructions` string (`SERVER_INSTRUCTIONS` in `electron/mcp/server.ts`) via the MCP initialize result. Claude Code surfaces this as an "MCP Server Instructions" block, so a freshly spawned session gets a map of the tool groups up front without having to load each (deferred) tool schema to discover them. Keep it in sync when adding tool groups.

### MCP Tools

Session/workspace tools map 1:1 to `SessionService` / `WorkspaceService` methods.
Additional tool groups:

**Panels** (`PanelService`):
- `show_panel` — show a `diff`, `image`, `markdown`, `table`, `test`, `chart`, `heatmap`, `tree`, `timeline`, `git`, `kanban`, `notes`, `stat`, `log`, `progress`, or `code` panel. `git` renders a `git_status` result (branch, ahead/behind, staged/unstaged files) plus optional `git_log` commits; `kanban` renders `{ columns: [{ title, color?, cards: [{ title, tag?, detail?, color? }] }] }` — grouped cards for status buckets / parallel workstreams; `notes` renders `{ title?, notes: [{ id, title, body, scope?, tags?, updatedAt? }] }` (markdown bodies) — but prefer the `show_notes` tool, which loads saved notes for you; `stat` renders `{ title?, stats: [{ label, value, unit?, delta?, trend?: 'up'|'down'|'flat', color?, hint? }] }` — a dashboard of big-number KPI cards (distinct from `chart`, which is for series viz); `log` renders `{ title?, lines: [string | { text, level?, time? }], showLevel? }` — a scrollable monospace log viewer with per-line severity coloring; `progress` renders `{ title?, steps: [{ label, status?: 'pending'|'active'|'done'|'error'|'skipped', detail? }], percent? }` — a vertical stepper with a progress bar for sequential task pipelines (distinct from `timeline`, which is chronological events); `code` renders `{ code, language?, filename?, startLine?, highlightLines?: number[], wrap? }` — a read-only code excerpt with gutter line numbers and per-line highlighting (distinct from `diff`, which compares two versions); `heatmap` renders `{ rows: number[][], xLabels?: string[], yLabels?: string[], title?, unit?, min?, max? }` — a color-coded 2D numeric matrix on a blue→green→amber→red ramp (correlation matrices, coverage grids, latency-by-hour). Note: the grid is `rows` (a 2D array), with `xLabels`/`yLabels` for the column/row headers — not `matrix`/`colLabels`/`rowLabels`.
- `show_form` — show an interactive form and **wait** for the user to submit; returns the field values (or `{ cancelled: true }`)
- `update_panel` / `hide_panel` / `hide_all_panels` / `list_panels`

**Testing/self-verification** (`AppService`):
- `take_screenshot` — capture the ClaudeTUI window as a PNG
- `get_app_state` — current window/session/workspace state for assertions
- `run_build` — build the project and return success/error output

**Notifications** (`NotificationService`):
- `notify` — show a toast (`info` / `success` / `warning` / `error`). Surfaces even when the calling session's terminal isn't focused — use it to announce task completion, request input, or report errors. Auto-dismisses after `timeout` ms (0 = sticky). Rendered by `ToastHost` (`src/components/ToastHost.tsx`).

**Session templates** (`TemplateService`):
- `list_session_templates` — list pre-configured session types (code review, debugging, frontend, planning)
- `create_session_from_template` — spawn a session from a template and seed its starter prompt once Claude boots

**Saved layouts** (`LayoutService`):
- `save_layout` / `list_layouts` / `restore_layout` / `delete_layout` — snapshot the open sessions (names + working dirs) to `~/.claude-tui/layouts.json` and recreate them on demand (e.g. to restore a working setup after an app restart). Only uses `SessionService.list()`/`create()` — no session-layer changes.

**Snippets** (`SnippetService`):
- `save_snippet` / `list_snippets` / `send_snippet` / `delete_snippet` — a library of reusable prompt snippets persisted to `~/.claude-tui/snippets.json`. Unlike templates (which spawn a new session), `send_snippet` injects text into an **existing** session's input via `SessionService.write()`.

**Broadcast** (`BroadcastService`):
- `broadcast_input` — the "synchronize panes" move: send the same text to every open session at once (or a subset via `session_ids`). `submit=true` appends Enter to actually run it; otherwise it just stages the text in each prompt. Fans out via `SessionService.write()` — no session-layer changes.

**Command runner** (`CommandService`):
- `run_command` — run a one-off shell command in a session's working directory and get structured output back (exit code, stdout, stderr, duration, `timedOut`). The general-purpose sibling of `run_build`/`run_tests`; output is captured (via `spawnSync`), not streamed — use a real session for long-running/interactive processes.

**Session activity / orchestration** (`SessionService`):
- A session is marked **active** while it produces terminal output and flips to **idle** after `idleThresholdMs` (1.5s) of quiet — i.e. Claude finished or is waiting for input. A shared 1s timer drives this and emits `session:state` events, which the renderer uses to animate the status dot (active = pulsing green, idle = steady yellow).
- `get_session_activity` — snapshot of every session's `state` and `idleMs` (ms since last output). Tells you at a glance which background session needs attention.
- `wait_for_session_idle` — block until a session's output goes quiet (it finished working) or `timeout_ms` elapses, then return its recent output. Optionally inject `input` first (with `submit` to press Enter) to delegate a task and wait for completion instead of polling. Injecting input resets the quiet clock, sidestepping the startup race before the session's first output.

**Clipboard** (`ClipboardService`):
- `write_clipboard` / `read_clipboard` — put text on the user's system clipboard (hand them a finished command, regex, or snippet to paste elsewhere) or read back what they just copied. Thin wrapper over Electron's `clipboard`.

**Shell** (`ShellService`):
- `open_external` — open a URL in the user's default browser (e.g. pop open a localhost dev server you just started) or other default app for the scheme.
- `reveal_path` — reveal a file/folder in the OS file manager (Explorer/Finder), selecting it. Thin wrapper over Electron's `shell`.

**Git** (`GitService`):
All tools resolve a working dir from `session_id` (falls back to the first open session, then the app cwd) and return structured JSON — no parsing raw terminal output.
- *Read:* `git_status` (branch, ahead/behind, staged vs. unstaged changes), `git_log` (recent commits), `git_diff` (optionally scoped to one file and/or `--staged`), `git_show` (drill into a single commit/`ref` — full metadata, the `--stat` summary, and the patch; defaults to HEAD), `git_blame` (line-by-line authorship of a file — commit/author/date/summary per line, optional `start_line`/`end_line` range), `git_file_history` (commit history for a single file, following renames — the per-file counterpart of `git_log`), `git_branches` (list local + remote-tracking branches: name, current, remote), `git_tags` (list tags newest-first, each resolved to its target commit — the release-marker counterpart of `git_branches`), `git_remotes` (configured remotes + their fetch/push URLs), `git_file_at_ref` (a file's content as it existed at any commit/`ref` — recover a prior version; defaults to HEAD), `git_search_log` (search commit messages repo-wide, `git log --grep`, case-insensitive by default).
- *Write:* `git_stage` / `git_unstage` (specific files or all), `git_commit` (`all` flag = `commit -a`; returns the new commit), `git_branch` (create + checkout), `git_checkout` (switch ref). Each returns the refreshed status so Claude sees the result immediately.
- *Remote/stash:* `git_push` (`--porcelain`), `git_pull` (`--ff-only`), `git_stash` / `git_stash_pop` / `git_stash_list`.

**File search** (`FileSearchService`):
All tools resolve a working dir from `session_id` (same fallback as Git) and return structured JSON. Pure-Node (no shell, cross-platform), skip `node_modules`/`.git`/build output, and are bounded so a search in a large repo never floods the response.
- `find_files` — find files by glob (`*`, `**`, `?`) matched against relative paths; returns paths + sizes (default cap 200).
- `grep_code` — search file contents by regex (falls back to literal match), optionally scoped to a `glob`, with `case_insensitive`; returns matching lines with file + line number, plus `filesScanned`/`truncated` (default cap 200 matches, skips files > 1MB and binaries).

**File I/O** (`FileService`):
Structured read/write scoped to a session's working dir (relative paths resolve against it; absolute paths allowed). The no-shell counterpart to `run_command` for file access; pairs with the file-search tools.
- `read_file` — read a file (optionally a 1-based inclusive `start_line`/`end_line` slice); returns the slice plus `totalLines` for paging. Refuses files > 2MB.
- `write_file` — write content to a file, creating parent dirs; overwrites if present. Returns resolved path, bytes written, and whether it was newly `created`.
- `diff_files` — open the interactive (review-enabled) diff panel comparing two files: `old_path` + `new_path` (two files on disk), `old_path` + `new_content` (preview a proposed rewrite), or just `new_path`/`new_content` (show as all additions). Unlike `git_diff` (tracked working-tree changes only) this compares any files. Reads via `FileService`, renders via the shared `DiffPanel` (so users can select hunks and send a review request).

**File editing** (`EditService`):
Surgical, in-place edits scoped to a session's working dir — the middle ground between `read_file` (whole-file read) and `write_file` (whole-file overwrite), so a small change doesn't risk clobbering the rest of the file. Same path resolution as the file-search/IO tools; no shell, no persistence; refuses files > 2MB.
- `replace_in_file` — exact-string replacement. By default `old_string` must occur exactly once (unambiguous); set `replace_all` to change every occurrence. Fails if `old_string` is missing, not unique (without `replace_all`), or equal to `new_string`. Returns resolved path, `replacements` count, and bytes written.
- `insert_in_file` — insert `content` before a 1-based `line` (a `line` <= 0 or past EOF appends at the end). Returns resolved path, the `line` inserted at, and bytes written.

**Network** (`HttpService` + `PortService`):
Probe the network without spawning `curl`/`netstat` and scraping output — structured JSON results. The dev-server workflow trio with `run_command`/`open_external`: launch a server, wait for its port, then hit it.
- `http_request` — make an HTTP(S) request (`method`/`headers`/`body`/`timeout_ms`) and get back `status`, `statusText`, `headers`, `contentType`, `body` (UTF-8, capped at 1MB), `bodyBytes`, `truncated`, and `durationMs`. Only http/https URLs; follows redirects.
- `download_file` — download a URL straight to disk (`path` resolves against the session's working dir or absolute, parent dirs created). The fetch-to-disk counterpart of `http_request` (inline body, 1MB cap): only writes on a 2xx response, follows redirects, enforces a 100MB cap (`max_bytes`). Returns resolved `path`, `bytesWritten`, `contentType`, `finalUrl`, and `durationMs`. Use for binary assets/release artifacts.
- `check_port` — single TCP connect to see if something is listening on `host:port` (default host `127.0.0.1`); returns `{ open, durationMs }`.
- `wait_for_port` — poll a port until it opens or `timeout_ms` elapses (`interval_ms` between attempts); returns `{ open, waitedMs, attempts }`. Use after launching a dev server to block until it's ready before `http_request`.

**Process** (`ProcessService`):
Find and kill OS processes without parsing `netstat`/`lsof`/`tasklist`/`ps` — structured JSON, cross-platform (Windows uses netstat/tasklist/taskkill, Unix uses lsof/ps/kill). The follow-up to the Network port checks: when `check_port` says a port is taken, reclaim it (the classic "EADDRINUSE on 3000, kill the zombie dev server" loop).
- `find_process_on_port` — resolve the process(es) listening on a TCP port; returns `{ port, platform, processes: [{ pid, name }] }`.
- `kill_process_on_port` — force-kill whatever is listening on a port; returns `{ port, platform, found, killed: [{ pid, name }], failed: [{ pid, name, error }] }`.
- `list_processes` — list running processes, optionally filtered by case-insensitive name substring; returns `{ platform, filter, processes: [{ pid, name }], truncated }` (capped at 200).
- `kill_process` — force-kill a process by PID; returns `{ pid, killed, error? }`.

**App UI control** (`UiService`):
Drive the same view actions a user triggers by keyboard/menu — so Claude can ask the app to, e.g., "enter focus mode". These are **renderer-only** view states (no service owned the data), so `UiService` bridges them: each tool calls a `UiService` method that emits a `ui:*` event the renderer listens for (mount-time listeners in `App.tsx`, registered via `preload.ts`). The boolean-toggle tools take an optional desired state; omit it to flip the current value.
- `set_focus_mode` — distraction-free mode (hides sidebar + tab bar). `enabled?`
- `toggle_panel_drawer` — collapse/expand the panel drawer. `collapsed?`
- `open_command_palette` — the Ctrl+Shift+P fuzzy action menu. `open?`
- `show_keyboard_shortcuts` — the Ctrl+/ shortcuts overlay. `open?`
- `open_history_search` — the Ctrl+Shift+F session-output search overlay. `open?`
- `export_session_log` — download a session's captured output as `.txt` (defaults to active session). `session_id?`
- `get_config` — read the current config (theme, default command/args, scan paths).

### How to add a renderer-only UI action to MCP

When a feature lives purely in React state (no service), expose it through `UiService` rather than inventing a service for it:
1. **UiService method** — add `setFoo(value?)` to `electron/services/ui.ts` that calls `this.emit("ui:foo", value)`.
2. **Preload listener** — add `onUiFoo` to `electron/preload.ts` (`ipcRenderer.on("ui:foo", ...)`, `?? undefined` so omitted = toggle).
3. **MCP tool** — add `server.tool("foo", ...)` in `electron/mcp/tools.ts` calling `ui.setFoo(...)`.
4. **Renderer wiring** — in `App.tsx`'s mount `useEffect`, register `window.api.onUiFoo(...)` to update React state, and add a `removeAllListeners("ui:foo")` to the cleanup. If the handler needs a fresh closure (like `export_session_log` does over `activeId`), stash it in a ref synced by its own effect.

**Mission orchestration** (`MissionService`):
The self-orchestration layer — a long-running goal driven by Claude but kept alive by code, so it survives context limits, usage limits, and restarts. Four roles:
- **Mission** — durable JSON state persisted to `~/.claude-tui/missions/<id>.json` (goal, autonomy, status, `tasks[]`, `workers[]`, `eventLog[]`). The source of truth; lives on disk, **not** in a Claude context window.
- **Conductor** — a Claude session that *is the brain*: loads the mission with `mission_status`, decomposes the goal, dispatches/reviews workers, commits, and loops until done. Stateless across restarts — a fresh Conductor resumes purely from `mission_status`.
- **Supervisor** — a code loop (`tick()` every 5s, started in `ipc.ts`) that guarantees a live Conductor: (re)spawns it for any `running` mission, reaps workers idle past `workerStallMs` (10 min) and requeues their tasks, and detects usage-limit output to `mission_pause` with a `resumeAt` backoff, then auto-resumes once it passes. **Code guarantees continuity; Claude provides intelligence.**
- **Workers** — Claude sessions spawned per task via `mission_dispatch`, awaited via `mission_await`.

Tools: `mission_create` (status `planning`), `mission_plan` (set tasks → `running`), `mission_dispatch`/`mission_await`/`mission_resolve` (drive one task), `mission_status` (the resume entry point — omit `mission_id` for the most-recently-updated active mission), `mission_list`, `mission_log`, `mission_pause`/`mission_resume`, `mission_stop` (kills workers + conductor), `mission_finish`. The `show_panel` `mission` type renders a live dashboard. Autonomy (`hands-off`/`checkpoints`/`supervised`) is surfaced to the Conductor via its seed prompt; the Conductor enforces checkpoints with `show_form`. Replaces the old `scripts/overnight-run.sh`.

## Panel System

Claude renders rich UI alongside terminals via panels. State flows:
**Claude → MCP tool → PanelService → IPC → React drawer** (`PanelDrawer`).

Panels live in a sliding drawer (right or bottom). `PanelDrawer` routes each
panel's `type` to a component in `src/components/panels/`. Users can also drag an
image onto the window (`DropZone`) to inject it into the active session.

Forms are special: `show_form` keeps the MCP call open (a pending promise in
`PanelService`). When the user submits, the renderer sends `panel:form-submit`
over IPC, which resolves the promise and returns the data to Claude.

### How to add a new panel type

1. **Component** — create `src/components/panels/FooPanel.tsx`; it receives the
   tool's `props` as React props.
2. **Route it** — add a `case "foo"` to `PanelContent` in `PanelDrawer.tsx`.
3. **Allow the type** — add `"foo"` to the `type` enum of `show_panel` in
   `electron/mcp/tools.ts` (no service change needed — `PanelService` is generic).
4. **Style** — add a `.foo-panel` block in `src/App.css` using the design tokens.

## Config

`~/.claude-tui/config.json`:
```json
{
  "workspaceScanPaths": ["~/workspaces/ws-*"],
  "defaultCommand": "claude",
  "defaultArgs": ["--dangerously-skip-permissions"],
  "theme": {
    "fontSize": 14,
    "fontFamily": "Cascadia Code",
    "background": "#0d1117",
    "foreground": "#c9d1d9"
  }
}
```

## Build

Uses electron-vite. Config in `electron.vite.config.ts`.

- Main + preload output CJS to `out/main/` and `out/preload/`
- Renderer output to `out/renderer/`
- Native modules (node-pty) and MCP SDK are externalized from the bundle

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+N | New session |
| Ctrl+K | Kill active session |
| Ctrl+H | Trigger handoff |
| Ctrl+\ | Toggle split panes |
| Ctrl+1-9 | Switch to session by index |
| Ctrl+P | Toggle (collapse/restore) the panel drawer |
| Escape | Close the most recently shown panel |

## Tech Stack

Electron, React, TypeScript, xterm.js, node-pty, @modelcontextprotocol/sdk, react-markdown, electron-vite
