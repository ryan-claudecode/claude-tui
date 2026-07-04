import { contextBridge, ipcRenderer } from "electron"
import {
  TERMINAL_STREAM_CHANNEL,
  PERMISSION_REQUEST_CHANNEL,
  PERMISSION_RESOLVED_CHANNEL,
  type TerminalStreamPayload,
  type PermissionRequest,
  type PermissionDecision,
} from "./services/streamProtocol"
import type { SttProgress } from "./stt/protocol"

// CAPP-106 / S1 — capture the exposed object in a const so its INFERRED shape can be
// exported (`MainApi`) and structurally checked against `PanelApi` by the parity GATE
// (src/lib/panelApiParity.test.ts). The build fails if window.api ever lacks a method a
// behavior panel needs — the standing guard against the F1 class of drift.
const mainApi = {
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
  // CAPP-75 — list a folder's resumable Claude Code conversations (including ones
  // started outside the app), newest first. Read-only discovery.
  listFolderConversations: (folder: string) =>
    ipcRenderer.invoke("worksession:list-folder-conversations", folder),
  // CAPP-75 — restore one of those conversations: spawns `claude --resume <id>` in
  // the folder as a new work session. Returns { session, terminalId } or undefined.
  restoreConversation: (folder: string, conversationId: string) =>
    ipcRenderer.invoke("worksession:restore-conversation", folder, conversationId),
  reopenTerminal: (sessionId: string, terminalId: string) =>
    ipcRenderer.invoke("worksession:reopen-terminal", sessionId, terminalId),
  // CAPP-101 (P1) — the propagation nudge re-prime: bracket-paste the get_session_context PULL
  // prompt to a running terminal whose workspace memory changed since spawn, and clear its
  // pending-delta mark. It PROMPTS the pull — it does NOT itself inject the finding.
  reprimeTerminal: (sessionId: string, terminalId: string) =>
    ipcRenderer.invoke("worksession:reprime", sessionId, terminalId),
  closeTerminal: (sessionId: string, terminalId: string) =>
    ipcRenderer.invoke("worksession:close-terminal", sessionId, terminalId),
  killWorkSession: (sessionId: string) => ipcRenderer.invoke("worksession:kill", sessionId),
  // CAPP-82 — rename the durable work-session container (the sidebar row). A NEW
  // accessor distinct from `renameSession` above, which is the TERMINAL-tier rename
  // (-> terminal:rename) despite its name. Returns whether the rename applied.
  renameWorkSession: (id: string, name: string) =>
    ipcRenderer.invoke("worksession:rename", id, name),
  getWorkSessionContext: (sessionId: string) =>
    ipcRenderer.invoke("worksession:context", sessionId),
  // CAPP-86 — "The Lexicon": read-only cross-session recall. recall returns ranked
  // hits for a query (scope defaults to the caller-session's workspace); recallSummary
  // returns the cross-session count digest (+ most-recent ruled-out one-liner) for the
  // Rail KNOWS section. Both are pure reads — they never mutate canonical session files.
  recall: (query: string, scope?: "session" | "workspace" | "all", sessionId?: string) =>
    ipcRenderer.invoke("worksession:recall", query, scope, sessionId),
  recallSummary: (scope?: "session" | "workspace" | "all", sessionId?: string) =>
    ipcRenderer.invoke("worksession:recall-summary", scope, sessionId),
  getSessionOverview: (sessionId: string) =>
    ipcRenderer.invoke("worksession:overview", sessionId),
  // CAPP-106 / S1 (F1) — main-window parity for the two previously companion-ONLY
  // PanelApi accessors. openSessionOverview fetches a session's overview and SHOWS it
  // as a panel (recursive-by-design from the modal — RecallPanel's session-header click);
  // promoteSessionToWorkspace promotes a session's findings into its OWNING workspace
  // (resolved main-side from the bare sessionId — the SessionOverviewPanel "Push context
  // to workspace" button). The parity GATE (src/lib/panelApiParity.test.ts) fails the
  // build if either is missing from window.api.
  openSessionOverview: (sessionId: string) =>
    ipcRenderer.invoke("worksession:open-overview", sessionId),
  promoteSessionToWorkspace: (sessionId: string) =>
    ipcRenderer.invoke("worksession:promote-to-workspace", sessionId),
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
  // CAPP-108 — toggle a structured terminal's ultracode posture (respawns + resumes
  // the chat); ON adds `--settings '{"ultracode":true}'` + omits --effort.
  setTerminalUltracode: (sessionId: string, terminalId: string, ultracode: boolean) =>
    ipcRenderer.invoke("worksession:set-terminal-ultracode", sessionId, terminalId, ultracode),
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
  // WS-H — single-folder model: create takes an optional single `dir`; setWorkspaceDir
  // sets (or clears, with null) the workspace's one folder, replacing add/remove-dir.
  createWorkspace: (name: string, dir?: string) =>
    ipcRenderer.invoke("workspace:create", name, dir),
  renameWorkspace: (id: string, name: string) =>
    ipcRenderer.invoke("workspace:rename", id, name),
  setWorkspaceDir: (id: string, dir: string | null) =>
    ipcRenderer.invoke("workspace:set-dir", id, dir),
  deleteWorkspace: (id: string) => ipcRenderer.invoke("workspace:delete", id),
  setActiveWorkspace: (id: string | null) => ipcRenderer.invoke("workspace:set-active", id),
  launchWorkspace: (id: string) => ipcRenderer.invoke("workspace:launch", id),
  // WS-F — re-run discovery against the configured scan paths ON DEMAND (the
  // switcher's ⟳ refresh). Returns the updated PUBLIC list (seeds new manifests,
  // never duplicates, never reverts user edits).
  rescanWorkspaces: () => ipcRenderer.invoke("workspace:rescan"),
  // WS-D/H — native folder picker for the create modal's "Choose folder" + the
  // selected-workspace dir-row. SINGLE-select; resolves to the chosen absolute dir
  // path(s) (0 or 1 entries), or [] on cancel.
  openDirectoryDialog: (): Promise<string[]> => ipcRenderer.invoke("dialog:open-directory"),
  // WS-B — active-workspace change events from main (payload = public workspace
  // or null). WS-D consumes it for the sidebar switcher.
  onWorkspaceActiveChanged: (callback: (workspace: any | null) => void) =>
    ipcRenderer.on("workspace:active-changed", (_e, workspace) => callback(workspace)),

  // CAPP-87 / U3 — workspace memory (the durable, workspace-level knowledge tier).
  // A `null` workspaceId addresses the untagged "All" bucket. Every mutator triggers
  // the main process's onMemoryChanged seam (invalidates recall + pushes
  // `workspace:memory-changed`). getPromotableFindings + killWorkSessionWithPromote
  // back the delete-time Keep flow (U5); the editor panel (U6) consumes the rest.
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
  // CAPP-97 — pin/unpin a finding (never evicted under the auto-load context cap).
  setWorkspaceFindingPinned: (workspaceId: string | null, findingId: string, pinned: boolean) =>
    ipcRenderer.invoke("workspace:set-pinned", workspaceId, findingId, pinned),
  promoteWorkspaceFindings: (workspaceId: string | null, entries: any[]) =>
    ipcRenderer.invoke("workspace:promote-findings", workspaceId, entries),
  // CAPP-98 / I1 — the Context Inspector (READ-ONLY): enumerate the launch-time native
  // context + our injected primer for a workspace, by precedence. A `null` workspaceId is
  // the untagged "All" bucket. Consumed by the WorkspaceSwitcher "Context" open handler.
  inspectWorkspaceContext: (workspaceId: string | null) =>
    ipcRenderer.invoke("context:inspect", workspaceId),
  // CAPP-99 / E1 — export accessors (also on the companion preload, where the export UI
  // lives). STRICTLY one-directional (store → file): read state / trigger regen only — no
  // file → store accessor exists. A `null` workspaceId is the untagged "All" bucket.
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
  // only) + the read-only adoption probe. Appends/removes ONLY our delimited block; change-guarded;
  // Unwire refuses when the user hand-edited inside the delimiters.
  getAdoptionState: (workspaceId: string | null) =>
    ipcRenderer.invoke("adoption:get-state", workspaceId),
  wireImportBlock: (workspaceId: string | null) =>
    ipcRenderer.invoke("adoption:wire", workspaceId),
  unwireImportBlock: (workspaceId: string | null) =>
    ipcRenderer.invoke("adoption:unwire", workspaceId),
  setExportSelfWired: (workspaceId: string | null, selfWired: boolean) =>
    ipcRenderer.invoke("adoption:set-self-wired", workspaceId, selfWired),
  // The Keep modal's editable candidate list (the dying session's promotable notes).
  getPromotableFindings: (sessionId: string) =>
    ipcRenderer.invoke("worksession:promotable-findings", sessionId),
  // Atomic promote-then-kill ("Keep & delete"): promotes the edited findings into the
  // OWNING session's workspace FIRST, then kills the session (kill is skipped if
  // promote throws). Distinct from `killWorkSession` (the "Delete everything" path).
  killWorkSessionWithPromote: (sessionId: string, editedEntries: any[]) =>
    ipcRenderer.invoke("worksession:kill-with-promote", sessionId, editedEntries),
  // Memory-change push from main (payload = the changed workspaceId). The U6 editor
  // panel live-refreshes on it. Per-instance unsubscribe (mirrors onStreamEvent) so a
  // subscriber can tear down without a removeAllListeners clobbering siblings.
  onWorkspaceMemoryChanged: (callback: (workspaceId: string) => void) => {
    const handler = (_e: unknown, workspaceId: string) => callback(workspaceId)
    ipcRenderer.on("workspace:memory-changed", handler)
    return () => ipcRenderer.removeListener("workspace:memory-changed", handler)
  },

  // CAPP-95 / D1 — local-history net (the durable-brain data-loss recovery surface).
  // `restore` takes a snapshot hash + an optional curated relPath (omit to restore the
  // whole subset); `snapshot` takes an optional reason. The git work runs in the
  // isolated ~/.claude-tui/.local-history repo only (never the project repo).
  listLocalHistory: () => ipcRenderer.invoke("local-history:list"),
  restoreLocalHistory: (hash: string, relPath?: string) =>
    ipcRenderer.invoke("local-history:restore", hash, relPath),
  snapshotLocalHistory: (reason?: string) => ipcRenderer.invoke("local-history:snapshot", reason),
  revealLocalHistory: () => ipcRenderer.invoke("local-history:reveal"),

  // Session rename
  renameSession: (id: string, newName: string) => ipcRenderer.invoke("terminal:rename", id, newName),

  // Config
  getConfig: () => ipcRenderer.invoke("config:get"),

  // Theme
  getTheme: () => ipcRenderer.invoke("config:get-theme"),
  setTheme: (mode: string) => ipcRenderer.invoke("config:set-theme", mode),
  onThemeChanged: (callback: (mode: string) => void) =>
    ipcRenderer.on("theme:changed", (_e, mode) => callback(mode)),

  // CAPP-39 gate ④ — set the DEFAULT rendering engine for NEW terminals (the
  // command-palette rollback write-path). Persists to config + applies live.
  setRenderingEngine: (engine: "xterm" | "structured") =>
    ipcRenderer.invoke("config:set-rendering-engine", engine),

  // CAPP-113 — persist a user-entered CUSTOM model into config models.extra so the
  // picker offers it from then on. Called by AgentModelPicker only after a SUCCESSFUL
  // switch to the custom value.
  addModelExtra: (value: string) => ipcRenderer.invoke("config:add-model-extra", value),

  // CAPP-113 — push: the config models block changed (a custom model was persisted).
  // The renderer fetches config exactly once on mount, so without this an added extra
  // would not reach any picker until an app restart. useSessions folds the fresh
  // block into its config state so the modelOptions memo recomputes live.
  onConfigModelsChanged: (callback: (models: unknown) => void) =>
    ipcRenderer.on("config:models-changed", (_e, models) => callback(models)),

  // Agent Rail (v1) — persist the rail's open/collapsed preference (GLOBAL). The
  // renderer seeds the rail's collapsed state from config.agentRail on mount and
  // calls this when the user toggles the rail (chevron / shortcut / palette). The
  // responsive sub-1400px auto-collapse is renderer-only and never calls this.
  setAgentRailOpen: (open: boolean) =>
    ipcRenderer.invoke("config:set-agent-rail-open", open),

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
  // CAPP-110 / S3 — pop a modal panel out to the companion window (the ModalHost
  // "⤢ Pop out" button). MAIN-window only, NON-MCP.
  popOutPanel: (id: string) => ipcRenderer.invoke("panel:pop-out", id),
  submitForm: (id: string, data: Record<string, any>) =>
    ipcRenderer.send("panel:form-submit", id, data),
  // CAPP-109 / S2 — the diff "send review to the active session" sink, used by the
  // main-window ModalHost's PanelApi.sendToSession wrapper. Fire-and-forget
  // (mirrors the companion's `companion:send-to-session`); the handler writes to the
  // active terminal. The ModalHost wraps this to return `true` to match the PanelApi shape.
  sendToSession: (text: string) => ipcRenderer.send("companion:send-to-session", text),

  // CAPP-114 (SCHED-1) — on-device scheduler CRUD + run-now. Push events
  // (schedule:updated / schedule:removed) drive useSchedules without polling.
  listSchedules: () => ipcRenderer.invoke("schedule:list"),
  createSchedule: (input: any) => ipcRenderer.invoke("schedule:create", input),
  updateSchedule: (id: string, patch: any) => ipcRenderer.invoke("schedule:update", id, patch),
  deleteSchedule: (id: string) => ipcRenderer.invoke("schedule:delete", id),
  runScheduleNow: (id: string) => ipcRenderer.invoke("schedule:run-now", id),
  onScheduleUpdated: (callback: (schedule: any) => void) =>
    ipcRenderer.on("schedule:updated", (_e, schedule) => callback(schedule)),
  onScheduleRemoved: (callback: (id: string) => void) =>
    ipcRenderer.on("schedule:removed", (_e, id) => callback(id)),
  // CAPP-115 (SCHED-2) — the detail panel's "Edit" round-trip: request → main process
  // forwards `schedule:edit` back to this window → App opens the pre-filled ScheduleForm.
  requestScheduleEdit: (id: string) => ipcRenderer.invoke("schedule:request-edit", id),
  onScheduleEdit: (callback: (id: string) => void) =>
    ipcRenderer.on("schedule:edit", (_e, id) => callback(id)),

  // Notifications
  listNotifications: () => ipcRenderer.invoke("notification:list"),
  dismissNotification: (id: string) => ipcRenderer.invoke("notification:dismiss", id),
  onNotificationShow: (callback: (notification: any) => void) =>
    ipcRenderer.on("notification:show", (_e, notification) => callback(notification)),
  onNotificationDismiss: (callback: (id: string) => void) =>
    ipcRenderer.on("notification:dismiss", (_e, id) => callback(id)),

  // Attention queue (AQ-2) — "who needs me?" the renderer is a thin view
  attentionSeen: (terminalId: string) => ipcRenderer.invoke("attention:seen", terminalId),
  attentionDismiss: (id: string) => ipcRenderer.invoke("attention:dismiss", id),
  onAttentionUpdated: (callback: (entries: any[]) => void) =>
    ipcRenderer.on("attention:updated", (_e, entries) => callback(entries)),
  onAttentionJump: (callback: (id: string) => void) =>
    ipcRenderer.on("attention:jump", (_e, id) => callback(id)),

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

  // CAPP-120 (STT-1) — push-to-talk dictation. sttStatus returns { status, enabled,
  // modelDir, attribution, message }; sttTranscribe sends 16 kHz mono Float32 samples to
  // the utility-process recognizer and resolves { text, engine, ms }; sttAcquire kicks off
  // the first-enable model download (progress rides onSttProgress) and returns the coarse
  // status — `force` (review finding 6c) deletes the model dir first and re-downloads (the
  // corrupt-model recovery); sttCancelAcquire aborts an in-flight download (responsive in
  // BOTH the download and extract phases). NO MCP tool (user input affordance).
  sttStatus: () => ipcRenderer.invoke("stt:status"),
  sttTranscribe: (samples: Float32Array, sampleRate: number) =>
    ipcRenderer.invoke("stt:transcribe", samples, sampleRate),
  sttAcquire: (force?: boolean) => ipcRenderer.invoke("stt:acquire", force === true),
  sttCancelAcquire: () => ipcRenderer.invoke("stt:cancel-acquire"),
  onSttProgress: (callback: (p: SttProgress) => void) => {
    const handler = (_e: unknown, p: SttProgress) => callback(p)
    ipcRenderer.on("stt:progress", handler)
    return () => ipcRenderer.removeListener("stt:progress", handler)
  },

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
}

/** The inferred shape of the main-window bridge — consumed ONLY by the type-parity GATE
 *  (src/lib/panelApiParity.test.ts). Type-only; never imported at runtime by the renderer. */
export type MainApi = typeof mainApi

contextBridge.exposeInMainWorld("api", mainApi)
