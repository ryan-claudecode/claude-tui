import { ipcMain, BrowserWindow } from "electron"
import type { TerminalService } from "../services/terminals"
import type { WorkspaceService } from "../services/workspaces"
import type { AppService } from "../services/app"
import type { TestRunnerService } from "../services/tests"
import type { LayoutService } from "../services/layouts"
import type { BroadcastService } from "../services/broadcast"
import type { NotesService } from "../services/notes"
import { getThemeMode, setThemeMode, type TuiConfig, type ThemeMode } from "../config"

export function registerAppHandlers(deps: {
  config: TuiConfig
  sessionService: TerminalService
  workspaceService: WorkspaceService
  appService: AppService
  testRunnerService: TestRunnerService
  layoutService: LayoutService
  broadcastService: BroadcastService
  notesService: NotesService
}) {
  const {
    config,
    sessionService,
    workspaceService,
    appService,
    testRunnerService,
    layoutService,
    broadcastService,
    notesService,
  } = deps

  // Workspace IPC. Now backed by the durable registry (WS-A): the renderer
  // reads `id` + `name`; WS-H — the workspace's single `dir` (+ `color`) rides
  // along for the switcher UX. Reuses `listPublic()` so this stays in lockstep
  // with the no-leak projection (no `seed*` fields, no stale `dirs`). The
  // index-based `activate` is retained for the legacy `onSelectWorkspace(index)`
  // wiring — WS-B replaces it with id-based make-active-vs-launch.
  ipcMain.handle("workspace:list", () => workspaceService.listPublic())
  ipcMain.handle("workspace:activate", (_e, index: number) =>
    workspaceService.activate(index),
  )

  // Config
  ipcMain.handle("config:get", () => config)
  ipcMain.handle("config:get-theme", () => getThemeMode())
  ipcMain.handle("config:set-theme", (_e, mode: ThemeMode) => {
    setThemeMode(mode)
    // Broadcast to all windows so companion windows (future) stay in sync
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("theme:changed", mode)
    }
  })

  // App testing tools
  ipcMain.handle("app:screenshot", async () => appService.captureScreenshot())
  ipcMain.handle("app:state", () =>
    appService.getAppState(sessionService.list(), workspaceService.list()),
  )
  ipcMain.handle("app:save-image", (_e, base64: string, filename: string) =>
    appService.saveDroppedImage(base64, filename),
  )

  // Test runner IPC
  ipcMain.handle("test:run", (_e, cwd: string, command?: string) =>
    testRunnerService.run(cwd, command),
  )

  // Layout IPC -- saved session snapshots
  ipcMain.handle("layout:list", () => layoutService.list())
  ipcMain.handle("layout:save", (_e, name: string) => layoutService.save(name))
  ipcMain.handle("layout:restore", (_e, name: string) => layoutService.restore(name))
  ipcMain.handle("layout:delete", (_e, name: string) => layoutService.delete(name))

  // Broadcast IPC -- fan one input out to many sessions at once
  ipcMain.handle(
    "broadcast:send",
    (_e, content: string, sessionIds?: string[], submit?: boolean) =>
      broadcastService.broadcast(content, sessionIds, submit),
  )

  // Notes IPC -- persistent cross-session scratchpad
  ipcMain.handle("notes:list", (_e, scope?: string, tag?: string) =>
    notesService.list(scope, tag),
  )
  ipcMain.handle("notes:get", (_e, id: string) => notesService.get(id))
  ipcMain.handle(
    "notes:save",
    (_e, title: string, body: string, opts?: { id?: string; scope?: string; tags?: string[] }) =>
      notesService.save(title, body, opts),
  )
  ipcMain.handle("notes:delete", (_e, id: string) => notesService.delete(id))
}
