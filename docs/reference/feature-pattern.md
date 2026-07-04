# The Feature Pattern — worked example

Every feature follows the same 4-step pattern: **Service → IPC → MCP → Preload**. Each step is one function call or one object. Example: adding a "pause session" feature.

> Note: single-PTY operations (the `this.terminals` map) live in `electron/services/terminals.ts`; durable container ops live in `electron/services/sessions.ts`. The example below uses `terminals.ts`.

## Step 1: Add to service

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

## Step 2: Add IPC handler

`electron/ipc.ts`:
```typescript
ipcMain.handle("terminal:pause", (_e, id) => sessionService.pause(id))
```

## Step 3: Add MCP tool

`electron/mcp/tools.ts`:
```typescript
server.tool("pause_session", "Pause a session", {
  id: z.string().describe("Session ID"),
}, async ({ id }) => {
  const ok = sessions.pause(id)
  return { content: [{ type: "text", text: ok ? "Paused" : "Not found" }] }
})
```

## Step 4: Expose to renderer (if UI needed)

`electron/preload.ts`:
```typescript
pauseSession: (id: string) => ipcRenderer.invoke("terminal:pause", id),
```

`src/App.tsx` — add to Window.api type, add handler, wire to UI.

That's it. Service → IPC → MCP → Preload. Each is one function call or one object.

## IPC channel convention

Per-terminal (PTY) operations use the `terminal:*` channel namespace; durable work-session *container* operations use `worksession:*`. The renderer-facing JS accessor names (`createSession`, `onSessionData`, etc.) are kept stable for API continuity and deliberately do **not** track the channel namespace — only the wire strings follow the `terminal:*` / `worksession:*` split.

## Related recipes

- Add a new **panel type**: `docs/reference/panels.md`
- Expose a **renderer-only UI action** to MCP (no service owns the data): `docs/reference/mcp.md`
