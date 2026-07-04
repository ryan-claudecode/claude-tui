# ClaudeTUI

Cross-platform desktop app for managing multiple Claude Code sessions. Electron + React + xterm.js + MCP.

## Commands

```bash
npm run dev                # build + launch
npm run build              # build only
npm test                   # Vitest unit/integration suite — hermetic, fast. THE gate.
npm run e2e                # Playwright Electron smoke suite (builds first; separate from npm test)
npm run package            # electron-builder --win dir → dist/win-unpacked (fast build validation)
npm run package:installer  # NSIS installer
```

## Reference docs — load on demand

This file is the map. Full subsystem detail lives in `docs/reference/` — **read the doc for whatever you're touching before changing it** (they hold the invariants and hard-won gotchas that used to live here):

| Doc | Read when touching |
|---|---|
| `docs/reference/feature-pattern.md` | Adding any feature — the Service → IPC → MCP → Preload worked example + IPC channel naming convention |
| `docs/reference/services.md` | Any main-process service — deep dives on Terminal/Session/ContextInspector/Attention/Scheduler/Stt services, work-session container model, resume fidelity, kill flow, R2/R3a tombstones |
| `docs/reference/structured-engine.md` | Terminal spawning, the headless `claude -p` structured engine, AgentComposer input, the approve_tool permission gate, slash-command picker/routing, context meter |
| `docs/reference/mcp.md` | The MCP server or any tool — full tool-group catalog, SERVER_INSTRUCTIONS sync rule, renderer-only-UI-action recipe |
| `docs/reference/panels.md` | Panels — ModalHost, pop-out/companion lifecycle, form semantics, add-a-panel-type recipe |
| `docs/reference/build-test-package.md` | Build outputs, e2e hermeticity details, electron-builder packaging, auto-update |
| `docs/reference/ui.md` | Themes, frameless window, config.json schema (incl. `models`), keyboard shortcuts |

Design docs for the bigger arcs live in `docs/roadmap/` (linked from the sections below where relevant).

## Architecture

Three layers — the service layer is the source of truth; IPC handlers, MCP tools, and preloads are thin adapters on top.

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

Core facts every session needs:

- **The feature pattern:** every feature is **Service → IPC → MCP → Preload**, each step one function call or one object. Single-PTY ops live in `electron/services/terminals.ts`; durable work-session *container* ops in `electron/services/sessions.ts`. Wire channels: `terminal:*` = per-PTY, `worksession:*` = container (renderer accessor names deliberately do NOT track the namespaces). Worked example: `docs/reference/feature-pattern.md`.
- **Two-tier session model:** a durable **work session** (persisted `~/.claude-tui/sessions/<id>.json`, survives restarts) groups runtime **terminals** (PTYs). On launch everything auto-restores with `--resume <conversationId>`.
- **Structured engine is the DEFAULT:** new terminals spawn headless `claude -p` (stream-json) rendered by `AgentView`+`AgentComposer`, with tool permissions via the `approve_tool` MCP gate; `xterm` PTY is the opt-in legacy path (config `engine: "xterm"` or the per-terminal Raw view). Detail: `docs/reference/structured-engine.md`.
- **Panels are modal-by-default in the main window** (`ModalHost`), pop-out to the companion window; both render through the ONE shared `PanelContent` switch over the parity-gated `PanelApi`. Detail: `docs/reference/panels.md`.
- **Durable knowledge is Claude-NATIVE** (CLAUDE.md / CLAUDE.local.md / auto-memory) — the app's parallel knowledge system was retrenched in R3a; the Context Inspector reads native context (READ-ONLY), R3b adds the edit surface. See `docs/roadmap/retrenchment-plan-2026-07.md`.
- **MCP server:** HTTP/SSE on a random localhost port; spawned sessions auto-connect via `--mcp-config`; tools map 1:1 to service methods. **Keep `SERVER_INSTRUCTIONS` (`electron/mcp/server.ts`) in sync when adding tool groups.** Catalog: `docs/reference/mcp.md`.

## Key Files

### Electron (main process)

| File | Purpose |
|------|---------|
| `electron/main.ts` | App entry — creates frameless window, calls setupIpc |
| `electron/ipc.ts` | IPC handlers — thin wrappers calling services |
| `electron/preload.ts` / `electron/companion-preload.ts` | contextBridge APIs for the main / companion renderers |
| `electron/services/terminals.ts` | **TerminalService** — runtime PTYs, output capture, idle/activity, headless (structured) spawn |
| `electron/services/sessions.ts` | **SessionService** — durable work-session container, conversation resume, handoff, activity |
| `electron/services/companion.ts` | **CompanionService** — companion BrowserWindow lifecycle, panel-event routing |
| `electron/services/workspaces.ts` | **WorkspaceService** — workspace discovery + activation |
| `electron/services/contextInspector.ts` | **ContextInspectorService** — READ-ONLY native-context inspector (tiers 0–7, INSPECT-ONLY invariant) |
| `electron/services/panels.ts` | **PanelService** — panel state + form callbacks, routes to both windows |
| `electron/services/app.ts` | **AppService** — screenshot, app state, build |
| `electron/services/ui.ts` | **UiService** — bridges renderer-only view actions to MCP via `ui:*` events |
| `electron/services/attention.ts` | **AttentionService** — the tiered "who needs me?" queue |
| `electron/services/scheduler.ts` | **SchedulerService** — on-device scheduled/recurring Claude runs |
| `electron/services/scheduleMath.ts` | Pure recurrence math (zero Electron imports) |
| `electron/services/stt.ts` | **SttService** — push-to-talk dictation (Parakeet in a utility process) + hotwords |
| `electron/mcp/server.ts` | MCP HTTP/SSE server lifecycle + `SERVER_INSTRUCTIONS` |
| `electron/mcp/tools.ts` | MCP tool definitions — calls services |
| `electron/config.ts` | Loads `~/.claude-tui/config.json`, theme mode read/write |
| `electron/workspace/discovery.ts` | Scans for workspace.json files |

Deep dives on every service (invariants, gotchas, design-doc links): `docs/reference/services.md`.

### Renderer (React)

| File | Purpose |
|------|---------|
| `src/App.tsx` | Root layout, state management, keyboard shortcuts |
| `src/App.css` | All styles — theme system at the top (design tokens shared by both windows) |
| `src/components/Sidebar.tsx` | Workspace + session lists |
| `src/components/TabBar.tsx` | Pill tabs for terminals, window controls |
| `src/components/TerminalPane.tsx` / `SplitView.tsx` | xterm.js wrapper / side-by-side panes |
| `src/components/ModalHost.tsx` | In-main-window modal panel host |
| `src/components/panels/PanelContent.tsx` | The ONE shared panel-type switch (both windows render through it) |
| `src/components/panels/*.tsx` | Panel components — Diff, Form, Image, Markdown, Table, etc. |
| `src/companion/CompanionApp.tsx` | Companion window root — panel tabs + routing |

## Standing rules

- **No hover-reveal affordances.** Every action is an explicitly visible control (button/text), never revealed on hover.
- **These docs describe user-controlled native files carefully:** the Context Inspector is contractually INSPECT-ONLY — never add a write path to it.
- **`npm test` is the gate**; e2e is separate by design and must stay hermetic (no real `claude.exe` spawns — see `docs/reference/build-test-package.md`).
- **Never commit `dist/` artifacts.**
- **No new feature without a named pull signal** (retrenchment process rule — `docs/roadmap/retrenchment-plan-2026-07.md`).

## Tech Stack

Electron, React, TypeScript, xterm.js, node-pty, @modelcontextprotocol/sdk, react-markdown, electron-vite
