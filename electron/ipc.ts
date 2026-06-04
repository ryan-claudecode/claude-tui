import { app, ipcMain, BrowserWindow } from "electron"
import { join } from "path"
import { SessionService } from "./services/sessions"
import { WorkspaceService } from "./services/workspaces"
import { AppService } from "./services/app"
import { PanelService } from "./services/panels"
import { NotificationService } from "./services/notifications"
import { GitService } from "./services/git"
import { TemplateService } from "./services/templates"
import { TestRunnerService } from "./services/tests"
import { LayoutService } from "./services/layouts"
import { SnippetService } from "./services/snippets"
import { BroadcastService } from "./services/broadcast"
import { CommandService } from "./services/commands"
import { ClipboardService } from "./services/clipboard"
import { ShellService } from "./services/shell"
import { NotesService } from "./services/notes"
import { TaskQueueService } from "./services/taskqueue"
import { SystemService } from "./services/system"
import { FileSearchService } from "./services/filesearch"
import { FileService } from "./services/files"
import { HttpService } from "./services/http"
import { PortService } from "./services/ports"
import { EditService } from "./services/edit"
import { ProcessService } from "./services/process"
import { EncodeService } from "./services/encode"
import { JsonService } from "./services/json"
import { loadConfig } from "./config"
import { startMcpServer } from "./mcp/server"

export const sessionService = new SessionService()
export const workspaceService = new WorkspaceService(sessionService)
export const appService = new AppService()
export const panelService = new PanelService()
export const notificationService = new NotificationService()
export const gitService = new GitService()
export const templateService = new TemplateService(sessionService)
export const testRunnerService = new TestRunnerService()
export const layoutService = new LayoutService(sessionService)
export const snippetService = new SnippetService(sessionService)
export const broadcastService = new BroadcastService(sessionService)
export const commandService = new CommandService()
export const clipboardService = new ClipboardService()
export const shellService = new ShellService()
export const notesService = new NotesService()
export const taskQueueService = new TaskQueueService()
export const systemService = new SystemService()
export const fileSearchService = new FileSearchService()
export const fileService = new FileService()
export const httpService = new HttpService()
export const portService = new PortService()
export const editService = new EditService()
export const processService = new ProcessService()
export const encodeService = new EncodeService()
export const jsonService = new JsonService()

export async function setupIpc(win: BrowserWindow) {
  const config = loadConfig()

  sessionService.setMainWindow(win)
  sessionService.setDefaults(
    config.defaultCommand ?? "claude",
    config.defaultArgs ?? ["--dangerously-skip-permissions"],
  )

  appService.setMainWindow(win)
  appService.setProjectRoot(join(__dirname, "../.."))

  panelService.setMainWindow(win)
  notificationService.setMainWindow(win)

  workspaceService.discover(config.workspaceScanPaths)

  // Start MCP server and configure sessions to auto-connect
  const { configPath } = await startMcpServer(
    sessionService,
    workspaceService,
    appService,
    panelService,
    notificationService,
    gitService,
    templateService,
    testRunnerService,
    layoutService,
    snippetService,
    broadcastService,
    commandService,
    clipboardService,
    shellService,
    notesService,
    taskQueueService,
    systemService,
    fileSearchService,
    fileService,
    httpService,
    portService,
    editService,
    processService,
    encodeService,
    jsonService,
  )
  sessionService.setMcpConfigPath(configPath)

  // Session IPC -- thin wrappers around service
  ipcMain.handle("session:create", (_e, name: string, cwd: string) =>
    sessionService.create(name, cwd),
  )
  ipcMain.handle("session:kill", (_e, id: string) => sessionService.kill(id))
  ipcMain.handle("session:focus", (_e, id: string) => sessionService.focus(id))
  ipcMain.handle("session:list", () => sessionService.list())
  ipcMain.handle("session:activity", () => sessionService.getActivity())
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
  ipcMain.handle("session:get-output", (_e, id: string, maxChars?: number) =>
    sessionService.getOutput(id, maxChars),
  )
  ipcMain.handle(
    "session:search-output",
    (_e, query: string, sessionId?: string, limit?: number) =>
      sessionService.searchOutput(query, sessionId, limit),
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
  ipcMain.handle("app:save-image", (_e, base64: string, filename: string) =>
    appService.saveDroppedImage(base64, filename),
  )

  // Panel IPC
  ipcMain.handle("panel:list", () => panelService.list())
  ipcMain.handle(
    "panel:show",
    (_e, type: string, props: Record<string, any>, position?: string) =>
      panelService.show(type, props, position),
  )
  ipcMain.handle("panel:hide", (_e, id: string) => panelService.hide(id))
  ipcMain.handle("panel:hide-all", () => panelService.hideAll())
  ipcMain.on("panel:form-submit", (_e, id: string, data: Record<string, any>) =>
    panelService.submitForm(id, data),
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

  // Snippet IPC -- reusable prompt snippets
  ipcMain.handle("snippet:list", () => snippetService.list())
  ipcMain.handle("snippet:save", (_e, name: string, content: string) =>
    snippetService.save(name, content),
  )
  ipcMain.handle("snippet:send", (_e, name: string, sessionId: string) =>
    snippetService.send(name, sessionId),
  )
  ipcMain.handle("snippet:delete", (_e, name: string) => snippetService.delete(name))

  // Broadcast IPC -- fan one input out to many sessions at once
  ipcMain.handle(
    "broadcast:send",
    (_e, content: string, sessionIds?: string[], submit?: boolean) =>
      broadcastService.broadcast(content, sessionIds, submit),
  )

  // Command IPC -- run an arbitrary shell command and capture its output
  ipcMain.handle("command:run", (_e, command: string, cwd: string, timeoutMs?: number) =>
    commandService.run(command, cwd, timeoutMs),
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

  // Task queue IPC -- shared job board across sessions
  ipcMain.handle("tasks:list", (_e, status?: any) => taskQueueService.list(status))
  ipcMain.handle("tasks:enqueue", (_e, title: string, detail?: string) =>
    taskQueueService.enqueue(title, detail),
  )
  ipcMain.handle("tasks:claim", (_e, id: string, by?: string) =>
    taskQueueService.claim(id, by),
  )
  ipcMain.handle("tasks:complete", (_e, id: string) => taskQueueService.complete(id))
  ipcMain.handle("tasks:delete", (_e, id: string) => taskQueueService.delete(id))
  ipcMain.handle("tasks:clear-done", () => taskQueueService.clearDone())

  // System IPC -- read-only environment lookups
  ipcMain.handle("system:info", () => systemService.getInfo())
  ipcMain.handle("system:which", (_e, command: string) => systemService.which(command))

  // Notification IPC
  ipcMain.handle("notification:list", () => notificationService.list())
  ipcMain.handle("notification:dismiss", (_e, id: string) =>
    notificationService.dismiss(id),
  )

  // Cleanup
  app.on("before-quit", () => sessionService.killAll())
}
