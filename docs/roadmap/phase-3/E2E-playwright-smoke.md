# E2E — Playwright smoke suite (Electron)

- **Phase:** 3 · **Depends on:** — · **Worktree: yes** · **Model: Opus** · **Size:** M
- **Why:** the app has 276 hermetic UNIT tests but zero end-to-end coverage — nothing
  verifies the built Electron app actually boots and renders. This adds a Playwright-driven
  smoke suite, kept OUT of `npm test` so it can never destabilize the unit suite.

## Design — hermetic by USERPROFILE override (no app code changes)

The key insight: launch the test's Electron instance with `USERPROFILE` (Windows home) set
to a fresh temp dir. Then `os.homedir()` → tempdir, so `~/.claude-tui` is EMPTY → no session
auto-restore → NO real `claude.exe` spawns → the app boots clean and isolated. No production
code changes, no user data touched, no process churn. (claude CLI resolves via PATH, not
USERPROFILE, so it's unaffected — though with no sessions, nothing spawns anyway.)

## Scope

1. **Install** `@playwright/test` (-D). You are the only agent running (install-safe). Set
   `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` for the install — Electron testing uses the app's
   own electron binary via `_electron`, NOT chromium, so the browser download is unneeded.
   If the install hangs beyond ~3 min, bail and report.
2. **`playwright.config.ts`** — a `testDir: "e2e"`, no webServer, a generous per-test
   timeout (~60s, Electron is slow to boot), `fullyParallel: false`, retries: 0.
3. **`e2e/smoke.spec.ts`** — using `_electron` from `@playwright/test`:
   - `mkdtemp` a temp dir; `electron.launch({ args: ["."], env: { ...process.env,
     USERPROFILE: tempHome, CI: "1" } })` (args `["."]` loads the built app via package.json
     `main`). Note: the suite REQUIRES a prior `npm run build` (the `e2e` script does it).
   - `const win = await app.firstWindow()`; assert the title/`#root` mounts and the sidebar
     brand ("ClaudeTUI") is visible (`await win.waitForSelector('text=ClaudeTUI')` or the
     sidebar brand selector — inspect `src/components/Sidebar.tsx` for a stable selector).
   - A second assertion: the empty-state "MISSIONS"/"+ New session" affordance is present
     (proves the renderer mounted, not just a blank window).
   - `afterEach`/`finally`: `await app.close()` ALWAYS (even on failure) + remove the temp
     dir, so no Electron instance or temp dir leaks.
4. **Script** — `"e2e": "npm run build && playwright test"` in package.json. Do NOT add e2e
   to the `test` script (keep the unit suite isolated).
5. **Run it** — execute `npm run e2e` once to validate. It WILL launch a real (hermetic)
   Electron window briefly, then close it. If it passes, great. If Playwright-Electron can't
   run green on this Windows env after a genuine effort, commit the harness anyway with the
   spec's failing assertion `test.fixme`'d AND a clear report of the exact failure — `npm
   test` (unit) must stay 276-green regardless. Ensure NO orphaned electron.exe remains from
   your run (close via Playwright; if one leaks, kill ONLY the PID your test launched).
6. **Docs** — CLAUDE.md: a short "E2E" note (the `npm run e2e` script, the USERPROFILE-temp
   hermetic approach).

## Non-goals

- No session-creation / claude-spawning E2E (that needs real claude + network — out of scope).
- No CI wiring. No adding e2e to `npm test`. No production code changes (if you find you NEED
  an app change to make it hermetic, STOP and report — the USERPROFILE approach should avoid it).

## Acceptance criteria

- `npm test` (unit) stays **276 green** (E2E is separate).
- `npm run build` green. The Playwright harness + smoke spec exist; `npm run e2e` either
  passes or is documented-blocked with the exact failure + `test.fixme`.
- No orphaned electron.exe / temp dirs after your run (verify + report).
- Commit only: `package.json`, lockfile, `playwright.config.ts`, `e2e/**`, `CLAUDE.md`,
  `.gitignore` (if you ignore playwright artifacts). By explicit path.

## Mandatory base check

`git rev-parse HEAD` vs `git rev-parse main`; if different `git reset --hard main`; confirm
HEAD ≥ `592d4c7` and `npm test` = 18 files / 276 tests BEFORE editing. Stop+report if wrong.

## Safety

You may close/kill ONLY the Electron instance YOUR test launched (Playwright handles it;
record the PID if you must kill manually). NEVER sweep electron.exe by name — the user may
have their own ClaudeTUI running. Never touch the user's claude.exe.
