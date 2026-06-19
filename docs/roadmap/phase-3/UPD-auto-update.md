# UPD — Auto-update scaffold (PARTIAL — needs user publish target)

- **Phase:** 3 · **Depends on:** PKG (`592d4c7`, electron-builder) · **Worktree: yes** · **Model: Sonnet** · **Size:** S
- **Why:** packaged apps need a way to ship fixes. This scaffolds `electron-updater` so the
  user only has to configure a publish provider + ship signed releases to enable updates.
  It is a deliberate NO-OP until configured — safe to add now.

## Current state (verified 2026-06-13)

- PKG added `electron-builder.yml` (appId com.claudetui.app, win dir+nsis, signing off).
- `electron/main.ts` boots the app; `app.whenReady().then(createWindow)` (with a `.catch`
  from P0-2). `electron/log.ts` provides `logError`/`logWarn` (P0-6).
- No update mechanism exists.

## Scope

1. **Install** `electron-updater` (a regular dependency, NOT dev — it ships in the app).
   `npm install electron-updater --legacy-peer-deps` (the repo needs `--legacy-peer-deps`
   for a pre-existing vite/electron-vite peer conflict). If it hangs >3 min, bail+report.
2. **main.ts wiring** — after `app.whenReady` (and ONLY when `app.isPackaged`):
   ```ts
   import { autoUpdater } from "electron-updater"
   // ...inside whenReady, packaged only:
   autoUpdater.logger = { info: (m)=>logWarn("updater", String(m)), warn:(m)=>logWarn("updater",String(m)),
                          error:(e)=>logError("updater", e), debug: ()=>{} } as any
   autoUpdater.on("update-available", (i) => logWarn("updater", `update available: ${i.version}`))
   autoUpdater.on("update-downloaded", (i) => logWarn("updater", `update downloaded: ${i.version}`))
   autoUpdater.on("error", (e) => logError("updater", e))
   try { void autoUpdater.checkForUpdatesAndNotify() } catch (e) { logError("updater", e) }
   ```
   - Guard with `app.isPackaged` so `npm run dev` NEVER triggers it. Wrap in try/catch +
     log so an unconfigured/absent publish target degrades to a logged warning, never a crash.
3. **publish placeholder** — in `electron-builder.yml`, add a `publish` block as a
   DOCUMENTED PLACEHOLDER the user fills in, e.g.:
   ```yaml
   # publish:   # ← uncomment + fill in to enable auto-update (UPD is a no-op until then)
   #   provider: github
   #   owner: YOUR_GITHUB_USER
   #   repo: claude-tui-app
   ```
   Keep it commented so builds don't fail trying to publish.
4. **Docs** — CLAUDE.md "Auto-update" note: what's wired, that it's a no-op until the user
   (a) uncomments+fills the `publish` block, (b) ships SIGNED releases (electron-updater
   requires signature validation on Windows for security), and (c) runs
   `npm run package:installer` to produce the published artifacts + `latest.yml` feed.

## Non-goals

- No publish provider configured (it's the user's hosting choice), no signed releases, no
  in-app "update available" UI beyond logging (a toast could come later), no CI release flow.
  No renderer changes.

## Acceptance criteria

- `npm run build` + `npm test` green (276 stays green — update logic is packaged-only/guarded).
- `npm run dev` behavior is UNCHANGED (the updater is `app.isPackaged`-gated; verify by
  reasoning + state it — dev is not packaged so the block never runs).
- Commit only: `package.json`, lockfile, `electron/main.ts`, `electron-builder.yml`,
  `CLAUDE.md`. By explicit path.

## Mandatory base check

`git rev-parse HEAD` vs `git rev-parse main`; if different `git reset --hard main`; confirm
HEAD ≥ `896a26b` and `npm test` = 18 files / 276 tests BEFORE editing. Stop+report if wrong.
Note: main's node_modules may need `npm install --legacy-peer-deps` first if electron-builder
isn't present — but in your worktree just install electron-updater as scoped.

## Safety

Never kill a process you didn't launch+record. Don't launch the app or claude CLI.
