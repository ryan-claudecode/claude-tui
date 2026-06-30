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
  // CAPP-94 / U6 — workspace-memory editor accessors. The WorkspaceMemoryPanel lives
  // in THIS companion window, so it edits via companionApi (mirroring how the WW-2b
  // approve/reject accessors live here). U3 added these to the MAIN preload only.
  // A `null` workspaceId addresses the untagged "All" bucket. Every mutator fires the
  // main process's onMemoryChanged seam (invalidates recall + pushes
  // `workspace:memory-changed`), which the panel + CompanionApp live-refresh on.
  getWorkspaceMemory: (workspaceId: string | null) =>
    ipcRenderer.invoke("workspace:get-memory", workspaceId),
  setWorkspaceInstructions: (workspaceId: string | null, text: string) =>
    ipcRenderer.invoke("workspace:set-instructions", workspaceId, text),
  addWorkspaceFinding: (workspaceId: string | null, text: string, source: "user" | "agent") =>
    ipcRenderer.invoke("workspace:add-finding", workspaceId, text, source),
  editWorkspaceFinding: (workspaceId: string | null, findingId: string, text: string) =>
    ipcRenderer.invoke("workspace:edit-finding", workspaceId, findingId, text),
  deleteWorkspaceFinding: (workspaceId: string | null, findingId: string) =>
    ipcRenderer.invoke("workspace:delete-finding", workspaceId, findingId),
  // CAPP-97 — pin/unpin a finding (a pinned finding is never evicted under the auto-load
  // context cap). Fires onMemoryChanged → the panel live-refreshes off memory-changed.
  setWorkspaceFindingPinned: (workspaceId: string | null, findingId: string, pinned: boolean) =>
    ipcRenderer.invoke("workspace:set-pinned", workspaceId, findingId, pinned),
  // Per-instance unsubscribe (mirrors the main preload's onWorkspaceMemoryChanged) so
  // the panel + CompanionApp can each subscribe + tear down independently.
  onWorkspaceMemoryChanged: (cb: (workspaceId: string) => void) => {
    const handler = (_e: unknown, workspaceId: string) => cb(workspaceId)
    ipcRenderer.on("workspace:memory-changed", handler)
    return () => ipcRenderer.removeListener("workspace:memory-changed", handler)
  },
  // CAPP-94 / U6 — promote a session's findings into its OWNING workspace memory (the
  // SessionOverviewPanel "Push context to workspace" button). The owning workspace is
  // resolved MAIN-side (never the active selection); the panel only passes the session id.
  promoteSessionToWorkspace: (sessionId: string) =>
    ipcRenderer.invoke("worksession:promote-to-workspace", sessionId),
  // CAPP-98 / I1 — the Context Inspector (READ-ONLY). The ContextInspectorPanel lives in
  // THIS companion window; its statically-visible Refresh button re-invokes this to pull a
  // fresh enumeration of the launch-time native context + our injected primer. A `null`
  // workspaceId is the untagged "All" bucket. Pure read — no native-file write path.
  inspectWorkspaceContext: (workspaceId: string | null) =>
    ipcRenderer.invoke("context:inspect", workspaceId),
  // CAPP-99 / E1 — export accessors. The export control lives in THIS companion window's
  // WorkspaceMemoryPanel. STRICTLY one-directional (store → file): these only read state or
  // trigger a regen — there is no file → store accessor anywhere. A `null` workspaceId is the
  // untagged "All" bucket.
  getExportState: (workspaceId: string | null) =>
    ipcRenderer.invoke("export:get-state", workspaceId),
  enableExport: (workspaceId: string | null, mode: "A" | "C", customPath?: string) =>
    ipcRenderer.invoke("export:enable", workspaceId, mode, customPath),
  disableExport: (workspaceId: string | null) =>
    ipcRenderer.invoke("export:disable", workspaceId),
  setUntaggedExportEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("export:set-untagged-enabled", enabled),
  regenerateExport: (workspaceId: string | null) =>
    ipcRenderer.invoke("export:regenerate", workspaceId),
  // CAPP-100 / E2 — adoption: the reversible CLAUDE.local.md insert/Unwire (NON-MCP, user-driven
  // only — no agent can reach these) + the read-only adoption probe. Appends/removes ONLY our
  // delimited block; change-guarded; Unwire refuses on a user edit inside the delimiters.
  getAdoptionState: (workspaceId: string | null) =>
    ipcRenderer.invoke("adoption:get-state", workspaceId),
  wireImportBlock: (workspaceId: string | null) =>
    ipcRenderer.invoke("adoption:wire", workspaceId),
  unwireImportBlock: (workspaceId: string | null) =>
    ipcRenderer.invoke("adoption:unwire", workspaceId),
  setExportSelfWired: (workspaceId: string | null, selfWired: boolean) =>
    ipcRenderer.invoke("adoption:set-self-wired", workspaceId, selfWired),
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
