import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("companionApi", {
  onPanelShow: (cb: (panel: any) => void) =>
    ipcRenderer.on("panel:show", (_e, panel) => cb(panel)),
  onPanelUpdate: (cb: (payload: { id: string; props: any }) => void) =>
    ipcRenderer.on("panel:update", (_e, payload) => cb(payload)),
  onPanelHide: (cb: (id: string) => void) =>
    ipcRenderer.on("panel:hide", (_e, id) => cb(id)),
  onPanelHideAll: (cb: () => void) =>
    ipcRenderer.on("panel:hide-all", () => cb()),
  submitForm: (id: string, data: Record<string, any>) =>
    ipcRenderer.send("panel:form-submit", id, data),
  sendToSession: (text: string) =>
    ipcRenderer.send("companion:send-to-session", text),
  missionStop: (id: string) =>
    ipcRenderer.send("companion:mission-stop", id),
  missionPause: (id: string) =>
    ipcRenderer.send("companion:mission-pause", id),
  // WW-2b — worktree review approve/reject. `invoke` (not the fire-and-forget
  // `send` the mission controls use) so the review panel can reflect the result
  // (merged → close; conflict → show the preserved-branch conflict state).
  approveWorktreeTask: (missionId: string, taskId: string) =>
    ipcRenderer.invoke("worktree:approve", missionId, taskId),
  rejectWorktreeTask: (missionId: string, taskId: string, reason?: string) =>
    ipcRenderer.invoke("worktree:reject", missionId, taskId, reason),
  getTheme: () => ipcRenderer.invoke("config:get-theme"),
  onThemeChanged: (cb: (mode: string) => void) =>
    ipcRenderer.on("theme:changed", (_e, mode) => cb(mode)),
  removeAllListeners: (channel: string) =>
    ipcRenderer.removeAllListeners(channel),
  closeWindow: () => ipcRenderer.send("companion:close"),
  // Window controls (frameless)
  windowMinimize: () => ipcRenderer.send("companion:minimize"),
  windowMaximize: () => ipcRenderer.send("companion:maximize"),
  windowClose: () => ipcRenderer.send("companion:close"),
})
