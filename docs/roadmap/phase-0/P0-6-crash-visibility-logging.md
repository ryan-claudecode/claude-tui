# P0-6 — Crash visibility: unhandled-rejection handlers + error logging

- **Phase:** 0 · **Depends on:** none · **Worktree:** yes · **Size:** S (~2 hours)
- **Why:** When something goes wrong in the main process today there is often no evidence
  anywhere: no unhandled-rejection hook, and the persistence/config layer swallows errors
  with bare `catch {}`. Diagnosing user-reported issues (and our own) requires that
  failures leave a trace ([identity doc](../00-identity.md): trustworthy cockpit).

## Current state (verified 2026-06-10)

- `electron/main.ts` — no `process.on("unhandledRejection")` or `("uncaughtException")`.
- `electron/config.ts:56-58, 65-67, 84-86` — three bare `catch` blocks returning defaults
  with no logging.
- `electron/services/mission.ts:104-106` — corrupt mission file skipped silently
  (`catch { /* skip corrupt file */ }`), and missions dir absence indistinguishable from
  a read error.
- `electron/services/sessions.ts:311` — `readdirSync` failure silently aborts session
  loading (`catch { return }`).
- Console output exists only when launched from a terminal; a packaged/dev app launched
  from the shell loses it.

## Scope

1. New module `electron/log.ts`:
   ```typescript
   // Appends a timestamped line to ~/.claude-tui/logs/main.log AND mirrors to console.
   // Creates the dir on first use. If the file exceeds 1 MB at write time, truncate it
   // first (simple cap, no rotation). All internal fs errors are swallowed — the logger
   // must never throw.
   export function logError(scope: string, err: unknown): void
   export function logWarn(scope: string, message: string): void
   ```
   No new dependencies — plain `node:fs` append.
2. In `electron/main.ts`, register early (before `app.whenReady`):
   ```typescript
   process.on("unhandledRejection", (reason) => logError("unhandledRejection", reason))
   process.on("uncaughtException", (err) => logError("uncaughtException", err))
   ```
   (Log only — do not exit; Electron's default crash behavior for uncaughtException is
   acceptable to suppress here given PTY teardown hazards on Windows.)
3. Replace the silent catches with logging (behavior otherwise unchanged — same fallbacks):
   - `config.ts:56-58, 65-67, 84-86` → `logWarn("config", ...)` (note: missing file on
     first run is EXPECTED — only log when the file exists but is unreadable/corrupt, i.e.
     check `err.code !== "ENOENT"`).
   - `mission.ts:104-106` → `logWarn("missions", \`skipping corrupt ${f}: ...\`)`.
   - `sessions.ts:311` → log non-ENOENT failures.
4. If P0-4 (schema versioning) has merged first, its `persist.ts` warning path should call
   this logger instead of bare `console.warn` — coordinate, don't duplicate.

## Non-goals

- No logging framework/dependency (electron-log etc.).
- No renderer-process logging (renderer issues surface via P0-5 toasts).
- No log-viewer UI.
- Do NOT change any fallback behavior — this item adds visibility, not new semantics.

## Acceptance criteria

- Unit tests for `log.ts` (`electron/log.test.ts`, injectable log dir like the other
  services' test seams): writes a line; never throws when dir is unwritable; truncates
  past 1 MB.
- A deliberately corrupted `sessions/<id>.json` produces a logged warning on startup and
  the app still boots (manual check, described in commit message).
- First-run with no `~/.claude-tui/config.json` logs nothing (ENOENT is silent).
- `npm run build` and `npm test` pass.

## Files

- Create: `electron/log.ts`, `electron/log.test.ts`
- Modify: `electron/main.ts`, `electron/config.ts`, `electron/services/mission.ts`,
  `electron/services/sessions.ts`
