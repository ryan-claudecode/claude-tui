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

### MCP Tools

Session/workspace tools map 1:1 to `SessionService` / `WorkspaceService` methods.
Additional tool groups:

**Panels** (`PanelService`):
- `show_panel` — show a `diff`, `image`, `markdown`, or `table` panel
- `show_form` — show an interactive form and **wait** for the user to submit; returns the field values (or `{ cancelled: true }`)
- `update_panel` / `hide_panel` / `hide_all_panels` / `list_panels`

**Testing/self-verification** (`AppService`):
- `take_screenshot` — capture the ClaudeTUI window as a PNG
- `get_app_state` — current window/session/workspace state for assertions
- `run_build` — build the project and return success/error output

**Notifications** (`NotificationService`):
- `notify` — show a toast (`info` / `success` / `warning` / `error`). Surfaces even when the calling session's terminal isn't focused — use it to announce task completion, request input, or report errors. Auto-dismisses after `timeout` ms (0 = sticky). Rendered by `ToastHost` (`src/components/ToastHost.tsx`).

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
