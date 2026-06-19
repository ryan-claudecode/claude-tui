# PKG — electron-builder packaging (Windows, unsigned)

- **Phase:** 3 · **Depends on:** — · **Worktree: yes** · **Model: Opus** · **Size:** M
- **Why:** the app is dev-mode only (`npm run dev`); it cannot be installed. This adds the
  electron-builder config + a validated unsigned Windows build, so it can be distributed.
  Signing/notarization/installer need the user's cert — documented, not done.

## Current state (verified 2026-06-13)

- `package.json`: `main: "./out/main/index.js"`; scripts build via `tsc -b && electron-vite
  build` → `out/`. Deps include `node-pty` (NATIVE module — the packaging gotcha) and the
  MCP SDK. No `build`/electron-builder config exists.
- electron-vite outputs: `out/main` (CJS), `out/preload`, `out/renderer`. Native modules +
  MCP SDK are externalized from the bundle (so they must ship as real node_modules).
- `.gitignore` already ignores `out/`, `dist/`, `node_modules/`.

## Scope

1. **Install** `electron-builder` as a devDependency (`npm install -D electron-builder`).
   This writes package.json + lockfile + node_modules (you are the ONLY agent running —
   safe). If the install itself hangs/downloads excessively beyond ~3 min, STOP and report.
2. **Config** — add a `build` block to package.json (or `electron-builder.yml`):
   - `appId: "com.claudetui.app"`, `productName: "ClaudeTUI"`.
   - `directories: { output: "dist" }`.
   - `files: ["out/**/*", "package.json"]` (electron-builder includes production
     node_modules automatically).
   - **`asarUnpack: ["**/node_modules/node-pty/**"]`** — CRITICAL: node-pty's compiled
     `.node` binary + helper exe must be outside the asar or PTY spawning breaks in the
     packaged app. Verify node-pty's actual layout and unpack what it needs.
   - `win: { target: ["dir", "nsis"] }` (dir = unpacked for validation; nsis = installer).
   - Leave signing OFF (no `certificateFile`); add a COMMENTED placeholder block showing
     where `win.certificateFile`/`certificatePassword` (via env) would go for signed releases.
3. **Scripts** — add `"package": "npm run build && electron-builder --win dir"` (validation,
   no installer) and `"package:installer": "npm run build && electron-builder --win nsis"`
   (the full installer; document that it may download nsis resources on first run).
4. **Validate** — run `npm run package` (the `--win dir` build). On success a
   `dist/win-unpacked/ClaudeTUI.exe` (or similar) exists — confirm it's there and report the
   path + size. node-pty's unpacked binary should be under
   `dist/win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/...` — confirm.
   - If `electron-builder --win dir` hangs on a download (winCodeSign/etc.) beyond ~3 min,
     kill ONLY the build process you launched (you have its PID — `taskkill /PID <it> /T`),
     and report the config as written-but-unvalidated with the exact failure. Do NOT run the
     nsis target (heavier) unattended.
5. **Docs** — a short "Packaging" section in CLAUDE.md (the two scripts; signing needs a
   user cert; macOS packaging is a future item needing the MAC work + an Apple cert).
   Add `dist/` to `.gitignore` if not already covered (it is — verify).

## Non-goals

- No code signing, no notarization, no auto-update (UPD item), no macOS/Linux targets, no CI.
- Do NOT commit any build artifact (`dist/` stays ignored).

## Acceptance criteria

- `npm run build` + `npm test` green (276 baseline stays green — packaging config doesn't
  affect tests).
- The electron-builder config is present and the `--win dir` build either SUCCEEDS (report
  the exe path + confirm node-pty unpacked) or is documented as blocked with the exact reason.
- Commit only: `package.json`, lockfile, `electron-builder.yml` (if used), `.gitignore` (if
  changed), `CLAUDE.md`. By explicit path. NO `dist/` artifacts.

## Mandatory base check

`git rev-parse HEAD` vs `git rev-parse main`; if different `git reset --hard main`; confirm
HEAD ≥ `01e09d3` and `npm test` = 18 files / 276 tests BEFORE editing. Stop+report if wrong.

## Safety

You MAY kill the electron-builder build process YOU launched (record its PID). Never kill
any other process. Do NOT launch the app/claude CLI (the `--win dir` build does not run the
app, it just packages it — that's fine).
