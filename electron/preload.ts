import { contextBridge, ipcRenderer } from "electron"
import {
  TERMINAL_STREAM_CHANNEL,
  PERMISSION_REQUEST_CHANNEL,
  PERMISSION_RESOLVED_CHANNEL,
  type TerminalStreamPayload,
  type PermissionRequest,
  type PermissionDecision,
} from "./services/streamProtocol"

contextBridge.exposeInMainWorld("api", {
  // Platform info (used by renderer for cross-platform key mapping)
  platform: process.platform,

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
  getSessionTimeline: (sessionId: string) =>
    ipcRenderer.invoke("worksession:timeline", sessionId),
  handoffTerminal: (sessionId: string, terminalId: string) =>
    ipcRenderer.invoke("worksession:handoff", sessionId, terminalId),
  // CAPP-39 gate ② — launch an interactive `claude /login` terminal from the
  // structured engine's "not signed in" Sign-in button (headless can't show OAuth).
  startLogin: (sessionId?: string) => ipcRenderer.invoke("worksession:start-login", sessionId),
  // BO-6 — switch a structured terminal's --model (respawns + resumes the chat)
  setTerminalModel: (sessionId: string, terminalId: string, model: string) =>
    ipcRenderer.invoke("worksession:set-terminal-model", sessionId, terminalId, model),
  // CAPP-46 — switch a structured terminal's reasoning --effort level (respawns +
  // resumes the chat); a blank value clears it (the respawn omits --effort).
  setTerminalEffort: (sessionId: string, terminalId: string, effort: string) =>
    ipcRenderer.invoke("worksession:set-terminal-effort", sessionId, terminalId, effort),
  // CAPP-39 gate ③ — the per-terminal raw-view escape hatch: toggle one terminal
  // between the structured and xterm engines at runtime (respawns + resumes the chat).
  // Returns the new terminal id so the caller re-points the active selection.
  setTerminalEngine: (sessionId: string, terminalId: string, targetEngine: "xterm" | "structured") =>
    ipcRenderer.invoke("worksession:set-terminal-engine", sessionId, terminalId, targetEngine),
  // BO-10 — stop/interrupt a structured terminal mid-turn: kills the proc (denying
  // any pending permission) and respawns the SAME conversation via --resume.
  // Returns the new terminal id so the caller re-points the active selection (the
  // respawn mints a fresh id, like the model switch).
  interruptAgent: (terminalId: string) => ipcRenderer.invoke("agent:interrupt", terminalId),

  // Workspace management
  getWorkspaces: () => ipcRenderer.invoke("workspace:list"),
  activateWorkspace: (index: number) => ipcRenderer.invoke("workspace:activate", index),

  // WS-B — id-based workspace registry ops (all return the PUBLIC projection;
  // never the internal seed* fields). SELECTION (`setActiveWorkspace`) is split
  // from LAUNCH (`launchWorkspace`): set-active only marks + persists + emits
  // `workspace:active-changed`; launch spawns editors + sessions. The legacy
  // index-based `activateWorkspace` above stays for the current renderer wiring
  // (the id-based selection cutover is WS-D).
  getWorkspace: (id: string) => ipcRenderer.invoke("workspace:get", id),
  getActiveWorkspace: () => ipcRenderer.invoke("workspace:get-active"),
  createWorkspace: (name: string, dirs?: string[]) =>
    ipcRenderer.invoke("workspace:create", name, dirs),
  renameWorkspace: (id: string, name: string) =>
    ipcRenderer.invoke("workspace:rename", id, name),
  addWorkspaceDir: (id: string, dir: string) =>
    ipcRenderer.invoke("workspace:add-dir", id, dir),
  removeWorkspaceDir: (id: string, dir: string) =>
    ipcRenderer.invoke("workspace:remove-dir", id, dir),
  deleteWorkspace: (id: string) => ipcRenderer.invoke("workspace:delete", id),
  setActiveWorkspace: (id: string | null) => ipcRenderer.invoke("workspace:set-active", id),
  launchWorkspace: (id: string) => ipcRenderer.invoke("workspace:launch", id),
  // WS-B — active-workspace change events from main (payload = public workspace
  // or null). Mirrors onMissionUpdated; WS-D consumes it for the sidebar switcher.
  onWorkspaceActiveChanged: (callback: (workspace: any | null) => void) =>
    ipcRenderer.on("workspace:active-changed", (_e, workspace) => callback(workspace)),

  // Session rename
  renameSession: (id: string, newName: string) => ipcRenderer.invoke("terminal:rename", id, newName),

  // Config
  getConfig: () => ipcRenderer.invoke("config:get"),

  // Theme
  getTheme: () => ipcRenderer.invoke("config:get-theme"),
  setTheme: (mode: string) => ipcRenderer.invoke("config:set-theme", mode),
  onThemeChanged: (callback: (mode: string) => void) =>
    ipcRenderer.on("theme:changed", (_e, mode) => callback(mode)),

  // Window controls (frameless)
  windowMinimize: () => ipcRenderer.send("window:minimize"),
  windowMaximize: () => ipcRenderer.send("window:maximize"),
  windowClose: () => ipcRenderer.send("window:close"),

  // PP: raise the companion window (panel presence indicator click)
  focusCompanion: () => ipcRenderer.send("companion:focus"),

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
  // Durable delete (sidebar ✕) — terminal-state only; main process emits
  // mission:removed so useMissions drops the row (no renderer-only Set).
  deleteMission: (id: string) => ipcRenderer.invoke("mission:delete", id),

  // WW-2b — worktree review: approve merges the worker's branch, reject discards
  // it (back to pending). Both return the resulting task state ({ status,
  // reviewReason } | null). getReviewTask fetches the latest captured diff so the
  // review panel always has fresh content when opened from an attention jump.
  approveWorktreeTask: (missionId: string, taskId: string) =>
    ipcRenderer.invoke("worktree:approve", missionId, taskId),
  rejectWorktreeTask: (missionId: string, taskId: string, reason?: string) =>
    ipcRenderer.invoke("worktree:reject", missionId, taskId, reason),
  getReviewTask: (missionId: string, taskId: string) =>
    ipcRenderer.invoke("worktree:get-review-task", missionId, taskId),

  // Broadcast -- send one input to many sessions at once
  broadcastInput: (content: string, sessionIds?: string[], submit?: boolean) =>
    ipcRenderer.invoke("broadcast:send", content, sessionIds, submit),

  // Notifications
  listNotifications: () => ipcRenderer.invoke("notification:list"),
  dismissNotification: (id: string) => ipcRenderer.invoke("notification:dismiss", id),
  onNotificationShow: (callback: (notification: any) => void) =>
    ipcRenderer.on("notification:show", (_e, notification) => callback(notification)),
  onNotificationDismiss: (callback: (id: string) => void) =>
    ipcRenderer.on("notification:dismiss", (_e, id) => callback(id)),

  // Attention queue (AQ-2) — "who needs me?" the renderer is a thin view
  attentionSeen: (terminalId: string) => ipcRenderer.invoke("attention:seen", terminalId),
  attentionSeenMission: (missionId: string) => ipcRenderer.invoke("attention:seen-mission", missionId),
  attentionDismiss: (id: string) => ipcRenderer.invoke("attention:dismiss", id),
  onAttentionUpdated: (callback: (entries: any[]) => void) =>
    ipcRenderer.on("attention:updated", (_e, entries) => callback(entries)),
  onAttentionJump: (callback: (id: string) => void) =>
    ipcRenderer.on("attention:jump", (_e, id) => callback(id)),

  // Mission push events from main (MS-2 — replaces polling in usePanels)
  onMissionUpdated: (callback: (mission: any) => void) =>
    ipcRenderer.on("mission:updated", (_e, mission) => callback(mission)),
  onMissionRemoved: (callback: (id: string) => void) =>
    ipcRenderer.on("mission:removed", (_e, id) => callback(id)),

  // Events from main -> renderer
  onSessionData: (callback: (id: string, data: string) => void) =>
    ipcRenderer.on("terminal:data", (_e, id, data) => callback(id, data)),

  // BO-2: structured headless stream events (parsed StreamEvents forwarded from
  // TerminalService.onEvent). Mirrors onSessionData but returns a PER-INSTANCE
  // unsubscribe so an AgentView's listener can be torn down on unmount without
  // clobbering sibling panes (a generic removeAllListeners would).
  onStreamEvent: (callback: (payload: TerminalStreamPayload) => void) => {
    const handler = (_e: unknown, payload: TerminalStreamPayload) => callback(payload)
    ipcRenderer.on(TERMINAL_STREAM_CHANNEL, handler)
    return () => ipcRenderer.removeListener(TERMINAL_STREAM_CHANNEL, handler)
  },

  // BO-3 — AgentComposer: send a structured human→agent message (text + image
  // attachment paths). Fire-and-forget; the main process folds it into an
  // AgentUserMessage and routes it to the headless stdin sink.
  sendAgentInput: (terminalId: string, msg: { text?: string; attachments?: string[] }) =>
    ipcRenderer.send("agent:send-input", terminalId, msg),

  // BO-7 — the structured composer's `/`-picker catalog (slash commands + skills)
  // captured off the headless `init` event. Returns null until init arrives.
  getAgentCatalog: (terminalId: string) => ipcRenderer.invoke("agent:catalog", terminalId),

  // BO-12 — prior turns of a conversation (by its Claude Code id), read off the
  // on-disk transcript, to rehydrate a respawned/restored structured chat view.
  getTranscriptEvents: (ccConversationId: string) =>
    ipcRenderer.invoke("transcript:get-events", ccConversationId),

  // BO-7 — a native-mapped slash command (e.g. /config, /resume) fired an app
  // affordance instead of being sent to Claude. Per-instance unsubscribe so the
  // App listener can be torn down cleanly.
  onUiSlashCommand: (
    callback: (payload: { command: string; terminalId: string }) => void,
  ) => {
    const handler = (_e: unknown, payload: { command: string; terminalId: string }) =>
      callback(payload)
    ipcRenderer.on("ui:slash-command", handler)
    return () => ipcRenderer.removeListener("ui:slash-command", handler)
  },

  // BO-3 — permission gate. onPermissionRequest/onPermissionResolved mirror
  // onStreamEvent's per-instance unsubscribe so usePermissions can tear down on
  // unmount without clobbering siblings. resolvePermission returns whether a
  // pending request was actually resolved.
  onPermissionRequest: (callback: (req: PermissionRequest) => void) => {
    const handler = (_e: unknown, req: PermissionRequest) => callback(req)
    ipcRenderer.on(PERMISSION_REQUEST_CHANNEL, handler)
    return () => ipcRenderer.removeListener(PERMISSION_REQUEST_CHANNEL, handler)
  },
  onPermissionResolved: (callback: (id: string) => void) => {
    const handler = (_e: unknown, id: string) => callback(id)
    ipcRenderer.on(PERMISSION_RESOLVED_CHANNEL, handler)
    return () => ipcRenderer.removeListener(PERMISSION_RESOLVED_CHANNEL, handler)
  },
  resolvePermission: (id: string, decision: PermissionDecision) =>
    ipcRenderer.invoke("permission:resolve", id, decision),
  // CAPP-49 — per-instance disposer (mirrors onTerminalState) so a subscriber (e.g.
  // useGeneratingTerminals, which prunes a respawned/killed id from the busy set on
  // exit) can tear down its own handler without a removeAllListeners clobbering it.
  onSessionExit: (callback: (id: string) => void) => {
    const handler = (_e: unknown, id: string) => callback(id)
    ipcRenderer.on("terminal:exit", handler)
    return () => ipcRenderer.removeListener("terminal:exit", handler)
  },
  onSessionCreated: (callback: (session: any) => void) =>
    ipcRenderer.on("terminal:created", (_e, session) => callback(session)),
  // BO-10 — per-instance disposer (mirrors onStreamEvent) so multiple subscribers
  // can share the terminal:state channel without a removeAllListeners clobbering
  // each other. usePanels (overview refresh) AND useAgentBusy (composer Stop/Send
  // gating) both subscribe; each tears down only its own handler.
  onTerminalState: (callback: (id: string, state: string) => void) => {
    const handler = (_e: unknown, id: string, state: string) => callback(id, state)
    ipcRenderer.on("terminal:state", handler)
    return () => ipcRenderer.removeListener("terminal:state", handler)
  },
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
