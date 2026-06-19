# P1-6 — Tests must not spawn real PTYs / Claude processes

- **Phase:** 1 (trailing hygiene) · **Depends on:** P1-5 (merged) · **Worktree:** yes · **Size:** S–M (~3 hours)
- **Why:** `electron/services/terminals.test.ts` calls `TerminalService.create(...)`,
  which calls the real `pty.spawn` — so every `npm test` run launches several REAL
  `powershell → claude --dangerously-skip-permissions` processes. That burns actual
  Claude usage, races the suite, and leaks orphans (a `claude.exe --resume resume-abc`
  from a 20:05 test run was found alive an hour later). A trustworthy cockpit's test
  suite must be hermetic ([identity doc](../00-identity.md)).

## Current state (verified 2026-06-10, post-P1-2)

- `electron/services/terminals.ts` — `create()` calls `pty.spawn(shell, shellArgs, ...)`
  (imported from `node-pty` at top). ~601 lines.
- `electron/services/terminals.test.ts` — at least 8 `svc.create(...)` calls against the
  real spawn path (grep `svc.create`). Other suites (sessions.test.ts) use fakes/drivers
  already — match that spirit.

## Scope (design decided — implement as written)

1. Add an injectable spawn seam to `TerminalService`: a constructor option (or settable
   field, matching how `ccProjectsRoot` is overridden in tests today — inspect and match
   the existing seam style) `spawnPty?: (shell, args, opts) => IPty-like`. Default:
   real `pty.spawn`. The IPty-like surface is only what the service uses
   (`onData`, `onExit`, `kill`, `resize`, `write`, `pid` — verify by reading usages).
2. In `terminals.test.ts`, install a `FakePty` for every constructed service:
   records spawn args (shell, args — useful for asserting `--resume`/`--mcp-config`
   behavior!), exposes `emitData`/`emitExit` helpers, no real process.
3. Sweep ALL test files for other real-spawn paths (`git grep -n "\.create(" -- "*.test.ts"`
   and check each service under test): any test that reaches real `pty.spawn`,
   `spawnSync`, or `child_process` against real binaries gets the same treatment. Report
   what you found per file.
4. Add a guard test: constructing TerminalService in tests without injecting a fake and
   calling create should be impossible to do silently — simplest: the fake installation
   happens in a shared test helper used by every `new TerminalService()` in tests
   (a `makeTestTerminalService()` factory in the test file).

## Non-goals

- No production-behavior change: default spawn path identical.
- No new test framework/deps; vitest only.
- Don't restructure existing test assertions beyond what the fake requires.

## Acceptance criteria

- After `npm test`, ZERO `claude.exe`/`powershell.exe` processes were spawned by the
  suite — prove it: capture `Get-CimInstance Win32_Process` filtered to claude/pwsh
  created during the test window, before vs after your change, and include both in your
  report (before should show the leak; after should be empty).
- All existing tests still pass (`npm test` green; adapt assertions to the fake where
  they previously depended on real-spawn side effects).
- `npm run build` passes.
- Commit only the files you changed, by explicit path.

## Files

- Modify: `electron/services/terminals.ts` (spawn seam), `electron/services/terminals.test.ts`
- Possibly modify: other `*.test.ts` files found in the sweep (report each)
