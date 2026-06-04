import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("api", {
  // Session management
  createSession: (name: string, cwd: string) => ipcRenderer.invoke("session:create", name, cwd),
  killSession: (id: string) => ipcRenderer.invoke("session:kill", id),
  focusSession: (id: string) => ipcRenderer.invoke("session:focus", id),
  getSessions: () => ipcRenderer.invoke("session:list"),
  getSessionActivity: () => ipcRenderer.invoke("session:activity"),
  writeToSession: (id: string, data: string) => ipcRenderer.send("session:write", id, data),
  resizeSession: (id: string, cols: number, rows: number) => ipcRenderer.send("session:resize", id, cols, rows),
  getSessionOutput: (id: string, maxChars?: number) => ipcRenderer.invoke("session:get-output", id, maxChars),
  searchSessionOutput: (query: string, sessionId?: string, limit?: number) =>
    ipcRenderer.invoke("session:search-output", query, sessionId, limit),

  // Workspace management
  getWorkspaces: () => ipcRenderer.invoke("workspace:list"),
  activateWorkspace: (index: number) => ipcRenderer.invoke("workspace:activate", index),

  // Session rename
  renameSession: (id: string, newName: string) => ipcRenderer.invoke("session:rename", id, newName),

  // Config
  getConfig: () => ipcRenderer.invoke("config:get"),

  // Handoff
  triggerHandoff: (id: string) => ipcRenderer.invoke("session:handoff", id),

  // App testing
  takeScreenshot: () => ipcRenderer.invoke("app:screenshot"),
  getAppState: () => ipcRenderer.invoke("app:state"),
  saveDroppedImage: (base64: string, filename: string) =>
    ipcRenderer.invoke("app:save-image", base64, filename),

  // Panels
  showPanel: (type: string, props: Record<string, any>, position?: string) =>
    ipcRenderer.invoke("panel:show", type, props, position),
  listPanels: () => ipcRenderer.invoke("panel:list"),
  hidePanel: (id: string) => ipcRenderer.invoke("panel:hide", id),
  hideAllPanels: () => ipcRenderer.invoke("panel:hide-all"),
  submitForm: (id: string, data: Record<string, any>) =>
    ipcRenderer.send("panel:form-submit", id, data),

  // Broadcast -- send one input to many sessions at once
  broadcastInput: (content: string, sessionIds?: string[], submit?: boolean) =>
    ipcRenderer.invoke("broadcast:send", content, sessionIds, submit),

  // Command runner -- run a one-off shell command and capture output
  runCommand: (command: string, cwd: string, timeoutMs?: number) =>
    ipcRenderer.invoke("command:run", command, cwd, timeoutMs),

  // Notifications
  listNotifications: () => ipcRenderer.invoke("notification:list"),
  dismissNotification: (id: string) => ipcRenderer.invoke("notification:dismiss", id),
  onNotificationShow: (callback: (notification: any) => void) =>
    ipcRenderer.on("notification:show", (_e, notification) => callback(notification)),
  onNotificationDismiss: (callback: (id: string) => void) =>
    ipcRenderer.on("notification:dismiss", (_e, id) => callback(id)),

  // Events from main -> renderer
  onSessionData: (callback: (id: string, data: string) => void) =>
    ipcRenderer.on("session:data", (_e, id, data) => callback(id, data)),
  onSessionExit: (callback: (id: string) => void) =>
    ipcRenderer.on("session:exit", (_e, id) => callback(id)),
  onSessionCreated: (callback: (session: any) => void) =>
    ipcRenderer.on("session:created", (_e, session) => callback(session)),
  onSessionState: (callback: (id: string, state: string) => void) =>
    ipcRenderer.on("session:state", (_e, id, state) => callback(id, state)),

  // Split pane events from main (triggered by MCP tools)
  onSplitSet: (callback: (leftId: string, rightId: string) => void) =>
    ipcRenderer.on("split:set", (_e, leftId, rightId) => callback(leftId, rightId)),
  onSplitClose: (callback: () => void) =>
    ipcRenderer.on("split:close", () => callback()),

  // Panel events from main (triggered by MCP tools)
  onPanelShow: (callback: (panel: any) => void) =>
    ipcRenderer.on("panel:show", (_e, panel) => callback(panel)),
  onPanelUpdate: (callback: (payload: { id: string; props: any }) => void) =>
    ipcRenderer.on("panel:update", (_e, payload) => callback(payload)),
  onPanelHide: (callback: (id: string) => void) =>
    ipcRenderer.on("panel:hide", (_e, id) => callback(id)),
  onPanelHideAll: (callback: () => void) =>
    ipcRenderer.on("panel:hide-all", () => callback()),

  // Cleanup
  removeAllListeners: (channel: string) => ipcRenderer.removeAllListeners(channel),
})
