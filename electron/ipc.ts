import { app, ipcMain, BrowserWindow } from "electron"
import { join } from "path"
import { SessionService } from "./services/sessions"
import { WorkspaceService } from "./services/workspaces"
import { AppService } from "./services/app"
import { loadConfig } from "./config"
import { startMcpServer } from "./mcp/server"

export const sessionService = new SessionService()
export const workspaceService = new WorkspaceService(sessionService)
export const appService = new AppService()

export async function setupIpc(win: BrowserWindow) {
  const config = loadConfig()

  sessionService.setMainWindow(win)
  sessionService.setDefaults(
    config.defaultCommand ?? "claude",
    config.defaultArgs ?? ["--dangerously-skip-permissions"],
  )

  appService.setMainWindow(win)
  appService.setProjectRoot(join(__dirname, "../.."))

  workspaceService.discover(config.workspaceScanPaths)

  // Start MCP server and configure sessions to auto-connect
  const { configPath } = await startMcpServer(sessionService, workspaceService, appService)
  sessionService.setMcpConfigPath(configPath)

  // Session IPC -- thin wrappers around service
  ipcMain.handle("session:create", (_e, name: string, cwd: string) =>
    sessionService.create(name, cwd),
  )
  ipcMain.handle("session:kill", (_e, id: string) => sessionService.kill(id))
  ipcMain.handle("session:focus", (_e, id: string) => sessionService.focus(id))
  ipcMain.handle("session:list", () => sessionService.list())
  ipcMain.handle("session:rename", (_e, id: string, newName: string) =>
    sessionService.rename(id, newName),
  )
  ipcMain.handle("session:handoff", (_e, id: string) => sessionService.handoff(id))
  ipcMain.on("session:write", (_e, id: string, data: string) =>
    sessionService.write(id, data),
  )
  ipcMain.on("session:resize", (_e, id: string, cols: number, rows: number) =>
    sessionService.resize(id, cols, rows),
  )

  // Workspace IPC
  ipcMain.handle("workspace:list", () =>
    workspaceService.list().map((ws) => ({
      name: ws.name,
      alias: ws.alias,
      editor: ws.editor,
      repos: ws.repos,
    })),
  )
  ipcMain.handle("workspace:activate", (_e, index: number) =>
    workspaceService.activate(index),
  )

  // Config
  ipcMain.handle("config:get", () => config)

  // App testing tools
  ipcMain.handle("app:screenshot", async () => appService.captureScreenshot())
  ipcMain.handle("app:state", () =>
    appService.getAppState(sessionService.list(), workspaceService.list()),
  )

  // Cleanup
  app.on("before-quit", () => sessionService.killAll())
}
