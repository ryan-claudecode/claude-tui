import { test, expect, _electron, type ElectronApplication } from "@playwright/test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Electron smoke test — hermetic via a temp USERPROFILE.
 *
 * The app reads all of its persisted state (config, sessions, missions,
 * layouts, notes, logs) from `os.homedir()/.claude-tui`, which on Windows is
 * driven by the `USERPROFILE` env var. By launching the test's Electron
 * instance with `USERPROFILE` pointed at a fresh empty temp dir, `~/.claude-tui`
 * is empty → there are no persisted sessions/terminals to auto-restore → NO real
 * `claude.exe` is spawned. The app boots clean and isolated, no production code
 * changes and no user data touched. (`claude` resolves via PATH, not USERPROFILE,
 * so it is unaffected — though with no sessions, nothing spawns anyway.)
 *
 * Requires a prior `npm run build` (the `e2e` npm script does this). The app is
 * loaded from `out/` via the package.json `main` field by passing `args: ["."]`.
 *
 * `--user-data-dir`: on Windows, Chromium crashes during window creation
 * (STATUS_BREAKPOINT, exit 0x80000003) when `USERPROFILE` is overridden but its
 * disk/GPU cache can't be initialized under the standard profile location. We
 * point `--user-data-dir` at a subdir of the temp home so Electron's own cache
 * lives inside the hermetic dir too (and is removed on cleanup). Our app's
 * persisted state is unaffected: it reads `os.homedir()` (which DOES follow the
 * overridden `USERPROFILE`), not Electron's `app.getPath("home")` (which does not).
 */

let app: ElectronApplication | undefined
let tempHome: string | undefined

test.afterEach(async () => {
  // ALWAYS close the Electron instance and remove the temp dir, even on failure,
  // so no Electron process or temp dir leaks.
  if (app) {
    await app.close().catch(() => {})
    app = undefined
  }
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true }).catch(() => {})
    tempHome = undefined
  }
})

test("built app boots and renders the empty-state shell", async () => {
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-e2e-"))

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: {
      ...process.env,
      USERPROFILE: tempHome, // hermetic home → empty ~/.claude-tui → no restore
      CI: "1",
    },
  })

  const win = await app.firstWindow()

  // The React renderer mounted (not a blank/error window).
  await win.waitForSelector("#root", { timeout: 30_000 })

  // The sidebar brand renders — proves the main UI shell is up.
  const brand = win.locator(".sidebar-brand")
  await expect(brand).toContainText("ClaudeTUI", { timeout: 30_000 })

  // Empty-state affordances prove the renderer actually mounted the shell
  // (and that a hermetic home produced an empty app): the MISSIONS section
  // header and the "+ New session" action are always present.
  await expect(win.locator(".missions-header")).toContainText("MISSIONS")
  await expect(win.locator(".sidebar-action", { hasText: "+ New session" })).toBeVisible()
})
