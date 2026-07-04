import { contextBridge, ipcRenderer } from "electron"

// CAPP-106 / S1 — capture the exposed object in a const so its INFERRED shape can be
// exported (`CompanionApi`) and structurally checked against `PanelApi` by the parity
// GATE (src/lib/panelApiParity.test.ts).
const companionApi = {
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
  // CAPP-115 (SCHED-2) — schedule detail-panel controls from a POPPED-OUT companion.
  // These invoke the SAME `schedule:*` handlers the main window uses (they're
  // `ipcMain.handle`, so a companion `invoke` reaches them). Edit routes through
  // `schedule:request-edit`, which forwards `schedule:edit` to the MAIN window's overlay.
  scheduleRunNow: (id: string) => ipcRenderer.invoke("schedule:run-now", id),
  scheduleSetEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke("schedule:update", id, { enabled }),
  scheduleDelete: (id: string) => ipcRenderer.invoke("schedule:delete", id),
  requestScheduleEdit: (id: string) => ipcRenderer.invoke("schedule:request-edit", id),
  // CAPP-115 review — close a panel by PANEL id via PanelService.hide (the same
  // `panel:hide` invoke the main window uses). PanelService routes panel:hide back to
  // every surface the panel lives on, so the companion's own onPanelHide drops it.
  hidePanel: (panelId: string) => ipcRenderer.invoke("panel:hide", panelId),
  // Open a SessionOverview panel for a session (click-to-open). Fetches the overview,
  // then shows it as a panel in this same companion window via the generic panel:show path.
  openSessionOverview: async (sessionId: string) => {
    const ov = await ipcRenderer.invoke("worksession:overview", sessionId)
    if (!ov) return null
    return ipcRenderer.invoke("panel:show", "session-overview", ov, "right")
  },
  // CAPP-98 / I1 — the Context Inspector (READ-ONLY). The ContextInspectorPanel lives in
  // THIS companion window; its statically-visible Refresh button re-invokes this to pull a
  // fresh enumeration of the launch-time NATIVE context. A `null` workspaceId is the untagged
  // "All" bucket. Pure read — no native-file write path.
  inspectWorkspaceContext: (workspaceId: string | null) =>
    ipcRenderer.invoke("context:inspect", workspaceId),
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
}

/** The inferred shape of the companion-window bridge — consumed ONLY by the type-parity
 *  GATE (src/lib/panelApiParity.test.ts). Type-only; never imported at runtime. */
export type CompanionApi = typeof companionApi

contextBridge.exposeInMainWorld("companionApi", companionApi)
