# P0-1 — Token-authenticated MCP identity

- **Phase:** 0 · **Depends on:** none · **Worktree:** yes · **Size:** M (~half day)
- **Why:** Session identity on the MCP server is plain `?sid=&tid=` query params with no
  validation. Any connected session (or anything a prompt-injected session is tricked into
  doing) can impersonate another terminal: poison its findings ledger via `session_note`,
  corrupt its summary, inject false activity. Sessions run with
  `--dangerously-skip-permissions`, so this is the app's largest trust gap. An agent
  cockpit must have non-forgeable agent identity ([identity doc](../00-identity.md)).

## Current state (verified 2026-06-10)

- `electron/mcp/server.ts:171-176` — on each `GET /sse`, identity is read straight from
  the URL: `parsedReq.searchParams.get("sid")` / `get("tid")`, then passed to
  `makeServer(identity)` → `registerTools(..., identity)`. No validation of any kind.
- `electron/services/terminals.ts:255-266` — `mcpConfigFor(terminalId, sessionId)` mints a
  per-terminal MCP config file at `{tmpdir}/claudetui/mcp-config-<tid>.json` whose SSE URL
  carries `?sid=...&tid=...`. This is the only legitimate producer of identity-bearing URLs.
- `electron/services/terminals.ts:256` — when there is no server URL or no work-session id,
  it falls back to the shared anonymous config (`this.mcpConfigPath`, no identity). Anonymous
  connections are legitimate and must keep working.
- Work-session tools default to the connection's identity in `electron/mcp/tools.ts`
  (look for `identity.sessionId` / `identity.terminalId` usages, e.g. around the
  `set_terminal_activity` / `session_note` / `get_session_context` definitions).

## Scope

1. **Mint a token per terminal.** In `TerminalService`, when `mcpConfigFor` builds an
   identity-bearing URL, generate a random token (`crypto.randomBytes(24).toString("base64url")`)
   and record it in a `Map<token, { sessionId, terminalId }>` owned by `TerminalService`
   (expose `issueIdentityToken(sessionId, terminalId): string` and
   `resolveIdentityToken(token): { sessionId, terminalId } | undefined`).
   Append it to the SSE URL: `?sid=...&tid=...&token=...` (keep sid/tid for debuggability,
   but they are no longer trusted).
2. **Validate on connect.** In `server.ts` `GET /sse` handling: resolve the token via the
   service. If the token resolves, use the *resolved* sid/tid (ignore the URL's claims).
   If there is no token or it doesn't resolve, proceed with **empty identity** (`{}`) —
   the connection still works, but work-session tools get no defaults and cannot act as
   anyone. Never reject the connection outright (anonymous use is legitimate).
3. **Invalidate on terminal kill.** Remove the token from the map when its terminal is
   killed (`TerminalService.kill` / `killAll`), so a stale config file can't resurrect an
   identity.
4. **Plumbing:** `startMcpServer` needs access to the resolver — it already receives the
   `TerminalService` as its first parameter (`sessionService` in `server.ts:66`); add no
   new parameters.

## Non-goals

- Do NOT add auth to the `/messages` POST route or per-tool-call token checks — the SSE
  transport's own `sessionId` already routes those; connect-time binding is the trust
  boundary for this item.
- Do NOT restrict which tools anonymous connections may call (tool-level authorization is
  a later item).
- Do NOT touch the explicit `session_id`/`terminal_id` override params on tools.
- Do NOT refactor `tools.ts` or `server.ts` beyond what's needed (Phase 1 does that).

## Acceptance criteria

- A spawned terminal's work-session tools still default to its own ids (manual check:
  spawn a session, have it call `set_terminal_activity({ activity: "x" })` with no ids,
  sidebar shows the activity on the right terminal).
- A connection using `?sid=<other>&tid=<other>` WITHOUT a valid token gets empty identity
  (unit test at the service level: `resolveIdentityToken("garbage")` → undefined; plus a
  test that `mcpConfigFor` output URL contains a token that resolves to exactly its own ids).
- Killed terminal's token no longer resolves (unit test).
- Tests live in `electron/services/terminals.test.ts` (extend the existing vitest file).
- `npm run build` and `npm test` pass.

## Files

- Modify: `electron/services/terminals.ts` (token mint/resolve/invalidate, URL construction)
- Modify: `electron/mcp/server.ts` (resolve token on `/sse` connect)
- Test: `electron/services/terminals.test.ts`
