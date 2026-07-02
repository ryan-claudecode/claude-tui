# ClaudeTUI

Cross-platform desktop app for managing multiple Claude Code sessions. Electron + React + xterm.js + MCP.

## Run

```bash
npm run dev    # build + launch
npm run build  # build only
npm start      # launch (requires prior build)
```

## Architecture

Three layers — service layer is the core, everything else is a thin adapter on top. Panels render **modal-by-default in the main window** (`ModalHost`); each panel has a pop-out button that moves it to the separate companion window.

```
┌────────────────────────────────────────────────┐
│  Main Renderer (React)     Companion Renderer  │
│  src/App.tsx               src/companion/      │
│  src/components/           (panels window)     │
├────────────────────────────────────────────────┤
│  IPC Handlers              MCP Tool Handlers   │
│  electron/ipc.ts           electron/mcp/       │
│  (one-line wrappers)       tools.ts            │
├────────────────────────────────────────────────┤
│           Service Layer (source of truth)       │
│  electron/services/terminals.ts                │
│  electron/services/sessions.ts                 │
│  electron/services/companion.ts                │
│  electron/services/workspaces.ts               │
├────────────────────────────────────────────────┤
│  node-pty    config.ts    workspace/discovery   │
└────────────────────────────────────────────────┘
```

## Key Files

### Electron (main process)

| File | Purpose |
|------|---------|
| `electron/main.ts` | App entry — creates frameless window, calls setupIpc |
| `electron/ipc.ts` | IPC handlers — thin wrappers calling services |
| `electron/preload.ts` | contextBridge — exposes API to main renderer |
| `electron/companion-preload.ts` | contextBridge — exposes API to companion window |
| `electron/services/terminals.ts` | **TerminalService** — runtime PTYs (create/kill/write/resize/rename), output capture, idle/activity state, conversation-id capture |
| `electron/services/sessions.ts` | **SessionService** — durable work-session *container*: terminal membership, notes/summary/context primer, resume/idle-flush/overview |
| `electron/services/companion.ts` | **CompanionService** — manages the companion BrowserWindow lifecycle, routes panel events |
| `electron/services/workspaces.ts` | **WorkspaceService** — workspace discovery + activation |
| `electron/services/workspaceMemory.ts` | **WorkspaceMemoryService** (CAPP-87) — the durable, workspace-level knowledge tier: one file per workspace (`~/.claude-tui/workspace-memory/<id>.json`, untagged "All" bucket via a `Symbol` sentinel), standing instructions + promoted/authored findings, idempotent `promoteFindings` (de-dup on the `(originSessionId, originNoteId)` pair), `loadAll` cache-warm at construction, `onMemoryChanged` seam |
| `electron/services/contextInspector.ts` | **ContextInspectorService** (CAPP-98/I1) — the READ-ONLY context inspector: `inspectWorkspaceContext(workspaceId)` enumerates the COMPLETE launch-time native context a fresh `claude` eats, by precedence — tier 0 managed policy (`C:\ProgramData\ClaudeCode\managed-settings.json` `claudeMd` on Windows), 1 `~/.claude/CLAUDE.md`, 2 user-global unconditioned `rules/*.md` (no `paths:` front-matter), 3 parent-chain CLAUDE.md (bounded at the git root, `claudeMdExcludes` ancestors marked `excluded`), 4 project memory (`F/CLAUDE.md`‖`F/.claude/CLAUDE.md`), 5 project unconditioned rules, 6 `F/CLAUDE.local.md`, 7 Claude native auto-memory (`<autoMemoryDir>/memory/MEMORY.md`, **GIT-ROOT-keyed** via `encodeProjectDir(gitToplevel(F))` — NOT F, the design's correctness fix) — PLUS tier 10, our injected primer rendered through the SAME truncating `buildInjectedContext` path the spawn uses (workspace tier only). Fidelity transforms strip block `<!-- -->` comments + collect `@import` lines OUTSIDE code fences (shown literally, NEVER expanded in v1). Absent tiers render a "none" placeholder (never omitted — the completeness claim depends on it). **INSPECT-ONLY: `existsSync`/`readFileSync`/`readdirSync` ONLY — NO write path into any native file.** `adopted`/`resolved`/`effective` are wired-but-undefined in v1 (E2 + later phases grow them without a contract change). Design: `docs/roadmap/claudemd-coexistence-design.md` §A |
| `electron/services/export.ts` | **ExportService** (CAPP-99/E1) — the EXPORT pillar of the CLAUDE.md coexistence layer: materializes the WORKSPACE tier (standing instructions + durable findings) into a USER-OWNED markdown file a raw `claude` outside the app can `@import`. **STRICTLY one-directional** (app JSON → file, NEVER read back — there is no file→store path anywhere). Built via the SHARED `buildWorkspacePrimerBody` (in `contextInject.ts`) so the inject and the export feed off ONE ordered finding set (pinned-first/active-oldest/ruled-out) — they can't drift. Format = the §B.1 identity-marker header (`<!-- mission-control:workspace-memory v1 workspace=<id> -->` — built by the shared `workspaceMemoryMarker(stem)` reused by the E2 adoption scan — + the "edits NOT read back" line) + the shared body. **Mode A (default, folder-bound):** `<F>/.claude-tui/workspace-memory.md`, **GITIGNORE-FIRST** — the `/.claude-tui/` `.gitignore` entry is written (CRLF-aware, idempotent, content-preserving) BEFORE the file lands; declining/failing → NO export (never an untracked file `git add -A` could grab). **Mode C:** any custom path (default `~/.claude-tui/exports/<id>/workspace-memory.md`), the ONLY mode for untagged/folderless (keyed on `UNTAGGED_STEM`, **default-OFF** + a machine-wide warning). Writes are atomic (temp-then-rename + Win EPERM retry), only-rewrite-if-changed, and REFUSE to overwrite a marker-less file (never stomp a user's hand-authored file). Live regen off `workspaceMemoryService.onMemoryChanged` (the listener CATCHES ITS OWN ERRORS — a bad export never crashes the mutation path) + `regenerateAll()` on launch (self-heals stale exports). Registry at `~/.claude-tui/exports.json` (the E2 Mode-C `selfWired` hint rides on each entry). Wired Service→IPC (`export:*`, `ipc/export-handlers.ts`)→preload (main + companion)→MCP (`export_workspace_memory`, identity-bound to the caller's OWNING session's workspace, never `getActiveId`). UI in the companion `WorkspaceMemoryPanel` Export section (statically visible, no hover-reveal: Mode A/C, a "Copy line" @import button, the untagged/folderless advisories). DEFERRED: Mode B (committed-in-folder, hard-blocked under `isolateWorkers`). Design: `docs/roadmap/claudemd-coexistence-design.md` §B/§D/§F (the E1 row) |
| `electron/services/adoption.ts` | **Adoption (CAPP-100/E2)** — the DOUBLE-LOAD reconcile + the reversible CLAUDE.local.md insert. **`detectAdoption(workspaceId, deps)`** is a FRESH (never cached) per-inject LITERAL marker scan (NO @import expansion) over the host CLAUDE-family files the inject already reads (`adoptionScanFiles`: `<F>/CLAUDE.md`, `<F>/CLAUDE.local.md`, the bounded parent-chain `CLAUDE.md` up to + incl. the git root, and `~/.claude/CLAUDE.md`); it matches THIS workspace's `workspaceMemoryMarker` OR our `mission-control:import` block delimiter (disambiguated by the workspace's import line) OR the export's advertised `@import` line (the "Copy line" manual paste). **DEFAULT-SAFE:** any read error / absence / a different workspace's marker → NOT adopted → the inject CARRIES the workspace tier (a wasted double-load is recoverable; silent missing context is worse). The Mode-C `selfWired` hint is the ONLY non-scan fallback. **Split-tiers** (in `contextInject.ts`): NOT adopted → inject = workspace + session (byte-unchanged from CAPP-97); ADOPTED → inject = session ONLY, but the workspace findings are STILL passed in to compute `promotedOriginKeys` so a promoted finding's origin note is suppressed from the session section (the twin rides the @import → shows exactly once). The launch stamp + the CAPP-97 delta both honor `adopted` (the adopted stamp has no workspace signatures; the delta never resurfaces the @import-delivered tier). **The reversible insert** (`wireImport`/`unwireImport`) is a SINGLE user-initiated MAIN-WINDOW action, **NOT MCP-exposed** (no agent → no concurrent-agent races): "Wire it in for me" appends ONLY a delimited `<!-- mission-control:import start/end -->` block to `<F>/CLAUDE.local.md` (CRLF-agnostic + EOL-preserving + idempotent; a read-modify-write CHANGE-GUARD aborts on a concurrent edit); "Unwire" removes our block but REFUSES on a user hand-edit inside the delimiters (only auto-removes a pristine block). Wired Service→IPC (`adoption:*`, `ipc/adoption-handlers.ts`)→preload (main + companion, NON-MCP)→UI in the `WorkspaceMemoryPanel` Export section (statically visible). The CAPP-98 inspector's tier #10 now self-attributes the adopted workspace portion ("delivered via your @import … de-duped") + sets `adopted` true (the `// TODO(E2)` is closed). Design: `docs/roadmap/claudemd-coexistence-design.md` §E + §B.5 + §F (the E2 row) |
| `electron/services/localHistory.ts` | **LocalHistoryService** (CAPP-95/D1) — the local data-loss net for the durable brain: a SEPARATE git repo at `~/.claude-tui/.local-history/` over a snapshot copy of the curated subset (`workspace-memory/` + `sessions/` only), committed on startup + debounced after each `onMemoryChanged`/session change (empty commits skipped; deletions captured via clear-then-mirror; git calls hardened against the user's global hooks/excludes/autocrlf); NEVER pushed (no remote, path-separated from the future sync repo); `flush()` on app `before-quit`; `list`/`restore` (strict `<sub>/<name>.json` guard, reloads the affected service cache). The local down-payment on the GitHub-sync pillar (`docs/roadmap/context-autoload-sync-design.md`) |
| `electron/services/panels.ts` | **PanelService** — panel state + form callbacks, routes to companion window |
| `electron/services/app.ts` | **AppService** — app-level ops (screenshot, app state, build) |
| `electron/services/ui.ts` | **UiService** — bridges renderer-only view actions (focus mode, palette, etc.) to MCP by emitting `ui:*` events |
| `electron/services/mission.ts` | **MissionService** — durable, on-disk orchestration missions + Supervisor loop (Conductor respawn, stalled-worker reaping, usage-limit pause/resume) |
| `electron/services/attention.ts` | **AttentionService** — the "who needs me?" queue: subscribes to panel/terminal/notification seams, applies the tiered one-entry-per-terminal policy, emits `attention:updated` snapshots, fires tier-1 toast + OS notification |
| `electron/services/scheduler.ts` | **SchedulerService** (CAPP-114 / SCHED-1) — on-device scheduled/recurring Claude runs (the fable-watch script as a feature): one-file-per-schedule at `~/.claude-tui/schedules/<id>.json`, a single unref'd 30s tick, overlap guard + `MAX_CONCURRENT_SCHEDULED=2` cap, launch catch-up (`catchUp:false` → `skipped-missed`; `catchUp:true` → left due so the CAPPED tick drains it — nothing spawns synchronously in `start()`), `fire()` spawns a structured terminal into a durable per-schedule work session (cwd chain: schedule cwd → the SCHEDULE's workspace dir → home) + delivers the prompt via the stdin sink, run records (ok/error/timeout/skipped-\*, ring of 50) + `maxRuntimeMs` reaper (kills ONLY its own terminal), tier-2 attention on error/timeout. fire()/tick() are per-item THROW-SAFE (production deps sit on fs/spawn paths that throw — one bad schedule must never starve the rest). All effects behind injected `SchedulerDeps` (fakes in tests). Design: `docs/roadmap/scheduler-design.md` |
| `electron/services/scheduleMath.ts` | Pure recurrence math (zero Electron imports): `computeNextRun` (interval anchored to last fire, window clipping incl. WRAP-AROUND midnight-straddling windows like 22:00–06:00, days filter, once→null), `isDue`, `describeNext` — the sidebar countdown derives from the same module as the ticker so they can't drift |
| `electron/services/stt.ts` | **SttService** (CAPP-120) — push-to-talk dictation: Parakeet-TDT-0.6b-v2 int8 via `sherpa-onnx-node` in an Electron **utility process** (`electron/stt/sttWorker.ts`, warm recognizer, ~270ms per utterance CPU-only), deps-injected (fork/download/extract/fs are fakes in tests). Model (~680MB, CC-BY-4.0) downloads on first enable to `~/.claude-tui/stt/` — sha256+byte-pinned, cancel/retry/force-re-download, abortable extract, temp-dir cleanup. RPC watchdogs (init 60s / transcribe 30s → teardown+respawn), 3-strike worker-fail ledger surfaced in `status()`. Composer 🎤 (`useDictation` + pure `src/lib/micInteraction.ts`): hold=push-to-talk, click=toggle, Ctrl+M, Esc discards (owns Esc over the agent-interrupt via `dictationEsc.ts`), 5-min cap, insert-at-cursor, never auto-submits. NO MCP tool. Whisper.cpp sidecar = documented fallback only |
| `electron/mcp/server.ts` | MCP HTTP/SSE server lifecycle |
| `electron/mcp/tools.ts` | MCP tool definitions — calls services |
| `electron/config.ts` | Loads ~/.claude-tui/config.json, theme mode read/write |
| `electron/workspace/discovery.ts` | Scans for workspace.json files |

### Renderer (React) — Main Window

| File | Purpose |
|------|---------|
| `src/App.tsx` | Root layout, state management, keyboard shortcuts |
| `src/App.css` | All styles — theme system (light/dark/cold-dark) at the top |
| `src/components/Sidebar.tsx` | Workspace + session lists, action buttons |
| `src/components/TabBar.tsx` | Pill tabs for terminals, window controls |
| `src/components/WindowControls.tsx` | Custom minimize/maximize/close buttons (frameless window) |
| `src/components/TerminalPane.tsx` | xterm.js terminal wrapper with restoring overlay |
| `src/components/SplitView.tsx` | Side-by-side terminal panes |
| `src/components/ModalHost.tsx` | In-main-window modal panel host (CAPP-109) — form-safe close paths, form-exclusive active panel, tab strip, pop-out button |
| `src/components/panels/PanelContent.tsx` | The ONE shared panel-type switch (CAPP-106) — rendered by both ModalHost and CompanionApp over the typed `PanelApi` (`src/lib/panelApi.ts`, parity-gated) |
| `src/components/panels/*.tsx` | Panel components — Diff, Form, Image, Markdown, Table, etc. |
| `src/components/DropZone.tsx` | Drag-and-drop image overlay |
| `src/lib/xtermThemes.ts` | xterm.js ITheme definitions for each theme mode |
| `src/lib/sessionRow.ts` | Pure view-model derivation for sidebar session rows |

### Renderer (React) — Companion Window

| File | Purpose |
|------|---------|
| `src/companion/index.html` | Companion window HTML entry |
| `src/companion/main.tsx` | Companion React bootstrap |
| `src/companion/CompanionApp.tsx` | Companion root — panel tabs + routing, window controls |

## How to Add a New Feature

Every feature follows the same 4-step pattern. Example: adding a "pause session" feature.

> Note: single-PTY operations (the `this.terminals` map) live in `electron/services/terminals.ts`; durable container ops live in `electron/services/sessions.ts`. The example below uses `terminals.ts`.

### Step 1: Add to service

`electron/services/terminals.ts`:
```typescript
pause(id: string): boolean {
  const terminal = this.terminals.get(id)
  if (!terminal) return false
  terminal.state = "paused"
  this.sendToRenderer("terminal:paused", id)
  return true
}
```

### Step 2: Add IPC handler

`electron/ipc.ts`:
```typescript
ipcMain.handle("terminal:pause", (_e, id) => sessionService.pause(id))
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
pauseSession: (id: string) => ipcRenderer.invoke("terminal:pause", id),
```

`src/App.tsx` — add to Window.api type, add handler, wire to UI.

That's it. Service → IPC → MCP → Preload. Each is one function call or one object.

> **IPC channel convention:** per-terminal (PTY) operations use the `terminal:*` channel namespace; durable work-session *container* operations use `worksession:*`. The renderer-facing JS accessor names (`createSession`, `onSessionData`, etc.) are kept stable for API continuity and deliberately do **not** track the channel namespace — only the wire strings follow the `terminal:*` / `worksession:*` split.

## Theme System

Three themes switched via `data-theme` attribute on `<html>`:
- `light` (default) — Sand & Stone warm cream/amber
- `dark` — Sand & Stone warm charcoal/amber
- `cold-dark` — legacy cold-navy/blue

CSS custom properties in `src/App.css` define each palette. Theme mode is persisted in `~/.claude-tui/config.json` under `theme.mode`. Switch via command palette (`Ctrl+Shift+P` → "Switch theme") or `window.api.setTheme(mode)`.

xterm.js terminal colors are defined in `src/lib/xtermThemes.ts` and applied reactively when the theme changes.

## Window

Frameless window (`frame: false`). Custom window controls (minimize/maximize/close) are inline in the TabBar component. The sidebar brand and tab bar empty space serve as drag regions (`-webkit-app-region: drag`). Interactive elements use `-webkit-app-region: no-drag`.

## Session Spawning

Sessions spawn Claude via shell wrapper for PATH resolution:
- Windows: `powershell.exe -NoLogo -NoProfile -Command claude --dangerously-skip-permissions --mcp-config {path}`
- macOS/Linux: `bash -l -c "claude --dangerously-skip-permissions --mcp-config {path}"`

The `--mcp-config` flag auto-connects Claude to the ClaudeTUI MCP server so Claude can control the app.

**Auto-restore on startup:** All persisted sessions and terminals are automatically restored in parallel on app launch. Each terminal gets a fresh PTY with `--resume <conversationId>` so Claude picks up the same conversation. A "Restoring session..." overlay shows on each terminal until its PTY connects.

**Headless engine (BO-1..BO-5) + input/permissions (BO-3) + the live engine switch (BO-4a):** `TerminalService.createHeadless` spawns `claude -p` with the stream-json transport (`HEADLESS_FLAGS` in `electron/services/streamProtocol.ts`) instead of an interactive PTY. **BO-4a wired the switch:** `create()` routes to `createHeadless` when the resolved engine is `structured` (config `rendering.engine`, set via `TerminalService.setEngine` from `ipc.ts` using `resolveRenderingEngine`). **CAPP-39 gate ④ flipped the DEFAULT to `structured`:** `resolveRenderingEngine`/`resolveEngine`/`TerminalService`'s engine field now resolve to structured **unless** config explicitly says `engine: "xterm"` (a hard cutover — solo-dev project, low risk). `xterm` is the opt-in legacy PTY path (byte-unchanged when selected); the per-terminal raw-view escape hatch (`setTerminalEngine` / the AgentView "Raw view" button) remains the per-terminal way back to xterm, and the command palette carries a rollback write-path ("Default new terminals to structured / to raw terminal (xterm)" → `config:set-rendering-engine`, persists + applies to the next-spawned terminal). The LIVE renderer fork is PER-TERMINAL — it keys on the backend-stamped `t.engine` field (`src/App.tsx` / `src/components/SplitView.tsx`) to pick `AgentView`+`AgentComposer`+`PermissionPrompt` vs `TerminalPane`, NOT a global config read (the BO-2 `agentViewFlag` dev gate is retired; `src/lib/renderingEngine.ts`'s `resolveEngine` is a kept-in-sync pure helper, not currently wired into the live fork). `list()`/`getActivity()` include headless terminals so broadcast/activity/mission-reaper see them. End-to-end live-verified against real `claude -p` — see `docs/spikes/bo4a-engine-switch.md`. Two halves of human↔agent I/O on the headless path:
- **Input** — `src/components/AgentComposer.tsx` (a multiline composer, Enter=send / Shift+Enter=newline, drop-to-attach images via `saveDroppedImage`) sends one structured `AgentUserMessage` via `window.api.sendAgentInput` → `agent:send-input` IPC → `TerminalService.sendAgentMessage` (the stdin sink). It never touches `writeToSession`/pty.write.
- **Permissions** — headless spawn adds `--permission-prompt-tool mcp__claudetui__approve_tool` (NOT `--dangerously-skip-permissions`). When a tool isn't pre-approved, Claude Code synchronously calls our `approve_tool` MCP tool (`electron/mcp/tools/permissions.ts`) and blocks. It attributes to the caller's terminal (identity token), `TerminalService.requestPermission` raises a tier-2 `asked` (via `markAwaitingPermission`) + pushes a `PermissionRequest` to the renderer's `PermissionPrompt` (`src/hooks/usePermissions.ts`), and blocks until the user Allow/Denies (`resolvePermission`). **Wire shapes are live-captured** in `docs/spikes/bo3-permission-prompt.md` + `permissionWire.fixtures.ts`: the tool receives `{ tool_name, input, tool_use_id }`; ALLOW MUST return `{"behavior":"allow","updatedInput":{…}}` (a bare allow is rejected and the tool is blocked); DENY is `{"behavior":"deny","message":"…"}`. "Always allow `<tool>`" persists to `<cwd>/.claude/settings.local.json` `permissions.allow` (honored by Claude Code's default setting sources next spawn); `--allowedTools` pre-approval skips the gate. If a terminal exits while a permission is pending, it's resolved as `deny("agent-exited")` so the MCP call never hangs.

**Slash commands + skills in the structured composer (BO-7 / CAPP-41):** going headless does NOT lose skills/commands — plain `claude -p` loads user + plugin skills, custom commands, subagents, MCP, and SessionStart hooks by default, and typed `/skill`/`/command` ALREADY expand end-to-end over the stdin sink (the BO-3 input path is exactly the shape Claude expects). BO-7 adds the picker UX + native routing on top:
  - **Init catalog** — the parser (`streamEvents.ts`) now retains the `init` event's `slash_commands` + `skills` arrays (added to the `init` `StreamEvent` + the `AgentCatalog` type in `streamProtocol.ts`). `TerminalService` stores them per headless terminal and exposes `getCatalog(id)` → `agent:catalog` IPC → `window.api.getAgentCatalog`. (Init arrives AFTER the first user message on the stream-json path, so the catalog is empty until the first turn.)
  - **`/`-autocomplete picker** — `src/components/AgentComposer.tsx` mounts `useSlashPicker` (`src/hooks/useSlashPicker.ts`) + `SlashCommandPicker.tsx`; pure model in `src/lib/slashCatalog.ts`. It sources the filterable list from the LIVE init catalog (pulled on mount + tracked off live `init` stream events), NOT a hardcoded set. Up/Down/Enter/Tab select, Esc dismisses; selecting inserts `/name ` (structured-only, since the composer only mounts for structured terminals).
  - **Built-in routing** — the `agent:send-input` intercept (`terminal-handlers.ts`) classifies input via the pure routing table in `electron/services/slashCommands.ts` BEFORE folding for stdin: native-mapped built-ins (`/config` → theme/config cycle, `/resume` → the Ctrl+Shift+H handoff) fire an existing app affordance via the `ui:slash-command` renderer event (`App.tsx` handler reuses `cycleTheme`/`handleHandoff`) instead of being sent to Claude; everything else (`/clear`, `/compact`, `/context`, skills, plugin skills, custom commands, prose) forwards UNCHANGED — the slash is preserved — so Claude expands it. `/model` is intentionally NOT routed here (owned by BO-6 / CAPP-40 — see the `BO-6 HOOK` comments in `slashCommands.ts` + `terminal-handlers.ts` + `App.tsx`). Hermetic e2e: `fakeStream.ts`'s canned init carries a sample catalog; `e2e/structured.spec.ts` covers the picker render + the `/config` native map.

## MCP Server

- HTTP/SSE on random localhost port, started on app launch
- Config written to `{tmpdir}/claudetui/mcp-config.json`
- Each spawned Claude session gets `--mcp-config` pointing to this file
- Tools map 1:1 to service methods
- The server ships an `instructions` string (`SERVER_INSTRUCTIONS` in `electron/mcp/server.ts`) via the MCP initialize result. Claude Code surfaces this as an "MCP Server Instructions" block, so a freshly spawned session gets a map of the tool groups up front without having to load each (deferred) tool schema to discover them. Keep it in sync when adding tool groups.

### MCP Tools

Session/workspace tools map 1:1 to `SessionService` / `WorkspaceService` methods.
Additional tool groups:

**Panels** (`PanelService` → ModalHost, pop-out via `CompanionService`):
Panels render **modal-by-default in the main window** (the `ModalHost`); the user can pop any panel out to the separate companion window (its `surface` flips `"modal"` → `"window"`). `PanelService` routes every panel event to the main-window mirror and ALSO to the companion for popped-out panels; `CompanionService` manages the companion `BrowserWindow` lifecycle (created only on pop-out, placement clamped to the display work area).
- `show_panel` — show a `diff`, `image`, `markdown`, `table`, `test`, `chart`, `heatmap`, `tree`, `timeline`, `git`, `kanban`, `notes`, `stat`, `log`, `progress`, or `code` panel in the companion window. `git` renders a `git_status` result (branch, ahead/behind, staged/unstaged files) plus optional `git_log` commits; `kanban` renders `{ columns: [{ title, color?, cards: [{ title, tag?, detail?, color? }] }] }` — grouped cards for status buckets / parallel workstreams; `notes` renders `{ title?, notes: [{ id, title, body, scope?, tags?, updatedAt? }] }` (markdown bodies) — but prefer the `show_notes` tool, which loads saved notes for you; `stat` renders `{ title?, stats: [{ label, value, unit?, delta?, trend?: 'up'|'down'|'flat', color?, hint? }] }` — a dashboard of big-number KPI cards (distinct from `chart`, which is for series viz); `log` renders `{ title?, lines: [string | { text, level?, time? }], showLevel? }` — a scrollable monospace log viewer with per-line severity coloring; `progress` renders `{ title?, steps: [{ label, status?: 'pending'|'active'|'done'|'error'|'skipped', detail? }], percent? }` — a vertical stepper with a progress bar for sequential task pipelines (distinct from `timeline`, which is chronological events); `code` renders `{ code, language?, filename?, startLine?, highlightLines?: number[], wrap? }` — a read-only code excerpt with gutter line numbers and per-line highlighting (distinct from `diff`, which compares two versions); `heatmap` renders `{ rows: number[][], xLabels?: string[], yLabels?: string[], title?, unit?, min?, max? }` — a color-coded 2D numeric matrix on a blue→green→amber→red ramp (correlation matrices, coverage grids, latency-by-hour). Note: the grid is `rows` (a 2D array), with `xLabels`/`yLabels` for the column/row headers — not `matrix`/`colLabels`/`rowLabels`. The `worktree-review` type (WW-2b) renders an isolated mission worker's captured diff with Approve/Reject buttons — it's normally opened by the renderer from the attention queue (not driven directly by Claude); see the Worktree review note under Mission orchestration.
- `show_form` — show an interactive form in the companion window and **wait** for the user to submit; returns the field values (or `{ cancelled: true }`)
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

**Broadcast** (`BroadcastService`):
- `broadcast_input` — the "synchronize panes" move: send the same text to every open session at once (or a subset via `session_ids`). `submit=true` appends Enter to actually run it; otherwise it just stages the text in each prompt. Fans out via `SessionService.write()` — no session-layer changes.

**Session activity / orchestration** (`SessionService`):
- A session is marked **active** while it produces terminal output and flips to **idle** after `idleThresholdMs` (1.5s) of quiet — i.e. Claude finished or is waiting for input. A shared 1s timer drives this and emits `terminal:state` events, which the renderer uses to animate the status dot (active = pulsing green, idle = steady yellow).
- `get_session_activity` — snapshot of every session's `state` and `idleMs` (ms since last output). Tells you at a glance which background session needs attention.
- `wait_for_session_idle` — block until a session's output goes quiet (it finished working) or `timeout_ms` elapses, then return its recent output. Optionally inject `input` first (with `submit` to press Enter) to delegate a task and wait for completion instead of polling. Injecting input resets the quiet clock, sidestepping the startup race before the session's first output.

**Attention queue** (`AttentionService` in `electron/services/attention.ts`):
The "who needs me?" surface — a single, ordered, priority-tiered list of everything waiting on the user, distinct from raw per-session idle/active. The service is the source of truth; it subscribes to existing seams (a pending `show_form` → tier-1 `blocked`; a terminal going idle with a detected input-prompt → tier-2 `asked`, or after a sustained burst → tier-3 `finished`; an attributed error/warning toast → tier-2 `error`), applies a one-entry-per-terminal tier policy (higher tier replaces, `since` preserved so the wait clock stays honest), and emits `attention:updated` snapshots to the renderer. Tier-1 enqueues also raise an in-app toast and — when the main window is unfocused and `attention.osNotifications` (config, default `true`) allows — a Windows native notification whose click focuses the app and fires `attention:jump` to that entry.
- The renderer (`src/hooks/useAttention.ts` + the "NEEDS YOU (n)" Sidebar section) is a thin view: it renders the snapshot as tier-tinted two-line rows (name / `reason · wait`), pinned above WORKSPACES and absent when the queue is empty. Clicking a row (or `Ctrl+J` for the top entry) focuses that session+terminal and sends `attention:seen` (clears its tier-2/3 entries; tier-1 clears only when the form resolves). Hover reveals a dismiss ×.
- `get_attention_queue` — read-only ordered snapshot (lets a Conductor see if the human is already backed up before raising another checkpoint).
- `request_attention` — put yourself on the queue as a tier-2 `asked` entry (`reason`, plus `session_id`/`terminal_id` defaulting to the caller's identity) when you're blocked on the user but didn't raise a form.

**Scheduler** (`SchedulerService` in `electron/services/scheduler.ts`):
On-device scheduled/recurring Claude runs — set up a recurring watch ("check X every 20 minutes between 08:00 and 22:00") or a one-shot future run; each fire spawns a headless structured terminal into the schedule's durable work session on this machine (full native toolset — web, git, local MCP — unlike cloud scheduling). Recurrence kinds: `interval` (everyMinutes + optional local time window, wrap-around supported + days), `daily` (at HH:mm + days), `once` (ISO datetime).
- `schedule_create` / `schedule_list` / `schedule_update` (enable/disable/edit; "" clears cwd/model/effort) / `schedule_delete` / `schedule_run_now` — identity-bound: `workspace_id` defaults to the CALLER's owning session's workspace, never `getActiveId`. Run history rides the schedule snapshot.
- UI: the `SCHEDULED` sidebar section (statically-visible ⏸/▶ + run-now controls, 30s countdown via `describeNext`), create/edit overlay (MissionPrompt pattern), `schedule:updated`/`removed` push → `src/hooks/useSchedules.ts`. Pure row helpers in `src/lib/scheduleRow.ts`.

**Clipboard** (`ClipboardService`):
- `write_clipboard` / `read_clipboard` — put text on the user's system clipboard (hand them a finished command, regex, or snippet to paste elsewhere) or read back what they just copied. Thin wrapper over Electron's `clipboard`.

**Shell** (`ShellService`):
- `open_external` — open a URL in the user's default browser (e.g. pop open a localhost dev server you just started) or other default app for the scheme.
- `reveal_path` — reveal a file/folder in the OS file manager (Explorer/Finder), selecting it. Thin wrapper over Electron's `shell`.

**Git — read-only** (`GitService`):
All tools resolve a working dir from `session_id` (falls back to the first open session, then the app cwd) and return structured JSON — no parsing raw terminal output. Read-only by design: write-side git (stage/commit/push/branch/stash) is deliberately **not** exposed — that plumbing belongs to the agent's own shell (see `docs/roadmap/00-identity.md`).
- `git_status` (branch, ahead/behind, staged vs. unstaged changes), `git_log` (recent commits), `git_diff` (optionally scoped to one file and/or `--staged`), `git_show` (drill into a single commit/`ref` — full metadata, the `--stat` summary, and the patch; defaults to HEAD), `git_blame` (line-by-line authorship of a file — commit/author/date/summary per line, optional `start_line`/`end_line` range), `git_branches` (list local + remote-tracking branches: name, current, remote).

**Diff panel** (`FileService` → `PanelService`):
- `diff_files` — open the interactive (review-enabled) diff panel comparing two files: `old_path` + `new_path` (two files on disk), `old_path` + `new_content` (preview a proposed rewrite), or just `new_path`/`new_content` (show as all additions). Unlike `git_diff` (tracked working-tree changes only) this compares any files. Reads via `FileService` (the only surviving `FileService` method), renders via the shared `DiffPanel` (so users can select hunks and send a review request). Paths resolve against a session's working dir (or absolute).

**App UI control** (`UiService`):
Drive the same view actions a user triggers by keyboard/menu — so Claude can ask the app to, e.g., "enter focus mode". These are **renderer-only** view states (no service owned the data), so `UiService` bridges them: each tool calls a `UiService` method that emits a `ui:*` event the renderer listens for (mount-time listeners in `App.tsx`, registered via `preload.ts`). The boolean-toggle tools take an optional desired state; omit it to flip the current value.
- `set_focus_mode` — distraction-free mode (hides sidebar + tab bar). `enabled?`
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

Tools: `mission_create` (status `planning`), `mission_plan` (set tasks → `running`), `mission_dispatch`/`mission_await`/`mission_resolve` (drive one task), `mission_status` (the resume entry point — omit `mission_id` for the most-recently-updated active mission), `mission_list`, `mission_log`, `mission_pause`/`mission_resume`, `mission_stop` (kills workers + conductor), `mission_finish`. The `show_panel` `mission` type renders a live dashboard in the companion window. Autonomy (`hands-off`/`checkpoints`/`supervised`) is surfaced to the Conductor via its seed prompt; the Conductor enforces checkpoints with `show_form`. Replaces the old `scripts/overnight-run.sh`.

**Missions sidebar surface (MS-2):**
Active missions appear in a `MISSIONS (n)` sidebar section between NEEDS YOU and WORKSPACES, absent when empty. Rows are two-line: goal excerpt + status chip (line 1), `done/total tasks` + thin progress bar + worker count (line 2). Primary click opens the mission dashboard panel and clears the mission's attention entry. On hover: a conductor icon (→ focuses the Conductor session) and — for terminal-state rows (done/blocked/stopped) — a × to dismiss the row renderer-side. The section header `+` opens the MissionPrompt overlay. State flows from `MissionService.onEvent` → `ipc.ts` push → `mission:updated` IPC channel → `src/hooks/useMissions.ts` (seeds via `listMissions()` on mount, upserts on push, renderer-side dismissed-ids Set for terminal-state rows). `MissionsList` and the open mission dashboard panel both refresh from the same push data — no polling intervals. Attention entries with `missionId` route their `jumpTo` to the dashboard panel (not a terminal). Pure row helpers live in `src/lib/missionRow.ts`.

**Worktree-isolated workers + review (WW-2):**
Opt-in per mission (`isolateWorkers`, default off): each worker spawns into a private git worktree/branch (WW-1 `WorktreeService` + WW-2a `MissionService`), and a resolved-done task enters `awaiting-review` instead of finishing — its captured diff is gated until the user approves (merge `--no-ff`; clean → `done`, conflict → `merge-conflict` with the branch preserved, **never auto-resolved**) or rejects (discard worktree+branch, task back to `pending`). The backend (frozen) lives in `MissionService.approveTask`/`rejectTask`/`reviewQueue` and the `mission_approve_task`/`mission_reject_task`/`mission_review_queue` MCP tools; `AttentionService` raises a tier-1 `review:<missionId>:<taskId>` entry (carrying `missionId` + `taskId`) for each awaiting-review task, reconciled purely from mission snapshots.
- **Review UX (WW-2b):** clicking a review attention entry opens the `worktree-review` companion panel (`src/components/panels/WorktreeReviewPanel.tsx`) for that mission+task. App.tsx's `jumpToReviewRef` (mirrors `jumpToMissionRef`) fetches the latest captured diff via the `worktree:get-review-task` IPC, then `show_panel`s it. The panel reuses `DiffPanel` by parsing the captured unified-diff string into `{ path, oldContent, newContent }[]` (`src/lib/unifiedDiff.ts`, with a small test), so the diff stays hunk-selectable. **Approve & merge** / **Reject** (inline reason) call the `worktree:approve` / `worktree:reject` IPC (invoke, returning the resulting `{ status, reviewReason }` so the panel reflects merged/conflict/rejected inline). A merge conflict displays the preserved-branch conflict summary with a Discard (reject) option — no resolution UI. The mission dashboard panel shows `awaiting-review` (amber) and `merge-conflict` (red) task chips distinctly. Companion approve/reject accessors live on `companionApi`; the main-window `getReviewTask`/`approveWorktreeTask`/`rejectWorktreeTask` live on `window.api`.

**Work sessions / context engine** (`SessionService` in `electron/services/sessions.ts` — the durable *container*):
A two-tier model sits beneath the terminals: a **work session** is a durable container (persisted to `~/.claude-tui/sessions/<id>.json`) that groups many **terminals** (runtime PTYs owned by `TerminalService` in `terminals.ts`) and accumulates knowledge that outlives any single terminal. Tools: `create_work_session` / `list_work_sessions` / `work_session_status`, `register_terminal`, `set_terminal_activity`, `session_note` (pass `corrects` to supersede a wrong note), `set_session_summary`, `get_session_context` (the primer a fresh terminal reads to inherit summary + findings + ruled-out). Spawned terminals bind identity via the SSE URL (`?sid=&tid=`) so these tools default to the caller's own ids. Resume-fidelity features layered on top:
- **Conversation resume** — when a terminal spawns, `SessionService` watches the Claude transcript dir (`~/.claude/projects/<encoded-cwd>/`) and records the terminal's `ccConversationId` (via a `convo` event from `TerminalService`). On app restart, all terminals auto-restore via `reopenTerminal`, which passes `--resume <id>` so Claude lands back in the same chat. If the transcript is gone, it falls back to a fresh primed terminal that still inherits state via `get_session_context`.
- **Idle-flush summary** — when a terminal goes idle with unsaved findings (`summaryDirty`), after a grace period it gets a bracketed-paste prompt asking it to refresh the summary via `set_session_summary` (debounced to ≥60s between flushes), so a fresh terminal inherits the latest progress.
- **Parsed-activity fallback** — `effectiveActivity` prefers a terminal's fresh self-reported `set_terminal_activity` (<20s old); otherwise it parses the last tool-call line (`● Edit(...)`) from terminal output, so heads-down terminals still show live activity in the sidebar instead of going stale.
- **Session Overview panel** — the `session-overview` `show_panel` type (and `getOverview`) renders a bird's-eye view of a session in the companion window: summary, active findings, ruled-out (with corrections), provisional findings (observer seam), and terminals with effective activity. The ⊕ button on a session in the sidebar opens it.
- **Ctrl+Shift+H handoff** — "retire & continue": `handoffTerminal` force-flushes the summary, spawns a fresh terminal in the same session, and retires the old one — useful when a terminal's context fills up. (Not plain Ctrl+H, which is ASCII Backspace and would shadow the terminal's own backspace.)

**Workspace Memory — the second durable tier (CAPP-87):** a per-workspace store (`WorkspaceMemoryService`, above) that survives ALL session deletion, so the "brain" a fresh agent inherits is **workspace memory ∪ live session findings**. `RecallService` is a UNION of both (`electron/services/recall.ts` `deriveRecallIndex(sessions, memoryFindings)`), de-duped exactly-once on the `(originSessionId, originNoteId)` pair (the live origin note is suppressed from the index — never disk — when a promoted twin exists); `summary()` counts the memory tier in its own digest and surfaces a third "Workspace memory" group in the Agent Rail KNOWS section. The bridge is **promotion**: a session finding graduates UP to its OWNING session's workspace (never the caller's / the active selection). Two promote paths, both atomic + idempotent: **delete-time** (`KillSessionModal`, `src/components/KillSessionModal.tsx` — Ctrl+K / sidebar ✕ open a blocking main-window modal: **Keep & delete** promotes the dying session's findings, defaulting to all with a trim/edit list, via `worksession:kill-with-promote`; **Delete everything** = today's `killSession`, NOT the transcript; **Cancel**), and **"Push context to workspace"** on the SessionOverview panel (`worksession:promote-to-workspace`). The user curates memory directly in the **`workspace-memory` companion panel** (`src/components/panels/WorkspaceMemoryPanel.tsx` — editable instructions + per-finding Edit/Delete + Add; PINNED-target write path: captures the workspaceId at open, never re-derives from the active workspace; live-refreshes off `workspace:memory-changed`, which `ipc.ts` pushes to BOTH the main and companion windows), opened from the WorkspaceSwitcher "Workspace memory" button. Agent-facing MCP tools: `get_workspace_memory`, `add_workspace_memory`, `set_workspace_memory_context`, `promote_finding` (`electron/mcp/tools/workspaces.ts`) — destination resolves to the caller's bound (or, for promote, the note's OWNING) session's workspace, NEVER `getActiveId`; an untagged session writes the global "All" bucket. The untagged bucket is a deliberate global, cross-project scope; workspace memory is NOT a confidentiality boundary (knowing a workspace uuid grants read+write — fine for a single-user app). Design + plan: `docs/roadmap/context-engine-design.md` §8 + `docs/roadmap/CAPP-87-workspace-memory-plan.md`. **Renderer-side type mirrors** (`src/lib/killSessionPromote.ts` `PromoteEntry`, `src/lib/workspaceMemoryView.ts` record/finding) exist because the canonical `workspaceMemory.ts` imports `node:fs`; compile-time parity pins (`electron/services/promoteEntrySync.test.ts`, `workspaceMemoryViewSync.test.ts`) fail the build on drift.

**Pinning + the launch-delta (CAPP-97):** two halves layered on the CAPP-96 auto-load brain. **(1) Pinned in the editor** — `WorkspaceMemoryService.setPinned(workspaceId, findingId, pinned)` (idempotent; stores `pinned:true`, drops the key on unpin; routes through `persistAndEmit`) is surfaced by a STATICALLY-VISIBLE per-row Pin toggle in `WorkspaceMemoryPanel.tsx` (`.wmem-pin`, NO hover-reveal — a pinned finding renders 📌 + an accent edge). Wired Service→IPC (`workspace:set-pinned`)→preload (`setWorkspaceFindingPinned`, main + companion)→MCP (`pin_workspace_finding`, identity-bound to the caller's OWNING session's workspace, never `getActiveId`). A pinned finding is the ONLY thing never evicted under the 8 KB auto-load cap (`renderWorkspaceFinding`). **(2) get_session_context DELTA** — once the brain is PUSHED at spawn, a later `get_session_context` returning the full primer re-loads the same bytes. So `contextInject.ts` adds `assembleInjectInput` (the single assembly point both the inject payload AND the delta read), `computeContextStamp` (a per-terminal launch snapshot: finding signatures + summary/instructions) and `buildContextDelta` (only new/edited/ruled-out findings + a changed summary, else a stable "No durable changes since launch" header). The stamp is recorded per-terminal in `SessionService.launchStamps` (in-memory, keyed by the SAME terminalId the inject wrote `<tid>.md` under) by the `setContextBuilder` closure in `ipc.ts` on a FRESH spawn; `get_session_context` passes `identity.terminalId` so `getContext(sessionId, terminalId)` returns the delta. **Degrades safely:** no stamp (xterm legacy, inject disabled, resume pointer, restored/pre-existing terminal) → the FULL primer, byte-identical to pre-CAPP-97. The delta's current input comes from `SessionService.setInjectInputResolver` (installed in `ipc.ts` with the same deps), so the stamp diff can never drift from the inject shape.

**Context Inspector v1 (CAPP-98 / I1 — the READ relationship of the coexistence layer):** a READ-ONLY introspection surface that shows the COMPLETE launch-time native context a fresh `claude` eats in a workspace + our injected primer, by precedence. Backend = `ContextInspectorService` (above), wired Service→IPC (`context:inspect`, in `workspace-handlers.ts`)→preload (`inspectWorkspaceContext`, main + companion)→MCP (`inspect_workspace_context` in the workspaces tool group, identity-bound to the caller's OWNING session's workspace, never `getActiveId`). The companion panel `context-inspector` (`src/components/panels/ContextInspectorPanel.tsx`, READ-ONLY, modeled on `SessionOverviewPanel` — collapsible per-tier sections, "none" placeholders, "excluded"/`@import`-count badges, a verbatim honesty header, a STATICALLY-VISIBLE Refresh button that re-invokes `context:inspect`; data is static seed props, NO live-refresh). Opened from an always-visible 📄 "Context" icon button in the WorkspaceSwitcher's consolidated control row (CAPP-122: `.wsctl-context`, a muted compact icon next to the 🧠 memory button `.wsctl-memory`, NO hover-reveal; `App.tsx` `handleOpenContextInspector` captures the workspaceId at click time). Renderer-side type mirror `src/lib/contextInspectorView.ts` (the canonical `contextInspector.ts` imports `node:fs`); compile-time parity pin `electron/services/contextInspectorViewSync.test.ts` fails the build on drift. **Deferred (E2 + later):** `@import` expansion, the merged/effective view, and tier #10 adoption-awareness ("delivered via your @import, not our flag") — `// TODO(E2)` left in `injectedPrimerSource`. Design: `docs/roadmap/claudemd-coexistence-design.md` §A; phasing §F (I1 row).

## Panel System — ModalHost (main window) + pop-out companion

Claude renders rich UI via panels that appear **modal-by-default in the MAIN window** (CAPP-109). State flows:
**Claude → MCP tool → PanelService → main bridge IPC → `ModalHost`** (`src/components/ModalHost.tsx`, mounted in `App.tsx`).

Both windows render the same panels through the **shared `PanelContent` switch** (`src/components/panels/PanelContent.tsx`) over a typed **`PanelApi`** (`src/lib/panelApi.ts`) — a compile-time parity test asserts BOTH `window.api` and `window.companionApi` satisfy it, so a panel works identically on either surface. The ModalHost has a focus-trapped dialog with a top bar (title + **⤢ pop-out** + ×), a tab strip when several panels are open, and a **form-exclusive active-panel rule** (`src/lib/modalActivePanel.ts`): a pending form always wins the active slot so it can never be buried.

**Pop-out (CAPP-110):** the ⤢ button calls `panel:pop-out` → `PanelService.popOut(id)` flips the panel's `surface` to `"window"`, hands it to the **companion window** (lazily created; placement clamped on-screen via `companionPlacement.ts` — CAPP-105), and drops it from the main mirror WITHOUT cancelling a pending form. The companion keeps its own pill tab bar. Closing the companion reconciles state (`dismissWindowPanels`): popped-out forms resolve `{cancelled:true}`, window panels drop, and nothing can resurrect the closed window — broadcasts like `hide_all_panels` use the NON-CREATING `sendIfOpen` (CAPP-116); only `popOut` may create it.

**Chat → panel trigger (CAPP-111):** blocks in the structured chat are NOT click-to-open; each expandable block (assistant/tool/result/raw) has a statically-visible top-right expand button (`BlockExpandButton`, settled-gated on assistant blocks) that opens the block's detail panel in the ModalHost.

**Panel presence indicator (PP):** the main window's `usePanels` hook tracks open panels (`panel:show`/`update`/`hide` IPC) and exposes a `recentlyChanged` pulse flag (set on show/update, cleared after ~1.2s). When panels are open, `TabBar` shows a quiet pill near the window controls with the open count; it pulses on open/update and clicking it calls `companion:focus` IPC → `CompanionService.focusIfOpen()`. Live-refresh matching (mission dashboard + session overview panels) uses `props.id` instead of a panel-id prefix, because panels have auto-generated `panel-N` ids.

Forms are special: `show_form` keeps the MCP call open (a pending promise in
`PanelService`). Submitting (from the modal or a popped-out companion form) resolves the promise and returns the data to Claude; EVERY close path — modal backdrop/Escape/×/tab-close, `hide_panel`, `hide_all_panels`, companion-window close — resolves a pending form as `{cancelled:true}` so the MCP call never hangs.

### How to add a new panel type

1. **Component** — create `src/components/panels/FooPanel.tsx`; it receives the
   tool's `props` as React props.
2. **Route it** — add a `case "foo"` to the ONE shared `PanelContent` switch (`src/components/panels/PanelContent.tsx`) — both the ModalHost and the companion render through it.
3. **Allow the type** — add `"foo"` to the `type` enum of `show_panel` in
   `electron/mcp/tools.ts` (no service change needed — `PanelService` is generic).
4. **Style** — add a `.foo-panel` block in `src/App.css` using the design tokens (shared by both windows).

## Config

`~/.claude-tui/config.json`:
```json
{
  "workspaceScanPaths": ["~/workspaces/ws-*"],
  "defaultCommand": "claude",
  "defaultArgs": ["--dangerously-skip-permissions"],
  "theme": {
    "mode": "light",
    "fontSize": 14,
    "fontFamily": "Cascadia Code"
  }
}
```

`theme.mode` controls the CSS theme (`"light"` | `"dark"` | `"cold-dark"`). Per-field overrides (`fontSize`, `fontFamily`) take precedence over theme defaults.

**`models` (optional, CAPP-113)** — the never-stale model-picker block: `{ "default"?, "extra"?: string[], "hidden"?: string[], "xhigh"?: string[] }`. Claude Code exposes NO dynamic model discovery, so this is the no-code-edit recovery path when new models ship. Picker list = (`MODEL_ALIASES` ∪ `extra`) − `hidden` (`resolveModelOptions` in `streamProtocol.ts`); `default` overrides the spawn-default for NEW terminals (an explicit `rendering.model` still wins); `xhigh` additively marks models as xhigh-capable for ultracode gating (`modelSupportsXhigh`). A model typed into the picker's statically-visible "Custom…" entry is persisted into `extra` after a successful switch and pushed live to open windows via `config:models-changed`. The headless `init` event's RESOLVED model id is captured per terminal (`resolvedModel`) and shown as the picker tooltip.

## Build

Uses electron-vite. Config in `electron.vite.config.ts`.

- Main output CJS to `out/main/`
- Two preloads (main + companion) output CJS to `out/preload/`
- Two renderers (main + companion) output to `out/renderer/`
- Native modules (node-pty) and MCP SDK are externalized from the bundle

## Testing

Two suites, deliberately kept separate:

- **`npm test`** — the unit/integration suite (Vitest, `*.test.ts` under `electron/` +
  `src/`). 276 tests, hermetic (no real PTYs/claude spawns), fast. This is the gate.
- **`npm run e2e`** — the Playwright **Electron smoke suite** (`e2e/*.spec.ts`, config in
  `playwright.config.ts`). Builds first (`npm run build`), then launches the *built* app via
  `_electron.launch({ args: ["."] })` and asserts the shell renders (sidebar brand + empty-state
  affordances). NOT part of `npm test` — Vitest's `include` glob excludes `e2e/`, so it can
  never destabilize the unit gate.

  **Hermetic by USERPROFILE override:** the spec launches Electron with `env.USERPROFILE` set
  to a fresh `mkdtemp` dir. The app reads all persisted state from `os.homedir()` (which on
  Windows follows `USERPROFILE`), so `~/.claude-tui` is empty → no session auto-restore → **no
  real `claude.exe` spawns**. No production code changes, no user data touched. The temp home
  + Electron instance are torn down in `afterEach` (always, even on failure) — no leaks.
  - Two Windows-specific launch details: (1) `@playwright/test` is installed with
    `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` (Electron testing uses the app's own electron binary via
    `_electron`, not chromium); (2) the launch passes `--user-data-dir=<tempHome>/electron-data`
    because Chromium crashes during window creation (STATUS_BREAKPOINT) when `USERPROFILE` is
    overridden but its disk/GPU cache can't initialize under the real profile — pointing the
    cache inside the temp home fixes it (and keeps it hermetic). Note Electron's
    `app.getPath("home")` does NOT follow the override, but the app uses `os.homedir()`, which does.

## Packaging

Distributable Windows builds via **electron-builder** (config in `electron-builder.yml`).
Both scripts run `npm run build` first to refresh `out/`, then package into `dist/`
(gitignored — never commit artifacts).

- `npm run package` — `electron-builder --win dir`. Produces the unpacked tree
  `dist/win-unpacked/ClaudeTUI.exe` (no installer). Fast; use this to validate a build.
- `npm run package:installer` — `electron-builder --win nsis`. Produces the NSIS installer.
  May download nsis resources on first run, so it's heavier than `--win dir`.

Key config notes:
- **`asarUnpack: ["**/node_modules/node-pty/**"]`** — node-pty is a native module whose
  `.node` binaries + helper exes (`winpty-agent.exe`, `OpenConsole.exe`, `conpty.dll`) must
  live OUTSIDE the asar or PTY spawning breaks in the packaged app. They land under
  `dist/win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/`.
- **`npmRebuild: false`** — node-pty ships prebuilt binaries (`prebuilds/win32-*/*.node`) and
  loads them at runtime (`build/Release` → `build/Debug` → `prebuilds/<platform>-<arch>`), so
  no from-source rebuild (Python + C++ toolchain) is needed; skipping it avoids a build failure.
- **Code signing is OFF** — a commented placeholder in `electron-builder.yml` (`win.certificateFile`
  / `certificatePassword` via env) shows where a release cert would go. Signing/notarization need
  the user's Authenticode cert.
- **macOS/Linux packaging is a future item** — it needs the cross-platform MAC work plus an Apple
  Developer cert for notarization. Only the unsigned Windows target is configured today.

## Auto-update

`electron-updater` is wired in `electron/main.ts` inside an `app.isPackaged` guard so **`npm run dev` is completely unaffected** — dev builds are not packaged, so the block never runs.

The updater is a **deliberate no-op** until the user completes all three steps:

1. **Uncomment + fill the `publish:` block in `electron-builder.yml`** — set `owner` and `repo` (or choose a different provider). The placeholder block is left commented so builds don't attempt to push artifacts or fail with a missing provider.
2. **Ship SIGNED releases** — `electron-updater` on Windows requires Authenticode signature validation for security. Unsigned builds will be rejected by the updater. See the `win.certificateFile` / `certificatePassword` placeholder in `electron-builder.yml` for where the cert config goes.
3. **Distribute via `npm run package:installer`** — this produces the NSIS installer + `latest.yml` feed file that `electron-updater` polls. The `--win dir` target (`npm run package`) does NOT produce the feed.

Until all three steps are done the updater silently does nothing. Update-available, update-downloaded, and error events are routed through `logWarn`/`logError` from `electron/log.ts` so any activity leaves a trace in `~/.claude-tui/logs/main.log`.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+N | New session |
| Ctrl+T | New terminal in active session |
| Ctrl+W | Close active terminal |
| Ctrl+K | Kill active session |
| Ctrl+Shift+H | Retire & continue (handoff) — flush summary, fresh terminal, retire old |
| Ctrl+\ | Toggle split panes |
| Ctrl+1-9 | Switch to session by index |
| Alt+1-9 | Switch to terminal by index |
| Ctrl+Shift+P | Command palette |
| Ctrl+Shift+F | Search session history |
| Ctrl+J | Jump to the top "NEEDS YOU" attention-queue entry |
| Ctrl+M | Toggle dictation (composer focused) |
| Ctrl+Shift+Z | Focus mode (hide sidebar + tab bar) |
| Ctrl+/ | Keyboard shortcuts overlay |

## Tech Stack

Electron, React, TypeScript, xterm.js, node-pty, @modelcontextprotocol/sdk, react-markdown, electron-vite
