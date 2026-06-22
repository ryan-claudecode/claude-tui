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
  // CAPP-86 — "The Lexicon": read-only cross-session recall, so the RecallPanel
  // (which lives in THIS companion window) can search every finding + summary. Pure
  // reads — they cannot mutate any canonical session file.
  recall: (query: string, scope?: "session" | "workspace" | "all", sessionId?: string) =>
    ipcRenderer.invoke("worksession:recall", query, scope, sessionId),
  recallSummary: (scope?: "session" | "workspace" | "all", sessionId?: string) =>
    ipcRenderer.invoke("worksession:recall-summary", scope, sessionId),
  // CAPP-86 — open a SessionOverview panel for a recall hit's owning session
  // (click-to-open). Fetches the overview, then shows it as a panel in this same
  // companion window via the existing generic panel:show path.
  openSessionOverview: async (sessionId: string) => {
    const ov = await ipcRenderer.invoke("worksession:overview", sessionId)
    if (!ov) return null
    return ipcRenderer.invoke("panel:show", "session-overview", ov, "right")
  },
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
