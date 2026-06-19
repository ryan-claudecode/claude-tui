import { app, BrowserWindow, protocol, Menu, ipcMain, dialog } from "electron"
import { join } from "path"
import { setupIpc, companionService, sessionService } from "./ipc"
import { getThemeMode } from "./config"
import { logError, logWarn } from "./log"

// Crash visibility: log (but don't exit on) unhandled async failures. Without
// these, a rejected promise or thrown error in the main process leaves no
// trace. We deliberately don't re-throw/exit — Electron's default crash on
// uncaughtException is unsafe here given PTY teardown hazards on Windows.
process.on("unhandledRejection", (reason) => logError("unhandledRejection", reason))
process.on("uncaughtException", (err) => logError("uncaughtException", err))

let mainWindow: BrowserWindow | null = null

async function createWindow() {
  const mode = getThemeMode()

  mainWindow = new BrowserWindow({
    // This is a multi-pane app (sidebar + tabs + terminals + companion), not a
    // single terminal — open generous by default so all three regions breathe.
    width: 1500,
    height: 980,
    minWidth: 900,
    minHeight: 600,
    // Under automated e2e (Playwright sets CI=1 on every _electron.launch) create
    // the window HIDDEN: the renderer still loads so Playwright can drive + assert
    // the DOM, but no window flashes onto the developer's monitor or steals focus.
    // Normal `npm run dev` / packaged launches (no CI) are unaffected.
    show: process.env.CI !== "1",
    title: "ClaudeTUI",
    backgroundColor: mode === "dark" ? "#1c1814" : mode === "cold-dark" ? "#0b0e14" : "#f8f4ed",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    frame: false,
  })

  // Window control IPC
  ipcMain.on("window:minimize", () => mainWindow?.minimize())
  ipcMain.on("window:maximize", () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize()
    else mainWindow?.maximize()
  })
  ipcMain.on("window:close", () => mainWindow?.close())

  // setupIpc is async (starts MCP server)
  await setupIpc(mainWindow)

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    const rendererPath = join(__dirname, "../renderer/index.html")
    console.log("Loading renderer from:", rendererPath)
    mainWindow.loadFile(rendererPath)
  }

  // Clean up before window closes — kill PTYs first to avoid node-pty
  // assertion failures on Windows (conpty remove_pty_baton race)
  mainWindow.on("close", () => {
    sessionService.killAll()
    companionService.close()
  })

  mainWindow.on("closed", () => {
    mainWindow = null
  })

  // Uncomment to debug: mainWindow.webContents.openDevTools()
}

app
  .whenReady()
  .then(async () => {
    // Drop the default File/Edit/View/Window menu — none of it is useful here and
    // we'll build our own in-app affordances. (Removes the menu bar on Win/Linux.)
    Menu.setApplicationMenu(null)
    await createWindow()

    // Auto-update (SAFE NO-OP until a publish target is configured).
    // Guarded by app.isPackaged so `npm run dev` NEVER triggers it — dev builds
    // are not packaged, so the block below is unreachable during development.
    // To enable: uncomment + fill the `publish:` block in electron-builder.yml,
    // ship SIGNED releases, and distribute via `npm run package:installer`.
    if (app.isPackaged) {
      const { autoUpdater } = await import("electron-updater")
      autoUpdater.logger = {
        info: (m: unknown) => logWarn("updater", String(m)),
        warn: (m: unknown) => logWarn("updater", String(m)),
        error: (e: unknown) => logError("updater", e),
        debug: () => {},
      } as any
      autoUpdater.on("update-available", (i: { version: string }) =>
        logWarn("updater", `update available: ${i.version}`)
      )
      autoUpdater.on("update-downloaded", (i: { version: string }) =>
        logWarn("updater", `update downloaded: ${i.version}`)
      )
      autoUpdater.on("error", (e: unknown) => logError("updater", e))
      try {
        void autoUpdater.checkForUpdatesAndNotify()
      } catch (e) {
        logError("updater", e)
      }
    }
  })
  .catch((err) => {
    // Any unhandled throw during startup (MCP failures are caught earlier and
    // shown degraded; this covers everything else). Make it loud rather than
    // failing silently with a blank/missing window.
    console.error("Fatal error during startup:", err)
    dialog.showErrorBox("ClaudeTUI — startup failed", String(err))
  })

app.on("window-all-closed", () => {
  // Kill all PTYs before quitting to avoid node-pty assertion failures
  // on Windows (conpty.cc remove_pty_baton race during process teardown)
  sessionService.killAll()
  app.quit()
})
