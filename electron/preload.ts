import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("api", {
  // Session management
  createSession: (name: string, cwd: string) => ipcRenderer.invoke("terminal:create", name, cwd),
  killSession: (id: string) => ipcRenderer.invoke("terminal:kill", id),
  focusSession: (id: string) => ipcRenderer.invoke("terminal:focus", id),
  getSessions: () => ipcRenderer.invoke("terminal:list"),
  getSessionActivity: () => ipcRenderer.invoke("terminal:activity"),
  writeToSession: (id: string, data: string) => ipcRenderer.send("terminal:write", id, data),
  resizeSession: (id: string, cols: number, rows: number) => ipcRenderer.send("terminal:resize", id, cols, rows),
  getSessionOutput: (id: string, maxChars?: number) => ipcRenderer.invoke("terminal:get-output", id, maxChars),
  searchSessionOutput: (query: string, sessionId?: string, limit?: number) =>
    ipcRenderer.invoke("terminal:search-output", query, sessionId, limit),

  // Work-session (container) management -- the durable session tier above terminals
  listWorkSessions: () => ipcRenderer.invoke("worksession:list"),
  openWorkSession: (cwd?: string) => ipcRenderer.invoke("worksession:open", cwd),
  addTerminal: (sessionId: string, cwd?: string) =>
    ipcRenderer.invoke("worksession:add-terminal", sessionId, cwd),
  reopenTerminal: (sessionId: string, terminalId: string) =>
    ipcRenderer.invoke("worksession:reopen-terminal", sessionId, terminalId),
  closeTerminal: (sessionId: string, terminalId: string) =>
    ipcRenderer.invoke("worksession:close-terminal", sessionId, terminalId),
  killWorkSession: (sessionId: string) => ipcRenderer.invoke("worksession:kill", sessionId),
  getWorkSessionContext: (sessionId: string) =>
    ipcRenderer.invoke("worksession:context", sessionId),
  getSessionOverview: (sessionId: string) =>
    ipcRenderer.invoke("worksession:overview", sessionId),
  handoffTerminal: (sessionId: string, terminalId: string) =>
    ipcRenderer.invoke("worksession:handoff", sessionId, terminalId),

  // Workspace management
  getWorkspaces: () => ipcRenderer.invoke("workspace:list"),
  activateWorkspace: (index: number) => ipcRenderer.invoke("workspace:activate", index),

  // Session rename
  renameSession: (id: string, newName: string) => ipcRenderer.invoke("terminal:rename", id, newName),

  // Config
  getConfig: () => ipcRenderer.invoke("config:get"),

  // Handoff
  triggerHandoff: (id: string) => ipcRenderer.invoke("terminal:handoff", id),

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

  // Mission orchestration
  createMission: (goal: string, cwd: string, autonomy?: string) =>
    ipcRenderer.invoke("mission:create", goal, cwd, autonomy),
  listMissions: () => ipcRenderer.invoke("mission:list"),
  getMissionStatus: (id?: string) => ipcRenderer.invoke("mission:status", id),
  stopMission: (id: string) => ipcRenderer.invoke("mission:stop", id),
  pauseMission: (id: string) => ipcRenderer.invoke("mission:pause", id),
  resumeMission: (id: string) => ipcRenderer.invoke("mission:resume", id),

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
    ipcRenderer.on("terminal:data", (_e, id, data) => callback(id, data)),
  onSessionExit: (callback: (id: string) => void) =>
    ipcRenderer.on("terminal:exit", (_e, id) => callback(id)),
  onSessionCreated: (callback: (session: any) => void) =>
    ipcRenderer.on("terminal:created", (_e, session) => callback(session)),
  onSessionState: (callback: (id: string, state: string) => void) =>
    ipcRenderer.on("terminal:state", (_e, id, state) => callback(id, state)),
  onSessionRenamed: (callback: (id: string, newName: string) => void) =>
    ipcRenderer.on("terminal:renamed", (_e, id, newName) => callback(id, newName)),

  // Work-session (container) update events from main
  onWorkSessionUpdated: (callback: (session: any) => void) =>
    ipcRenderer.on("worksession:updated", (_e, session) => callback(session)),
  onWorkSessionRemoved: (callback: (id: string) => void) =>
    ipcRenderer.on("worksession:removed", (_e, id) => callback(id)),

  // Session focus event from main (triggered by the focus_session MCP tool)
  onSessionFocus: (callback: (id: string) => void) =>
    ipcRenderer.on("terminal:focus", (_e, id) => callback(id)),

  // Split pane events from main (triggered by MCP tools)
  onSplitSet: (callback: (leftId: string, rightId: string) => void) =>
    ipcRenderer.on("split:set", (_e, leftId, rightId) => callback(leftId, rightId)),
  onSplitClose: (callback: () => void) =>
    ipcRenderer.on("split:close", () => callback()),

  // UI control events from main (triggered by the App UI control MCP tools).
  // The boolean payload is the desired state; `undefined`/`null` means toggle.
  onUiFocusMode: (callback: (enabled?: boolean) => void) =>
    ipcRenderer.on("ui:focus-mode", (_e, enabled) => callback(enabled ?? undefined)),
  onUiDrawer: (callback: (collapsed?: boolean) => void) =>
    ipcRenderer.on("ui:drawer", (_e, collapsed) => callback(collapsed ?? undefined)),
  onUiCommandPalette: (callback: (open?: boolean) => void) =>
    ipcRenderer.on("ui:command-palette", (_e, open) => callback(open ?? undefined)),
  onUiShortcutsHelp: (callback: (open?: boolean) => void) =>
    ipcRenderer.on("ui:shortcuts-help", (_e, open) => callback(open ?? undefined)),
  onUiHistorySearch: (callback: (open?: boolean) => void) =>
    ipcRenderer.on("ui:history-search", (_e, open) => callback(open ?? undefined)),
  onUiExportLog: (callback: (sessionId: string | null) => void) =>
    ipcRenderer.on("ui:export-log", (_e, sessionId) => callback(sessionId)),

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
