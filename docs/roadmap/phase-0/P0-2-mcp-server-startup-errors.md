# P0-2 — MCP server startup error handling

- **Phase:** 0 · **Depends on:** none · **Worktree:** yes · **Size:** S (~1 hour)
- **Why:** If the MCP HTTP server fails to start (or the config file can't be written),
  the app today continues silently with a broken MCP config — every spawned Claude session
  then fails to connect to the app, and nothing anywhere says why. The MCP connection is
  the app's entire value channel; its failure must be loud
  ([identity doc](../00-identity.md): no silent failures).

## Current state (verified 2026-06-10)

- `electron/mcp/server.ts:195-197`:
  ```typescript
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve)
  })
  ```
  No `error` handler — a listen failure leaves the promise pending or the error unhandled.
- `electron/mcp/server.ts:199-200` — if `address()` returns null, `port` silently becomes
  `0` and an invalid config URL (`http://127.0.0.1:0/sse`) is written.
- `electron/mcp/server.ts:207-225` — `mkdirSync`/`writeFileSync` for the config file are
  unwrapped; a failure here throws up through `setupIpc` → `createWindow`
  (`electron/main.ts:37`) where nothing catches it.
- `electron/main.ts:61-66` — `app.whenReady().then(createWindow)` has no `.catch`.

## Scope

1. In `startMcpServer`, make listen failures reject:
   ```typescript
   await new Promise<void>((resolve, reject) => {
     httpServer.once("error", reject)
     httpServer.listen(0, "127.0.0.1", () => {
       httpServer.removeListener("error", reject)
       resolve()
     })
   })
   ```
2. After listen, if the resolved `port` is falsy, `throw new Error("MCP server bound to invalid port")`.
3. In the caller (`electron/ipc.ts`, where `startMcpServer` is awaited): wrap in try/catch.
   On failure: log the error, and surface it to the user via Electron's
   `dialog.showErrorBox("ClaudeTUI — MCP server failed to start", String(err))`. The app
   should still open (terminals minus MCP are degraded but usable) — do NOT quit.
4. When MCP failed to start, `TerminalService` must not push a `--mcp-config` arg pointing
   at a stale/invalid file: ensure `setMcpConfigPath`/`setMcpServerUrl` are simply never
   called in the failure path (verify this is already the consequence of the try/catch
   placement; if not, guard it).
5. Add `.catch` on the `app.whenReady().then(...)` chain in `electron/main.ts` that logs
   and shows `dialog.showErrorBox` (covers any other startup throw).

## Non-goals

- No retry/port-scan logic — `listen(0)` on loopback essentially never fails; we only need
  failure to be visible, not recoverable.
- No changes to the SSE request handling or tool registration.
- No structured logging framework (P0-6 covers logging).

## Acceptance criteria

- Simulated listen failure (unit test: pass a fake/occupied scenario or stub —
  acceptable to test the promise wrapper in isolation by extracting it to a small exported
  helper `listenOnLoopback(server): Promise<number>` and testing that an `error` event
  rejects) → rejects instead of hanging.
- With MCP startup artificially throwing, the app window still opens and an error dialog
  is shown (manual check; describe the manual verification you performed in the PR/commit
  message).
- `npm run build` and `npm test` pass.

## Files

- Modify: `electron/mcp/server.ts`
- Modify: `electron/ipc.ts` (try/catch around `startMcpServer` call site)
- Modify: `electron/main.ts` (whenReady catch)
- Test: `electron/mcp/server.test.ts` (new, for the listen helper)
