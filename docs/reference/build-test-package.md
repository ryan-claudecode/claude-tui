# Build, Testing, Packaging, Auto-update

## Build

Uses electron-vite. Config in `electron.vite.config.ts`.

- Main output CJS to `out/main/`
- Two preloads (main + companion) output CJS to `out/preload/`
- Two renderers (main + companion) output to `out/renderer/`
- Native modules (node-pty) and MCP SDK are externalized from the bundle

## Testing

Two suites, deliberately kept separate:

- **`npm test`** — the unit/integration suite (Vitest, `*.test.ts` under `electron/` + `src/`). Hermetic (no real PTYs/claude spawns), fast. This is the gate.
- **`npm run e2e`** — the Playwright **Electron smoke suite** (`e2e/*.spec.ts`, config in `playwright.config.ts`). Builds first (`npm run build`), then launches the *built* app via `_electron.launch({ args: ["."] })` and asserts the shell renders (sidebar brand + empty-state affordances). NOT part of `npm test` — Vitest's `include` glob excludes `e2e/`, so it can never destabilize the unit gate.

  **Hermetic by USERPROFILE override:** the spec launches Electron with `env.USERPROFILE` set to a fresh `mkdtemp` dir. The app reads all persisted state from `os.homedir()` (which on Windows follows `USERPROFILE`), so `~/.claude-tui` is empty → no session auto-restore → **no real `claude.exe` spawns**. No production code changes, no user data touched. The temp home + Electron instance are torn down in `afterEach` (always, even on failure) — no leaks.
  - Two Windows-specific launch details: (1) `@playwright/test` is installed with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` (Electron testing uses the app's own electron binary via `_electron`, not chromium); (2) the launch passes `--user-data-dir=<tempHome>/electron-data` because Chromium crashes during window creation (STATUS_BREAKPOINT) when `USERPROFILE` is overridden but its disk/GPU cache can't initialize under the real profile — pointing the cache inside the temp home fixes it (and keeps it hermetic). Note Electron's `app.getPath("home")` does NOT follow the override, but the app uses `os.homedir()`, which does.

## Packaging

Distributable Windows builds via **electron-builder** (config in `electron-builder.yml`). Both scripts run `npm run build` first to refresh `out/`, then package into `dist/` (gitignored — never commit artifacts).

- `npm run package` — `electron-builder --win dir`. Produces the unpacked tree `dist/win-unpacked/ClaudeTUI.exe` (no installer). Fast; use this to validate a build.
- `npm run package:installer` — `electron-builder --win nsis`. Produces the NSIS installer. May download nsis resources on first run, so it's heavier than `--win dir`.

Key config notes:

- **`asarUnpack: ["**/node_modules/node-pty/**"]`** — node-pty is a native module whose `.node` binaries + helper exes (`winpty-agent.exe`, `OpenConsole.exe`, `conpty.dll`) must live OUTSIDE the asar or PTY spawning breaks in the packaged app. They land under `dist/win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/`.
- **`npmRebuild: false`** — node-pty ships prebuilt binaries (`prebuilds/win32-*/*.node`) and loads them at runtime (`build/Release` → `build/Debug` → `prebuilds/<platform>-<arch>`), so no from-source rebuild (Python + C++ toolchain) is needed; skipping it avoids a build failure.
- **Code signing is OFF** — a commented placeholder in `electron-builder.yml` (`win.certificateFile` / `certificatePassword` via env) shows where a release cert would go. Signing/notarization need the user's Authenticode cert.
- **macOS/Linux packaging is a future item** — it needs the cross-platform MAC work plus an Apple Developer cert for notarization. Only the unsigned Windows target is configured today.

## Auto-update

`electron-updater` is wired in `electron/main.ts` inside an `app.isPackaged` guard so **`npm run dev` is completely unaffected** — dev builds are not packaged, so the block never runs.

The updater is a **deliberate no-op** until the user completes all three steps:

1. **Uncomment + fill the `publish:` block in `electron-builder.yml`** — set `owner` and `repo` (or choose a different provider). The placeholder block is left commented so builds don't attempt to push artifacts or fail with a missing provider.
2. **Ship SIGNED releases** — `electron-updater` on Windows requires Authenticode signature validation for security. Unsigned builds will be rejected by the updater. See the `win.certificateFile` / `certificatePassword` placeholder in `electron-builder.yml` for where the cert config goes.
3. **Distribute via `npm run package:installer`** — this produces the NSIS installer + `latest.yml` feed file that `electron-updater` polls. The `--win dir` target (`npm run package`) does NOT produce the feed.

Until all three steps are done the updater silently does nothing. Update-available, update-downloaded, and error events are routed through `logWarn`/`logError` from `electron/log.ts` so any activity leaves a trace in `~/.claude-tui/logs/main.log`.
