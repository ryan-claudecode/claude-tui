# ClaudeTUI MCP Server — Design Spec

**Date:** 2026-06-03
**Status:** Active

## Overview

Local MCP server running inside the Electron main process. Each spawned Claude session auto-connects via `--mcp-config`. Claude gets tools to control the app — create/kill/rename sessions, split panes, trigger handoffs, manage workspaces.

## Architecture

### Service Layer (new)

Extract business logic from `electron/ipc.ts` into a shared service layer. Both IPC handlers and MCP tool handlers call the same services.

```
┌─────────────────────────────────────────────────┐
│  IPC Handlers          MCP Tool Handlers         │
│  (renderer ↔ main)     (Claude ↔ main)           │
├─────────────────────────────────────────────────┤
│              Service Layer                       │
│  SessionService    WorkspaceService              │
│  (create, kill,    (list, activate,              │
│   rename, list,     boot editors)                │
│   handoff, split)                                │
├─────────────────────────────────────────────────┤
│  node-pty          config          renderer IPC  │
└─────────────────────────────────────────────────┘
```

### MCP Server

HTTP/SSE server on localhost (random available port). Implements the MCP protocol with tool definitions. Starts when the app launches, stops on quit.

### Session Spawning

Each Claude session spawns with `--mcp-config {configPath}` pointing to a temp JSON file containing the server URL. Claude auto-discovers the tools.

## MCP Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `create_session` | `name?: string, cwd?: string` | Create a new Claude session |
| `kill_session` | `id: string` | Kill a session |
| `list_sessions` | (none) | List all sessions with state |
| `focus_session` | `id: string` | Switch focus to a session |
| `rename_session` | `id: string, name: string` | Rename a session |
| `trigger_handoff` | `id: string` | Trigger handoff on a session |
| `split_panes` | `left_id: string, right_id: string` | Split view with two sessions |
| `close_split` | (none) | Close split view |
| `list_workspaces` | (none) | List discovered workspaces |
| `activate_workspace` | `index: number` | Boot a workspace |

## File Structure

```
electron/
├── services/
│   ├── sessions.ts       # Session CRUD, handoff, split — shared logic
│   └── workspaces.ts     # Workspace discovery, activation — shared logic
├── mcp/
│   ├── server.ts         # HTTP/SSE MCP server lifecycle
│   └── tools.ts          # Tool definitions + handlers (calls services)
├── ipc.ts                # Thin layer: IPC handlers → services
├── main.ts               # Starts MCP server on app ready
└── ...
```

## Adding New Features

1. Add method to the appropriate service
2. Add IPC handler in `ipc.ts` (one line — calls service)
3. Add tool definition in `mcp/tools.ts` (one object — calls service)
4. Add preload exposure if renderer needs it

## Config File

Written to a temp path on startup:
```json
{
  "mcpServers": {
    "claudetui": {
      "type": "sse",
      "url": "http://localhost:{port}/sse"
    }
  }
}
```

Passed to each session via shell args.
