import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { cmdOrCtrl } from "./lib/platform"
import type {
  TerminalStreamPayload,
  PermissionRequest,
  PermissionDecision,
  AgentCatalog,
  StreamEvent,
  QueuedAgentInput,
} from "../electron/services/streamProtocol"
// CAPP-113 — the config-extensible model option derivation (pure, zero-dep) + the
// built-in alias list, shared with the picker so the effective list can't drift.
import { MODEL_ALIASES, resolveModelOptions } from "../electron/services/streamProtocol"
// CAPP-120 (STT-1) — dictation status/progress/transcription contract (zero-dep types).
import type { SttStatusSnapshot, SttProgress, SttTranscription } from "../electron/stt/protocol"
import Sidebar from "./components/Sidebar"
import TabBar from "./components/TabBar"
import TerminalPane from "./components/TerminalPane"
import AgentSurface from "./components/AgentSurface"
import AgentRail from "./components/AgentRail"
import WindowControls from "./components/WindowControls"
import type { TranscriptCache } from "./components/AgentView"
import { createTranscriptStore } from "./lib/transcriptStore"
import PermissionPrompt from "./components/PermissionPrompt"
import KillSessionModal from "./components/KillSessionModal"
import ModalHost from "./components/ModalHost"
import SplitView from "./components/SplitView"
import DropZone from "./components/DropZone"
import { usePermissions } from "./hooks/usePermissions"
import { useGeneratingTerminals } from "./hooks/useAgentBusy"
import CommandPalette, { Command } from "./components/CommandPalette"
import ToastHost from "./components/ToastHost"
import ShortcutsHelp from "./components/ShortcutsHelp"
import HistorySearch from "./components/HistorySearch"
import ScheduleForm from "./components/ScheduleForm"
import WorkspaceCreateModal from "./components/WorkspaceCreateModal"
import RestoreConversationModal from "./components/RestoreConversationModal"
import { toast } from "./lib/toast"
import { useSessions } from "./hooks/useSessions"
import { useAttention } from "./hooks/useAttention"
import { useSchedules, type ScheduleSummary, type ScheduleFormInput } from "./hooks/useSchedules"
import { useWorkspaces } from "./hooks/useWorkspaces"
import { filterByWorkspace } from "./lib/workspaceFilter"
import { filterAttentionByWorkspace } from "./lib/workspaceScope"
import { deriveResumingRows } from "./lib/resumingList"
// CAPP-120 (STT-1 review, MAJOR 2) — the dictation Esc-discard registry: consulted FIRST
// by the capture-phase Escape arm, before the BO-10 busy-terminal interrupt.
import { dispatchDictationEsc } from "./lib/dictationEsc"
import { useSplitView } from "./hooks/useSplitView"
import { useOverlays } from "./hooks/useOverlays"
import { useTheme } from "./hooks/useTheme"
import { useAgentRail } from "./hooks/useAgentRail"
import { useAgentCost } from "./hooks/useAgentCost"
import { usePanels, type PanelState } from "./hooks/usePanels"

// Normalize an unknown thrown value into a human-readable message for toasts.
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// TypeScript type for the API exposed by preload
declare global {
  interface Window {
    api: {
      // Platform info (darwin | win32 | linux) — used for Cmd vs Ctrl key mapping
      platform: string
      // Terminal-tier transport (xterm I/O) — keyed by live PTY id
      writeToSession: (id: string, data: string) => void
      resizeSession: (id: string, cols: number, rows: number) => void
      renameSession: (id: string, newName: string) => Promise<boolean>
      getSessionOutput: (id: string, maxChars?: number) => Promise<string | null>
      searchSessionOutput: (query: string, sessionId?: string, limit?: number) => Promise<
        { sessionId: string; name: string; line: number; text: string }[]
      >
      onSessionData: (callback: (id: string, data: string) => void) => void
      // BO-2: structured headless stream; returns a per-instance unsubscribe.
      onStreamEvent: (callback: (payload: TerminalStreamPayload) => void) => () => void
      // BO-3: structured composer input + permission gate
      sendAgentInput: (terminalId: string, msg: { text?: string; attachments?: string[] }) => void
      // CAPP-130: queued messages (send-while-busy enqueues; auto-flushes one per turn)
      getAgentQueue: (terminalId: string) => Promise<QueuedAgentInput[]>
      removeQueuedInput: (terminalId: string, queuedId: string) => Promise<boolean>
      onAgentQueueChanged: (
        callback: (terminalId: string, queue: QueuedAgentInput[]) => void,
      ) => () => void
      // BO-7: structured composer `/`-command picker catalog + native-command bridge
      getAgentCatalog: (terminalId: string) => Promise<(AgentCatalog & { live?: boolean }) | null>
      // CAPP-120 (STT-1): push-to-talk dictation (Parakeet/sherpa-onnx utility process)
      sttStatus: () => Promise<SttStatusSnapshot>
      sttTranscribe: (samples: Float32Array, sampleRate: number) => Promise<SttTranscription>
      sttAcquire: (force?: boolean) => Promise<SttStatusSnapshot["status"]>
      sttCancelAcquire: () => Promise<void>
      onSttProgress: (callback: (p: SttProgress) => void) => () => void
      // BO-12: prior turns of a conversation (by Claude Code id) to rehydrate a chat view
      getTranscriptEvents: (ccConversationId: string) => Promise<StreamEvent[]>
      onUiSlashCommand: (
        callback: (payload: { command: string; terminalId: string }) => void,
      ) => () => void
      onPermissionRequest: (callback: (req: PermissionRequest) => void) => () => void
      onPermissionResolved: (callback: (id: string) => void) => () => void
      resolvePermission: (id: string, decision: PermissionDecision) => Promise<boolean>
      onSessionFocus: (callback: (id: string) => void) => void
      // BO-10 — terminal active/idle transitions; per-instance disposer (shared by
      // usePanels overview-refresh + useAgentBusy composer gating).
      onTerminalState: (callback: (id: string, state: string) => void) => () => void
      // CAPP-49 — a terminal's PTY/headless proc exited; per-instance disposer.
      // useGeneratingTerminals prunes a killed/respawned id from the busy set on exit.
      onSessionExit: (callback: (id: string) => void) => () => void
      onSessionRenamed: (callback: (id: string, newName: string) => void) => void
      // Work-session (container) tier
      listWorkSessions: () => Promise<any[]>
      openWorkSession: (cwd?: string) => Promise<{ session: any; terminalId: string }>
      addTerminal: (sessionId: string, cwd?: string) => Promise<{ terminalId: string } | undefined>
      // CAPP-75 — list/restore a folder's past Claude Code conversations (incl. ones
      // started outside the app). list is read-only discovery; restore spawns
      // `claude --resume <id>` in the folder as a new work session.
      listFolderConversations: (
        folder: string,
      ) => Promise<Array<{ id: string; updatedAt: number; preview: string }>>
      restoreConversation: (
        folder: string,
        conversationId: string,
      ) => Promise<{ session: any; terminalId: string } | undefined>
      reopenTerminal: (sessionId: string, terminalId: string) => Promise<{ terminalId: string } | undefined>
      closeTerminal: (sessionId: string, terminalId: string) => Promise<void>
      killWorkSession: (sessionId: string) => Promise<void>
      // CAPP-98 / I1 — the READ-ONLY Context Inspector: enumerate the launch-time native
      // context for a workspace (null = untagged "All"). Consumed by the WorkspaceSwitcher
      // "Context" button. Pure read — no native-file write path.
      inspectWorkspaceContext: (workspaceId: string | null) => Promise<any>
      // CAPP-82 — rename the durable work-session container (the sidebar row).
      renameWorkSession: (id: string, name: string) => Promise<boolean>
      onWorkSessionUpdated: (callback: (session: any) => void) => void
      onWorkSessionRemoved: (callback: (id: string) => void) => void
      // Workspaces / config
      getWorkspaces: () => Promise<any[]>
      activateWorkspace: (index: number) => Promise<any>
      // WS-B — id-based workspace registry ops (PUBLIC projection only). Selection
      // (setActiveWorkspace) is split from launch (launchWorkspace): set-active
      // only marks/persists/emits; launch spawns. WS-D wires SELECTION into the UI
      // (the switcher filters by active workspace); LAUNCH is intentionally NOT
      // wired — a workspace is "not a launcher" per the ratified design, so the UI
      // is selection-only. launchWorkspace is kept on the API for backward-compat +
      // a future WS-E (MCP) surface.
      getWorkspace: (id: string) => Promise<any | null>
      getActiveWorkspace: () => Promise<any | null>
      // WS-H — single-folder model: create takes an optional single dir;
      // setWorkspaceDir sets/clears the workspace's one folder (was add/remove-dir).
      createWorkspace: (name: string, dir?: string) => Promise<any | null>
      renameWorkspace: (id: string, name: string) => Promise<any | null>
      setWorkspaceDir: (id: string, dir: string | null) => Promise<any | null>
      deleteWorkspace: (id: string) => Promise<boolean>
      setActiveWorkspace: (id: string | null) => Promise<boolean>
      launchWorkspace: (id: string) => Promise<any | null>
      // WS-F — on-demand discovery refresh. Returns the updated PUBLIC list
      // (seeds new manifests; never duplicates / reverts user edits).
      rescanWorkspaces: () => Promise<any[]>
      // WS-D/H — native single-folder picker (create modal + active-workspace dir
      // row). Resolves to 0 or 1 absolute paths; [] on cancel.
      openDirectoryDialog: () => Promise<string[]>
      onWorkspaceActiveChanged: (callback: (workspace: any | null) => void) => void
      getConfig: () => Promise<any>
      // Split panes (terminal ids)
      onSplitSet: (callback: (leftId: string, rightId: string) => void) => void
      onSplitClose: (callback: () => void) => void
      // UI control events from MCP tools
      onUiFocusMode: (callback: (enabled?: boolean) => void) => void
      onUiCommandPalette: (callback: (open?: boolean) => void) => void
      onUiShortcutsHelp: (callback: (open?: boolean) => void) => void
      onUiHistorySearch: (callback: (open?: boolean) => void) => void
      onUiExportLog: (callback: (sessionId: string | null) => void) => void
      // App testing / drops
      saveDroppedImage: (base64: string, filename: string) => Promise<string>
      // Panels
      showPanel: (type: string, props: Record<string, any>, position?: string) => Promise<PanelState>
      listPanels: () => Promise<PanelState[]>
      hidePanel: (id: string) => Promise<boolean>
      popOutPanel: (id: string) => Promise<boolean>
      hideAllPanels: () => Promise<void>
      submitForm: (id: string, data: Record<string, any>) => void
      // Notifications
      listNotifications: () => Promise<any[]>
      dismissNotification: (id: string) => Promise<boolean>
      onNotificationShow: (callback: (notification: any) => void) => void
      onNotificationDismiss: (callback: (id: string) => void) => void
      // Attention queue (AQ-2)
      attentionSeen: (terminalId: string) => Promise<void>
      attentionDismiss: (id: string) => Promise<boolean>
      onAttentionUpdated: (callback: (entries: any[]) => void) => void
      onAttentionJump: (callback: (id: string) => void) => void
      onPanelShow: (callback: (panel: PanelState) => void) => void
      onPanelUpdate: (callback: (payload: { id: string; props: any }) => void) => void
      onPanelHide: (callback: (id: string) => void) => void
      onPanelHideAll: (callback: () => void) => void
      // CAPP-114 (SCHED-1) — on-device scheduler
      listSchedules: () => Promise<any[]>
      createSchedule: (input: any) => Promise<any>
      updateSchedule: (id: string, patch: any) => Promise<any>
      deleteSchedule: (id: string) => Promise<boolean>
      runScheduleNow: (id: string) => Promise<boolean>
      onScheduleUpdated: (callback: (schedule: any) => void) => void
      onScheduleRemoved?: (callback: (id: string) => void) => void
      requestScheduleEdit: (id: string) => Promise<void>
      onScheduleEdit?: (callback: (id: string) => void) => void
      removeAllListeners: (channel: string) => void
      getSessionOverview: (sessionId: string) => Promise<any>
      handoffTerminal: (sessionId: string, terminalId: string) => Promise<{ terminalId: string } | undefined>
      // CAPP-39 gate ② — launch an interactive `claude /login` terminal (structured
      // engine can't show OAuth UI); from the AgentView "not signed in" Sign-in button.
      startLogin: (sessionId?: string) => Promise<{ terminalId: string } | undefined>
      // BO-6 — switch a structured terminal's --model (respawns + resumes the chat)
      setTerminalModel: (sessionId: string, terminalId: string, model: string) => Promise<{ terminalId: string } | undefined>
      // CAPP-46 — switch a structured terminal's --effort level (respawns + resumes the chat)
      setTerminalEffort: (sessionId: string, terminalId: string, effort: string) => Promise<{ terminalId: string } | undefined>
      // CAPP-108 — toggle a structured terminal's ultracode posture (respawns + resumes the chat)
      setTerminalUltracode: (sessionId: string, terminalId: string, ultracode: boolean) => Promise<{ terminalId: string } | undefined>
      // CAPP-39 gate ③ — per-terminal raw-view escape hatch: toggle one terminal between
      // the structured and xterm engines at runtime (respawns + resumes the chat).
      setTerminalEngine: (sessionId: string, terminalId: string, targetEngine: "xterm" | "structured") => Promise<{ terminalId: string } | undefined>
      // BO-10 — stop/interrupt a structured terminal (kills + resumes the chat).
      // Returns the respawned terminal id so the caller re-points the active tab.
      interruptAgent: (terminalId: string) => Promise<{ terminalId: string } | undefined>
      // Restart a terminal in place (kills + resumes the chat on the SAME engine) so a
      // fresh --mcp-config / config read picks up MCP or config changes. Works for both
      // engines. Returns the respawned terminal id so the caller re-points the active tab.
      restartTerminal: (terminalId: string) => Promise<{ terminalId: string } | undefined>
      // Theme
      getTheme: () => Promise<string>
      setTheme: (mode: string) => Promise<void>
      onThemeChanged: (callback: (mode: string) => void) => void
      // CAPP-39 gate ④ — set the DEFAULT engine for NEW terminals (rollback write-path)
      setRenderingEngine: (engine: "xterm" | "structured") => Promise<void>
      // CAPP-113 — persist a user-entered CUSTOM model into config models.extra
      addModelExtra: (value: string) => Promise<void>
      // CAPP-113 — push: the config models block changed (custom model persisted);
      // useSessions folds it into config state so the pickers refresh live.
      onConfigModelsChanged: (callback: (models: any) => void) => void
      // Agent Rail (v1) — persist the rail's open/collapsed pref (GLOBAL).
      setAgentRailOpen: (open: boolean) => Promise<void>
      // Window controls (frameless)
      windowMinimize: () => void
      windowMaximize: () => void
      windowClose: () => void
      // PP: raise the companion window (panel presence indicator click)
      focusCompanion: () => void
    }
  }
}

export default function App() {
  // M5: ref bridging two hooks. usePanels stores the latest overview-refresh
  // callback in it; useSessions calls it when worksession:updated fires — so the
  // container update triggers a panel refresh without a second listener on that
  // channel. Owned by the root because both hooks share it; this is the one
  // surviving ref-sync workaround (justified: cross-hook coupling, not a stale
  // closure within a single hook).
  const refreshOverviewsRef = useRef<(() => void) | null>(null)

  // CAPP-93 / U5 — the session pending deletion (drives the KillSessionModal). All
  // kill entry points (Ctrl+K, sidebar ✕, palette) route through useSessions'
  // handleKillSessionById, which calls requestKillRef.current(id) instead of
  // window.confirm. The modal owns the actual kill. `requestKillRef` is a ref so the
  // hook's stable callback always sees the latest setter without re-subscribing.
  const [pendingKillId, setPendingKillId] = useState<string | null>(null)
  const requestKillRef = useRef<((id: string) => void) | null>(null)
  useEffect(() => {
    requestKillRef.current = (id: string) => setPendingKillId(id)
  }, [])

  const {
    sessions,
    activeSessionId,
    activeTerminalId,
    setActiveTerminalId,
    config,
    activeSession,
    activeTerminals,
    handleNewSession,
    handleRestoreConversation,
    handleNewTerminal,
    handleCloseTerminal,
    handleHandoff,
    handleKillSession,
    handleKillSessionById,
    handleRenameTerminal,
    handleRenameSession,
    handleSelectSession,
    resumingTracked,
    resumingSeeds,
    resumingLiveIds,
    clearResuming,
  } = useSessions(refreshOverviewsRef, requestKillRef)

  // CAPP-93 / U5 — race self-heal: if the session pending deletion is removed out from
  // under the modal (killed elsewhere, or its kill resolved via onWorkSessionRemoved),
  // auto-close the modal so it never lingers over a dead id. Promotion (if any) was
  // fired from the opened-time snapshot, so closing here is safe. No toast is emitted:
  // this effect ALSO fires on the normal Cancel/Keep/Delete close (those remove the
  // session too), so toasting here would spam a spurious "removed out from under you"
  // on every successful delete.
  useEffect(() => {
    if (pendingKillId && !sessions.some((s) => s.id === pendingKillId)) {
      setPendingKillId(null)
    }
  }, [sessions, pendingKillId])

  // The pending session's display name for the modal's honest copy.
  const pendingKillName = useMemo(
    () => sessions.find((s) => s.id === pendingKillId)?.name,
    [sessions, pendingKillId],
  )

  // BO-12 (CAPP-51) — the shared, cross-pane transcript cache (folded TranscriptState
  // keyed by the STABLE Claude Code conversation id). Held in a ref so the Map
  // instance is stable across renders; lives above AgentView so a structured
  // respawn (which remounts AgentView under a new terminal id, but the SAME convo
  // id) re-seeds the prior turns INSTANTLY from memory, and split panes sharing a
  // convo share the entry.
  const transcriptCacheRef = useRef<TranscriptCache>(new Map())

  // THE TRUST FIX — the ALWAYS-ON renderer transcript store. Held in a ref so the
  // instance is stable for the window's life, and subscribed ONCE at mount (below).
  // It folds EVERY terminal's stream continuously — mounted or not — so a switched-
  // away terminal (whose AgentView is unmounted, because App only mounts AgentView
  // for the ACTIVE session's terminals) keeps accumulating its transcript instead of
  // silently dropping it. AgentView reads its terminal's state from here via
  // useSyncExternalStore. Keyed by terminalId (the WITHIN-spawn, across-mount tier);
  // the transcriptCache above stays the ACROSS-respawn tier keyed by convo id.
  const transcriptStoreRef = useRef(createTranscriptStore())

  // Subscribe ONCE, for the window's life: fold every terminal's stream into the
  // store regardless of which AgentView (if any) is mounted. This is the seam the
  // per-component onStreamEvent listener used to own — lifting it here is what makes
  // an away-period stream survivable.
  useEffect(() => {
    const dispose = window.api.onStreamEvent((payload) => {
      transcriptStoreRef.current.ingest(payload)
    })
    return () => dispose?.()
  }, [])

  // GC cache entries whose convo id no longer belongs to any live terminal — i.e.
  // a closed terminal or a killed session. A `--resume` respawn keeps the convo id
  // on its ref, so it stays "live" and is never evicted mid-respawn; only a genuine
  // close/kill drops it. Cheap set-diff on each session change. The transcript STORE
  // is GC'd alongside, keyed by terminalId (a closed/killed terminal's id drops out).
  useEffect(() => {
    const liveConvos = new Set<string>()
    const liveTerminals = new Set<string>()
    for (const s of sessions) {
      for (const t of s.terminals) {
        liveTerminals.add(t.id)
        if (t.ccConversationId) liveConvos.add(t.ccConversationId)
      }
    }
    for (const key of transcriptCacheRef.current.keys()) {
      if (!liveConvos.has(key)) transcriptCacheRef.current.delete(key)
    }
    transcriptStoreRef.current.gc(liveTerminals)
  }, [sessions])

  // BO-4b — the renderer fork is PER TERMINAL (on `t.engine`, surfaced from the
  // backend), not a single global config boolean. The old global derived from the
  // async-loaded config ("xterm" until it arrived) raced session restore: a
  // structured terminal could mount under TerminalPane (a blank xterm awaiting
  // ANSI that never comes) with no composer at all. Forking on each terminal's
  // ACTUAL engine removes that race and fixes split panes in one move. See the
  // `activeTerminals.map` fork and SplitView below.

  // Attention queue: focus an entry's session+terminal. Held in a ref so the hook's
  // mount-once `attention:jump` listener always calls the latest closure.
  const focusEntryRef = useRef<(sessionId: string, terminalId?: string) => void>(() => {})

  const focusEntry = useCallback(
    (sessionId: string, terminalId?: string) => {
      if (sessionId) handleSelectSession(sessionId)
      if (terminalId) setActiveTerminalId(terminalId)
    },
    [handleSelectSession, setActiveTerminalId],
  )
  useEffect(() => {
    focusEntryRef.current = focusEntry
  }, [focusEntry])

  const {
    entries: attentionEntries,
    nowTick: attentionNow,
    dismiss: dismissAttention,
    jumpTo: jumpToAttention,
  } = useAttention(focusEntryRef)

  // Spec: focusing a terminal by ANY path (tab click, session select, Alt+N —
  // not just the attention-row jump) counts as attention given and clears its
  // tier-2/3 entries. Tier-1 persistence is service-enforced, so this is safe
  // to fire unconditionally; a failed call is non-critical hygiene.
  useEffect(() => {
    if (activeTerminalId) void window.api.attentionSeen(activeTerminalId).catch(() => {})
  }, [activeTerminalId])

  // BO-3 — pending tool-permission prompts raised by the headless approve_tool
  // gate. Resolving sends the decision AND clears the lingering tier-2 "asked"
  // attention entry (the queue holds it until the terminal is "seen").
  // BO-11 — pass the live terminal id set so usePermissions can prune orphaned
  // requests (a dead terminal's card that lost the race with a Ctrl+K kill).
  const liveTerminalIds = useMemo(
    () => new Set(sessions.flatMap((s) => s.terminals.map((t) => t.id))),
    [sessions],
  )
  const { requests: permissionRequests, resolve: resolvePermissionRequest } = usePermissions(liveTerminalIds)
  const handlePermissionResolve = useCallback(
    (req: PermissionRequest, decision: Omit<PermissionDecision, "id">) => {
      resolvePermissionRequest(req.id, decision)
      if (req.terminalId) void window.api.attentionSeen(req.terminalId).catch(() => {})
    },
    [resolvePermissionRequest],
  )
  // BO-11 — only the ACTIVE terminal's prompts are rendered, so a background/dead
  // terminal's fixed-position card can never occlude the active composer.
  const activePermissionRequests = useMemo(
    () => permissionRequests.filter((r) => r.terminalId === activeTerminalId),
    [permissionRequests, activeTerminalId],
  )

  // BO-10 — "busy" for a structured terminal = generating a turn OR parked on a
  // permission prompt. Generating comes from terminal:state; a permission block
  // emits idle there, so the pending permission queue supplies that half.
  const generatingTerminals = useGeneratingTerminals()
  const isTerminalBusy = useCallback(
    (terminalId: string | null): boolean => {
      if (!terminalId) return false
      return (
        generatingTerminals.has(terminalId) ||
        permissionRequests.some((r) => r.terminalId === terminalId)
      )
    },
    [generatingTerminals, permissionRequests],
  )

  // Agent Rail (v1) — derive the rail's live inputs from the ACTIVE terminal,
  // mirroring how the surface picks it. All are lenses over EXISTING seams.
  const activeTerminalForRail = useMemo(
    () => activeTerminals.find((t) => t.id === activeTerminalId) ?? null,
    [activeTerminals, activeTerminalId],
  )
  const railBusy = isTerminalBusy(activeTerminalId)
  // COST source: a per-terminal accumulator of turn-complete `result` blocks (folded
  // from the SAME stream events, keyed by terminal id so it's robust from the first
  // turn with no convo-id dependency). `sumCost` (the tested helper) sums it in the
  // rail. Accepted v1 limitation (design doc Q5): renderer-side, resets on respawn /
  // misses scrolled-out turns — a glance number, not an audit.
  const railBlocks = useAgentCost(activeTerminalId)

  // BO-10 — the stop/interrupt handbrake: kill + resume the SAME conversation. The
  // respawn mints a new terminal id, so re-point the active selection at it (like
  // the model switch). Used by both the Esc key (App) and the composer Stop button.
  const handleInterrupt = useCallback(
    async (terminalId: string | null) => {
      if (!terminalId) return
      try {
        const r = await window.api.interruptAgent(terminalId)
        if (r?.terminalId) setActiveTerminalId(r.terminalId)
      } catch (err) {
        toast("error", `Couldn't stop the agent: ${errMsg(err)}`)
      }
    },
    [setActiveTerminalId],
  )

  // Restart the active terminal in place: kill + resume the SAME conversation on the
  // SAME engine, so a fresh --mcp-config / config read picks up MCP or config changes
  // without closing the app. The respawn mints a new terminal id, so re-point the active
  // selection at it (like the interrupt / model switch). Universal command-palette entry
  // point — the composer has its own visible Restart button for structured terminals.
  const handleRestart = useCallback(
    async (terminalId: string | null) => {
      if (!terminalId) return
      try {
        const r = await window.api.restartTerminal(terminalId)
        if (r?.terminalId) {
          setActiveTerminalId(r.terminalId)
          toast("success", "Terminal restarted — reloaded the process, resumed the conversation.")
        }
      } catch (err) {
        toast("error", `Couldn't restart the terminal: ${errMsg(err)}`)
      }
    },
    [setActiveTerminalId],
  )

  // CAPP-39 gate ③ — the per-terminal RAW-VIEW escape hatch. Toggle the given
  // terminal between the structured and xterm engines at runtime (respawns, resuming
  // the SAME conversation). The respawn mints a new terminal id, so re-point the
  // active selection at it (like the model switch / interrupt). The service REFUSES
  // while busy or before the first turn captures a conversation id; surface that as a
  // toast rather than a silent no-op so the user knows what to do.
  const handleToggleEngine = useCallback(
    async (terminalId: string | null) => {
      if (!terminalId) return
      const t = activeTerminals.find((x) => x.id === terminalId)
      if (!t) return
      const target: "xterm" | "structured" = t.engine === "structured" ? "xterm" : "structured"
      if (isTerminalBusy(terminalId)) {
        toast("warning", "The agent is working — press Stop, then switch the view.")
        return
      }
      try {
        const r = await window.api.setTerminalEngine(activeSessionId ?? "", terminalId, target)
        if (r?.terminalId) setActiveTerminalId(r.terminalId)
        else
          toast(
            "warning",
            "Couldn't switch the view yet — the session needs a started conversation first.",
          )
      } catch (err) {
        toast("error", `Couldn't switch the view: ${errMsg(err)}`)
      }
    },
    [activeTerminals, activeSessionId, isTerminalBusy, setActiveTerminalId],
  )

  // BO-10 — Esc interrupts ONLY a structured terminal that's busy; held in a ref so
  // the (hot) keyboard effect needn't re-subscribe on every active/idle flip. For
  // an xterm terminal (or an idle structured one) it returns false, leaving Esc to
  // propagate to the PTY where it is load-bearing.
  const escInterruptRef = useRef<() => boolean>(() => false)
  useEffect(() => {
    escInterruptRef.current = () => {
      const t = activeTerminals.find((x) => x.id === activeTerminalId)
      if (t?.engine !== "structured" || !isTerminalBusy(activeTerminalId)) return false
      void handleInterrupt(activeTerminalId)
      return true
    }
  }, [activeTerminals, activeTerminalId, isTerminalBusy, handleInterrupt])

  const { splitLeft, splitRight, toggleSplit } = useSplitView(activeTerminals, activeTerminalId)

  // CAPP-113 — the effective, config-extensible model list the pickers offer (built-in
  // aliases ∪ config models.extra − hidden), derived once and threaded to every model
  // picker so the list stays in lockstep. `extraXhigh` (config models.xhigh) feeds the
  // ultracode toggle's visibility gate. Both degrade to built-ins when config is absent.
  const modelOptions = useMemo(
    () => resolveModelOptions(MODEL_ALIASES, config?.models),
    [config?.models],
  )
  const extraXhigh: string[] | undefined = config?.models?.xhigh

  const {
    paletteOpen,
    setPaletteOpen,
    helpOpen,
    setHelpOpen,
    historyOpen,
    setHistoryOpen,
    zenMode,
    setZenMode,
  } = useOverlays()

  const { themeMode } = useTheme()

  // Agent Rail (v1) — the right-edge agent-state column's open/collapsed state
  // (persisted pref + responsive sub-1400px auto-collapse). Effective `railOpen`
  // drives both the rail render and the `.app` layout class (so the center reflows).
  const { open: railOpen, toggle: toggleRail } = useAgentRail()

  // CAPP-114 (SCHED-1) — the SCHEDULED surface (seed + push, no polling).
  const {
    schedules: allSchedules,
    seeded: schedulesSeeded,
    create: createSchedule,
    update: updateSchedule,
    toggle: toggleSchedule,
    runNow: runScheduleNow,
    remove: removeSchedule,
  } = useSchedules()
  const [scheduleFormOpen, setScheduleFormOpen] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState<ScheduleSummary | null>(null)

  // CAPP-115 (SCHED-2) — the detail panel's "Edit" button routes here via IPC
  // (schedule:request-edit → schedule:edit). A fresh-schedules ref lets the mount-time
  // listener resolve the id to the current ScheduleSummary without re-registering.
  const allSchedulesRef = useRef<ScheduleSummary[]>(allSchedules)
  allSchedulesRef.current = allSchedules
  useEffect(() => {
    window.api.onScheduleEdit?.((id: string) => {
      const s = allSchedulesRef.current.find((x) => x.id === id)
      if (!s) return
      setEditingSchedule(s)
      setScheduleFormOpen(true)
    })
    return () => window.api.removeAllListeners?.("schedule:edit")
  }, [])

  // WS-D/H — the workspaces surface (switcher + active-workspace scoping). The
  // active id drives the FILTER & HIDE of the three sidebar sections below.
  const {
    workspaces,
    activeId: activeWorkspaceId,
    active: activeWorkspace,
    setActive: setActiveWorkspace,
    create: createWorkspace_,
    rename: renameWorkspace_,
    remove: deleteWorkspace_,
    setDir: setWorkspaceDir_,
  } = useWorkspaces()
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false)
  // CAPP-75 — the "Restore a conversation" picker (for the active workspace's folder).
  const [restoreConvoOpen, setRestoreConvoOpen] = useState(false)

  // WS-D — FILTER & HIDE. A specific active workspace scopes each section to its
  // own items; "All" (activeWorkspaceId null) shows everything (untagged/legacy
  // items are "All"-only). SESSIONS carry workspaceId directly; attention entries
  // resolve theirs from the owning session. Re-derived reactively whenever the
  // active id or the underlying lists change.
  const scopedSessions = useMemo(
    () => filterByWorkspace(sessions, activeWorkspaceId),
    [sessions, activeWorkspaceId],
  )
  const scopedSchedules = useMemo(
    () => filterByWorkspace(allSchedules, activeWorkspaceId),
    [allSchedules, activeWorkspaceId],
  )
  const scopedAttention = useMemo(
    () => filterAttentionByWorkspace(attentionEntries, activeWorkspaceId, sessions),
    [attentionEntries, activeWorkspaceId, sessions],
  )

  // CAPP-80 — the transient RESUMING section's rows, derived purely from the live
  // (post-reopen) sessions + the hook's tracked-token set + restore order. The list
  // shrinks as tokens clear (focus/dismiss/seen) and the section hides when empty.
  // Scoped to the active workspace so a restored row can't yank focus off-scope.
  const resumingRows = useMemo(
    () => deriveResumingRows(scopedSessions, resumingTracked, resumingSeeds, resumingLiveIds),
    [scopedSessions, resumingTracked, resumingSeeds, resumingLiveIds],
  )

  // Primary click on a RESUMING row: focus that session+terminal (reusing the
  // existing select paths) and clear the row. A row carries its STABLE restore-token
  // as `key` (the pre-reopen id) AND the LIVE terminal id to act on — clear by key,
  // act by the live id.
  const handleFocusResuming = useCallback(
    (key: string, sessionId: string, terminalId: string) => {
      focusEntry(sessionId, terminalId)
      clearResuming(key)
    },
    [focusEntry, clearResuming],
  )
  // The always-visible Stop control: USER-initiated close via the EXISTING
  // close-terminal affordance (same one Ctrl+W / the tab × use), then clear the row.
  const handleStopResuming = useCallback(
    (key: string, sessionId: string, terminalId: string) => {
      void window.api.closeTerminal(sessionId, terminalId).catch((err) =>
        toast("error", `Couldn't stop the terminal: ${errMsg(err)}`),
      )
      clearResuming(key)
    },
    [clearResuming],
  )

  const {
    panels,
    recentlyChanged: panelsRecentlyChanged,
    setPanels,
    openSchedule,
    openOverview,
  } = usePanels(refreshOverviewsRef, allSchedules, schedulesSeeded)

  // CAPP-109 / S2 — the ModalHost renders panels IN the main window (modal-by-default).
  // `modalActiveId` is the renderer-side tab selection; null = the form-exclusive default
  // (a pending form always wins regardless). EVERY close path goes through
  // window.api.hidePanel(id) so a pending show_form resolves {cancelled:true} (never
  // orphan the MCP call). The main mirror (`panels`) drops the panel when the
  // panel:hide IPC arrives back via usePanels.
  const [modalActiveId, setModalActiveId] = useState<string | null>(null)
  const handleModalClose = useCallback((id: string) => {
    void window.api.hidePanel(id).catch(() => {})
    // If the closed panel was the explicit selection, drop it so the form-exclusive
    // default takes over (or the modal unmounts when nothing is left).
    setModalActiveId((cur) => (cur === id ? null : cur))
  }, [])

  // CAPP-98 / I1 — open the READ-ONLY Context Inspector for the ACTIVE workspace (or the
  // untagged "All" bucket when none is selected). Fetch
  // the inspection main-side (capturing the workspaceId at click time), then show the
  // companion panel seeded with the result + the captured workspaceId (so the panel's
  // Refresh re-inspects THAT workspace even if the active selection changes meanwhile).
  const handleOpenContextInspector = useCallback(() => {
    void (async () => {
      try {
        const result = await window.api.inspectWorkspaceContext(activeWorkspaceId ?? null)
        await window.api.showPanel(
          "context-inspector",
          {
            workspaceId: activeWorkspaceId ?? null,
            workspaceName: activeWorkspace?.name,
            result,
          },
          "right",
        )
      } catch (err) {
        toast("error", `Couldn't open the context inspector: ${errMsg(err)}`)
      }
    })()
  }, [activeWorkspaceId, activeWorkspace])

  const [dragActive, setDragActive] = useState(false)

  // ui:export-log stays in App.tsx because its handler closes over the active
  // terminal + session list (via exportLogRef below). Owns the cleanup for this
  // one listener.
  useEffect(() => {
    window.api.onUiExportLog((id) => exportLogRef.current(id ?? undefined))
    return () => {
      window.api.removeAllListeners("ui:export-log")
    }
  }, [])

  // Drag-and-drop image support
  const hasImage = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.items).some((it) => it.type.startsWith("image/"))

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (hasImage(e)) {
      e.preventDefault()
      setDragActive(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.relatedTarget === null) setDragActive(false)
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setDragActive(false)
      // BO-3: a drop INSIDE the structured composer is owned by AgentComposer
      // (it attaches to the message instead of injecting a path). We still reset
      // the overlay above, but skip the legacy writeToSession injection here so
      // the image isn't also saved/sent twice.
      if ((e.target as HTMLElement | null)?.closest?.(".agent-composer")) return
      const file = Array.from(e.dataTransfer.files).find((f) =>
        f.type.startsWith("image/"),
      )
      if (!file) return
      try {
        const base64 = await new Promise<string>((resolve) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as string)
          reader.readAsDataURL(file)
        })
        const path = await window.api.saveDroppedImage(base64, file.name)
        await window.api.showPanel("image", { src: path, alt: file.name })
        if (activeTerminalId) {
          window.api.writeToSession(activeTerminalId, `"${path}" `)
        }
      } catch (err) {
        toast("error", `Couldn't attach the dropped image: ${errMsg(err)}`)
      }
    },
    [activeTerminalId],
  )

  // Save a terminal's captured scrollback to a downloaded .txt file.
  const handleExportLog = useCallback(
    async (id?: string) => {
      const target = id ?? activeTerminalId
      if (!target) return
      try {
        const text = await window.api.getSessionOutput(target, 100000)
        if (text == null) {
          toast("warning", "No output to export for this terminal yet.")
          return
        }
        const name =
          sessions.flatMap((s) => s.terminals).find((t) => t.id === target)?.name ?? target
        const blob = new Blob([text], { type: "text/plain" })
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = `${name}-output.txt`
        a.click()
        URL.revokeObjectURL(url)
      } catch (err) {
        toast("error", `Couldn't export the session log: ${errMsg(err)}`)
      }
    },
    [activeTerminalId, sessions],
  )

  const exportLogRef = useRef(handleExportLog)
  useEffect(() => {
    exportLogRef.current = handleExportLog
  }, [handleExportLog])

  // The theme/config affordance — shared by the palette's "Switch theme" command
  // and BO-7's `/config` slash command, so the cycle logic lives in ONE place.
  const cycleTheme = useCallback(() => {
    const modes = ["light", "dark", "cold-dark"]
    const next = modes[(modes.indexOf(themeMode) + 1) % modes.length]
    window.api.setTheme(next)
  }, [themeMode])

  // BO-7 — native-mapped slash commands fired from the structured composer. The
  // main-process intercept (terminal-handlers.ts) classifies `/config` and
  // `/resume` as native and bridges them here via ui:slash-command, so they trigger
  // the SAME app affordances the command palette / Ctrl+Shift+H use — instead of
  // being sent to Claude as literal text. Registered via a ref so the mount-once
  // listener always sees the latest themeMode/handoff closures.
  const handleSlashCommand = useCallback(
    (payload: { command: string; terminalId: string }) => {
      if (payload.command === "config") {
        cycleTheme()
      } else if (payload.command === "resume") {
        handleHandoff()
      }
      // BO-6 HOOK (CAPP-40): a `model` arm lands here when BO-6 maps /model natively.
    },
    [cycleTheme, handleHandoff],
  )
  const slashCommandRef = useRef(handleSlashCommand)
  useEffect(() => {
    slashCommandRef.current = handleSlashCommand
  }, [handleSlashCommand])
  useEffect(() => {
    const dispose = window.api.onUiSlashCommand((p) => slashCommandRef.current(p))
    return () => {
      dispose?.()
    }
  }, [])

  // Commands surfaced in the Ctrl+Shift+P command palette.
  const commands = useMemo<Command[]>(() => {
    const base: Command[] = [
      { id: "new", label: "New Session", hint: "Ctrl+N", run: handleNewSession },
      { id: "new-terminal", label: "New Terminal", hint: "Ctrl+T", run: handleNewTerminal },
      { id: "close-terminal", label: "Close Active Terminal", hint: "Ctrl+W", run: handleCloseTerminal },
      { id: "kill", label: "Kill Active Session", hint: "Ctrl+K", run: handleKillSession },
      { id: "split", label: splitLeft ? "Close Split View" : "Split Panes", hint: "Ctrl+\\", run: toggleSplit },
      { id: "hide-panels", label: "Close All Panels", keywords: "hide clear", run: () => { setPanels([]); window.api.hideAllPanels() } },
      { id: "history", label: "Search Session History", hint: "Ctrl+Shift+F", keywords: "find output log scrollback", run: () => setHistoryOpen(true) },
      { id: "export-log", label: "Export Active Terminal Log", keywords: "save download output history file", run: () => handleExportLog() },
      { id: "zen", label: zenMode ? "Exit Focus Mode" : "Enter Focus Mode", hint: "Ctrl+Shift+Z", keywords: "zen distraction free hide sidebar fullscreen", run: () => setZenMode((z) => !z) },
      { id: "agent-rail", label: railOpen ? "Collapse Agent Rail" : "Open Agent Rail", hint: "Ctrl+Alt+A", keywords: "agent rail right column now cost beacon sidebar collapse", run: toggleRail },
      { id: "shortcuts", label: "Keyboard Shortcuts", hint: "Ctrl+/", keywords: "help keys bindings", run: () => setHelpOpen(true) },
      { id: "schedule", label: "New Scheduled Run…", keywords: "schedule recurring cron timer interval daily automate", run: () => { setEditingSchedule(null); setScheduleFormOpen(true) } },
      { id: "session-overview", label: "Show Session Overview", keywords: "context summary findings notes birdseye", run: () => activeSessionId && openOverview(activeSessionId) },
      { id: "handoff", label: "Retire & Continue Terminal", hint: "Ctrl+Shift+H", keywords: "handoff flush summary fresh terminal retire context", run: () => handleHandoff() },
      {
        id: "switch-theme",
        label: `Switch theme (current: ${themeMode})`,
        run: cycleTheme,
      },
      // CAPP-39 gate ④ — set the DEFAULT engine for NEW terminals (the rollback
      // write-path; persists to config + applies on the next-spawned terminal).
      // This is distinct from the per-terminal "Switch to raw terminal (xterm)"
      // escape hatch below, which switches the CURRENT terminal's engine.
      {
        id: "default-engine-structured",
        label: "Default new terminals to structured",
        keywords: "engine default config headless agent structured new terminals rendering",
        run: async () => {
          await window.api.setRenderingEngine("structured")
          toast("success", "New terminals will use the structured engine.")
        },
      },
      {
        id: "default-engine-xterm",
        label: "Default new terminals to raw terminal (xterm)",
        keywords: "engine default config pty legacy raw terminal xterm new terminals rendering rollback",
        run: async () => {
          await window.api.setRenderingEngine("xterm")
          toast("success", "New terminals will use the raw terminal (xterm).")
        },
      },
    ]
    // CAPP-39 gate ③ — the per-terminal raw-view escape hatch, bidirectional from the
    // palette. Only offered when there IS an active terminal; the label reflects the
    // active terminal's current engine (structured → "raw terminal", xterm → "structured").
    const active = activeTerminals.find((t) => t.id === activeTerminalId)
    if (active) {
      // Restart the active terminal in place — reload the proc (picks up MCP/config
      // changes) while resuming the conversation. Works for both engines, so it's
      // offered whenever there's an active terminal (the composer also has a visible
      // Restart button for structured terminals).
      base.push({
        id: "restart-terminal",
        label: "Restart terminal",
        keywords: "restart reload terminal process mcp config resume respawn refresh",
        run: () => handleRestart(activeTerminalId),
      })
      base.push(
        active.engine === "structured"
          ? {
              id: "engine-raw",
              label: "Switch to raw terminal (xterm)",
              keywords: "engine view pty terminal raw escape hatch structured",
              run: () => handleToggleEngine(activeTerminalId),
            }
          : {
              id: "engine-structured",
              label: "Switch to structured view",
              keywords: "engine view agent structured headless escape hatch raw",
              run: () => handleToggleEngine(activeTerminalId),
            },
      )
    }
    const sessionCmds: Command[] = sessions.map((s, i) => ({
      id: `switch-${s.id}`,
      label: `Switch to: ${s.name}`,
      hint: i < 9 ? `Ctrl+${i + 1}` : undefined,
      keywords: "session focus",
      run: () => handleSelectSession(s.id),
    }))
    return [...base, ...sessionCmds]
  }, [handleNewSession, handleNewTerminal, handleCloseTerminal, handleKillSession, handleHandoff, handleRestart, toggleSplit, handleExportLog, handleSelectSession, zenMode, splitLeft, sessions, openOverview, activeSessionId, activeTerminals, activeTerminalId, handleToggleEngine, themeMode, cycleTheme, railOpen, toggleRail, setPaletteOpen, setHelpOpen, setHistoryOpen, setZenMode])

  // Keyboard shortcuts — use capture phase so they fire before xterm.js
  useEffect(() => {
    const platform = window.api.platform
    const handler = (e: KeyboardEvent) => {
      const mod = cmdOrCtrl(e, platform)
      if (mod && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault(); e.stopPropagation()
        setPaletteOpen((o) => !o)
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault(); e.stopPropagation()
        setHistoryOpen((o) => !o)
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault(); e.stopPropagation()
        setZenMode((z) => !z)
      } else if (mod && e.altKey && !e.shiftKey && e.key.toLowerCase() === "a") {
        // Ctrl+Alt+A / Cmd+Alt+A — toggle the Agent Rail (the right-edge agent-state
        // column). Ctrl+Alt is free: the existing Ctrl+letter binds all require
        // `!e.altKey`, and Alt+1-9 requires `!mod`, so this collides with nothing.
        e.preventDefault(); e.stopPropagation()
        toggleRail()
      } else if (mod && e.key === "/") {
        e.preventDefault(); e.stopPropagation()
        setHelpOpen((o) => !o)
      } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
        // Ctrl+N / Cmd+N — new session
        e.preventDefault(); e.stopPropagation()
        handleNewSession()
      } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "t") {
        // Ctrl+T / Cmd+T — new terminal in the active session (or a new session if none)
        e.preventDefault(); e.stopPropagation()
        handleNewTerminal()
      } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "w") {
        // Ctrl+W / Cmd+W — close the active terminal (session stays alive if it was the last)
        e.preventDefault(); e.stopPropagation()
        handleCloseTerminal()
      } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        // Ctrl+K / Cmd+K — kill the active session (confirm)
        e.preventDefault(); e.stopPropagation()
        handleKillSession()
      } else if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "h") {
        // Ctrl+Shift+H / Cmd+Shift+H — retire & continue (handoff): flush summary, fresh terminal,
        // retire old. NOT plain Ctrl+H: that's ASCII Backspace (^H), so swallowing
        // it here would eat the user's backspace inside the terminal prompt.
        e.preventDefault(); e.stopPropagation()
        handleHandoff()
      } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j") {
        // Ctrl+J / Cmd+J — jump to the top VISIBLE "NEEDS YOU" entry ("who needs
        // me?"). Use scopedAttention (the workspace-filtered list the sidebar
        // actually renders), NOT the unfiltered attentionEntries — otherwise Ctrl+J
        // could yank the user to an off-scope session, or fire when no rows
        // are even visible. The queue is pre-sorted (tier then oldest-first) by the
        // service and the filter preserves order, so [0] is the most urgent visible
        // entry. No-op when nothing is visible.
        e.preventDefault(); e.stopPropagation()
        if (scopedAttention.length) jumpToAttention(scopedAttention[0])
      } else if (mod && e.key === "\\") {
        e.preventDefault(); e.stopPropagation()
        toggleSplit()
      } else if (mod && e.key === "Tab") {
        // Ctrl+Tab / Cmd+Tab / Ctrl+Shift+Tab — cycle terminals within the active session
        e.preventDefault(); e.stopPropagation()
        if (activeTerminals.length) {
          const i = Math.max(0, activeTerminals.findIndex((t) => t.id === activeTerminalId))
          const next = e.shiftKey
            ? (i - 1 + activeTerminals.length) % activeTerminals.length
            : (i + 1) % activeTerminals.length
          setActiveTerminalId(activeTerminals[next].id)
        }
      } else if (e.key === "Escape" && helpOpen) {
        e.preventDefault(); e.stopPropagation()
        setHelpOpen(false)
      } else if (
        e.key === "Escape" &&
        !paletteOpen && !historyOpen && !scheduleFormOpen &&
        pendingKillId === null
      ) {
        // CAPP-120 (STT-1 review, MAJOR 2) — an ACTIVE DICTATION RECORDING owns Esc
        // FIRST: discard the recording (mic off, nothing transcribed, composer text
        // untouched) WITHOUT interrupting the agent's turn. This capture-phase handler
        // runs before the composer's own bubble-phase Esc arm, so without this
        // precedence check a recording made while the agent was busy would hijack Esc
        // into an interrupt AND leave the mic hot. dispatchDictationEsc() consults every
        // mounted composer (split panes register two) and returns true only when one
        // actually discarded a live recording — the pure ordering is escapePrecedence()
        // in src/lib/micInteraction.ts.
        if (dispatchDictationEsc()) {
          e.preventDefault(); e.stopPropagation()
        }
        // BO-10 — otherwise Esc stops a structured terminal mid-turn (generating OR
        // awaiting a permission): kill + resume the conversation. escInterruptRef
        // returns false when the active terminal isn't structured+busy, so Esc passes
        // through untouched to an xterm/PTY (where it is load-bearing) and is a no-op
        // when idle. Guarded on the nav overlays so an open palette/history
        // overlay closes via its OWN Esc handler instead of being hijacked into an
        // interrupt — this capture-phase handler would otherwise stopPropagation and
        // suppress that close.
        // CAPP-93 / U5 — also guard on the KillSessionModal: Esc must cancel that modal
        // (via its own handler), NOT hijack into a terminal interrupt.
        // (helpOpen is handled by the arm above; the permission prompt is intentionally
        // NOT guarded — Esc-to-stop while awaiting a permission is the whole point.)
        else if (escInterruptRef.current()) {
          e.preventDefault(); e.stopPropagation()
        }
      } else if (e.altKey && !mod && !e.shiftKey && e.key >= "1" && e.key <= "9") {
        // Alt+1–9 — switch terminal within the active session
        e.preventDefault(); e.stopPropagation()
        const t = activeTerminals[parseInt(e.key) - 1]
        if (t) setActiveTerminalId(t.id)
      } else if (mod && !e.shiftKey && !e.altKey && e.key >= "1" && e.key <= "9") {
        // Ctrl+1–9 / Cmd+1–9 — switch session
        e.preventDefault(); e.stopPropagation()
        const s = sessions[parseInt(e.key) - 1]
        if (s) handleSelectSession(s.id)
      }
    }
    window.addEventListener("keydown", handler, { capture: true })
    return () => window.removeEventListener("keydown", handler, { capture: true })
  }, [handleNewSession, handleNewTerminal, handleCloseTerminal, handleKillSession, handleHandoff, toggleSplit, handleSelectSession, sessions, activeTerminals, activeTerminalId, helpOpen, paletteOpen, historyOpen, pendingKillId, setActiveTerminalId, setPaletteOpen, setHistoryOpen, setZenMode, setHelpOpen, scopedAttention, jumpToAttention, toggleRail])

  return (
    <div
      className={`app${zenMode ? " zen" : ""}${railOpen ? " rail-open" : " rail-collapsed"}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <DropZone active={dragActive} />
      <ToastHost />
      {/* CAPP-84 — frameless window controls hoisted out of the tab bar to a direct
          .app child, so they pin to the window's true top-right corner ABOVE the Agent
          Rail (which would otherwise push them inward). Hidden in zen via .app.zen. */}
      <WindowControls />
      {/* BO-4b — the permission gate fires ONLY on the structured engine (xterm
          spawns with --dangerously-skip-permissions, so no approve_tool gate ever
          fires). Gate on a pending request rather than a global engine flag: a
          request is itself proof a structured terminal asked.
          BO-11 (CAPP-50) — render ONLY the ACTIVE terminal's requests, never the
          global queue. A background/dead terminal's position:fixed card would
          otherwise physically overlap the active session's composer ("can't type" —
          occluded, not disabled). isTerminalBusy still reads the global queue. */}
      {activePermissionRequests.length > 0 && (
        <PermissionPrompt requests={activePermissionRequests} onResolve={handlePermissionResolve} />
      )}
      {/* CAPP-93 / U5 — the delete-time Keep/trim/edit gate. Renders off pendingKillId
          (set by any kill entry point); the modal owns the actual kill. */}
      <KillSessionModal
        sessionId={pendingKillId}
        sessionName={pendingKillName}
        onClose={() => setPendingKillId(null)}
      />
      {/* CAPP-109 / S2 — in-main-window modal panels (modal-by-default). Renders the
          shared PanelContent off the usePanels mirror. EVERY close path resolves a
          pending show_form as cancelled via window.api.hidePanel.
          CAPP-110 / S3 — `onPopOut` moves the active panel to the companion window
          (panel:pop-out → PanelService.popOut). It does NOT call hidePanel, so a pending
          show_form's promise survives the pop-out untouched; the panel leaves the main
          mirror (a panel:hide drops it from usePanels) and the modal reselects/unmounts. */}
      <ModalHost
        panels={panels}
        activeId={modalActiveId}
        onActivate={setModalActiveId}
        onClose={handleModalClose}
        onPopOut={(id) => void window.api.popOutPanel(id).catch(() => {})}
      />
      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <HistorySearch
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onSelectSession={(id) => setActiveTerminalId(id)}
      />
      <ScheduleForm
        open={scheduleFormOpen}
        editing={editingSchedule}
        onClose={() => setScheduleFormOpen(false)}
        onSubmit={(input: ScheduleFormInput) => {
          if (editingSchedule) updateSchedule(editingSchedule.id, input)
          else createSchedule({ ...input, workspaceId: activeWorkspaceId ?? undefined })
        }}
        onDelete={(id) => removeSchedule(id)}
      />
      <WorkspaceCreateModal
        open={createWorkspaceOpen}
        onClose={() => setCreateWorkspaceOpen(false)}
        existingNames={workspaces.map((w) => w.name)}
        onCreate={async (name, dir) => {
          // Create, then make the new workspace active (routes through the
          // active-changed push so the filter + pill flip to it). WS-H: a single
          // optional folder.
          const ws = await createWorkspace_(name, dir)
          if (ws) setActiveWorkspace(ws.id)
          return ws
        }}
      />
      <RestoreConversationModal
        open={restoreConvoOpen}
        onClose={() => setRestoreConvoOpen(false)}
        folder={activeWorkspace?.dir ?? null}
        onRestore={handleRestoreConversation}
      />
      <Sidebar
        sessions={scopedSessions}
        activeSessionId={activeSessionId}
        attentionEntries={scopedAttention}
        attentionNow={attentionNow}
        onJumpAttention={jumpToAttention}
        onDismissAttention={dismissAttention}
        schedules={scopedSchedules}
        onNewSchedule={() => { setEditingSchedule(null); setScheduleFormOpen(true) }}
        onOpenSchedule={(s) => { openSchedule(s).catch(() => {}) }}
        onToggleSchedule={(id, enabled) => toggleSchedule(id, enabled)}
        onRunSchedule={(id) => runScheduleNow(id)}
        onNewSession={handleNewSession}
        onKillSession={handleKillSession}
        onKillSessionById={handleKillSessionById}
        onSelectSession={handleSelectSession}
        onRenameSession={handleRenameSession}
        resumingRows={resumingRows}
        onFocusResuming={handleFocusResuming}
        onStopResuming={handleStopResuming}
        onDismissResuming={clearResuming}
        workspaces={workspaces}
        activeWorkspace={activeWorkspace}
        workspaceScoped={activeWorkspaceId != null}
        onSelectAllWorkspaces={() => setActiveWorkspace(null)}
        onSelectWorkspace={(id) => setActiveWorkspace(id)}
        onNewWorkspace={() => setCreateWorkspaceOpen(true)}
        onRenameWorkspace={(id, name) => renameWorkspace_(id, name)}
        onDeleteWorkspace={(id) => deleteWorkspace_(id)}
        onSetWorkspaceDir={(id, dir) => setWorkspaceDir_(id, dir)}
        onRestoreConversation={() => setRestoreConvoOpen(true)}
        onOpenContextInspector={handleOpenContextInspector}
      />
      <div className="main-area">
        <TabBar
          terminals={activeTerminals}
          activeTerminalId={activeTerminalId}
          splitId={splitRight}
          onSelectTerminal={(id) => setActiveTerminalId(id)}
          onCloseTerminal={(id) => activeSessionId && window.api.closeTerminal(activeSessionId, id)}
          onRenameTerminal={handleRenameTerminal}
          onNewTerminal={handleNewTerminal}
          panelCount={panels.filter((p) => p.visible).length}
          panelsRecentlyChanged={panelsRecentlyChanged}
          onFocusCompanion={() => {
            try { window.api.focusCompanion() } catch (err) {
              toast("error", `Couldn't raise the panels window: ${err instanceof Error ? err.message : String(err)}`)
            }
          }}
        />
        <div className="terminal-container">
          {splitLeft && splitRight ? (
            <SplitView
              leftId={splitLeft}
              rightId={splitRight}
              activeId={activeTerminalId ?? splitLeft}
              onSelectSession={(id) => setActiveTerminalId(id)}
              terminals={activeTerminals}
              sessionId={activeSessionId}
              transcriptCache={transcriptCacheRef.current}
              transcriptStore={transcriptStoreRef.current}
              onSwitched={setActiveTerminalId}
              isTerminalBusy={isTerminalBusy}
              modelOptions={modelOptions}
              extraXhigh={extraXhigh}
              themeMode={themeMode}
              fontFamily={config?.fontFamily}
              fontSize={config?.fontSize}
            />
          ) : (
            <>
              {activeTerminals.map((t) =>
                // BO-4b PER-TERMINAL fork: render on THIS terminal's actual engine
                // (surfaced from the backend), not a global config boolean. A
                // headless terminal gets AgentView + the BO-3 composer; an xterm
                // (or legacy/undefined) terminal keeps TerminalPane. The DEFAULT is
                // now structured (CAPP-39 gate 4), but this fork keys ONLY on the
                // per-terminal t.engine, so it is independent of the default.
                t.engine === "structured" ? (
                  <AgentSurface
                    key={t.id}
                    terminalId={t.id}
                    sessionId={activeSessionId}
                    model={t.model}
                    effort={t.effort}
                    ultracode={t.ultracode}
                    modelOptions={modelOptions}
                    resolvedModel={t.resolvedModel}
                    extraXhigh={extraXhigh}
                    ccConversationId={t.ccConversationId}
                    transcriptCache={transcriptCacheRef.current}
                    transcriptStore={transcriptStoreRef.current}
                    active={t.id === activeTerminalId}
                    busy={isTerminalBusy(t.id)}
                    onSwitched={setActiveTerminalId}
                  />
                ) : (
                  <TerminalPane
                    key={t.id}
                    sessionId={t.id}
                    active={t.id === activeTerminalId}
                    lastState={t.lastState}
                    themeMode={themeMode}
                    fontFamily={config?.fontFamily}
                    fontSize={config?.fontSize}
                  />
                ),
              )}
              {activeTerminals.length === 0 && (
                <div className="empty-state">
                  <p>No active terminal.</p>
                  <p>Create a session to get started.</p>
                  <div className="shortcut-hints">
                    <span className="shortcut-key">Ctrl+N</span>
                    <span className="shortcut-desc">New session</span>
                    <span className="shortcut-key">Ctrl+T</span>
                    <span className="shortcut-desc">New terminal</span>
                    <span className="shortcut-key">Ctrl+W</span>
                    <span className="shortcut-desc">Close terminal</span>
                    <span className="shortcut-key">Ctrl+K</span>
                    <span className="shortcut-desc">Kill session</span>
                    <span className="shortcut-key">Ctrl+\</span>
                    <span className="shortcut-desc">Split panes</span>
                    <span className="shortcut-key">Ctrl+1-9</span>
                    <span className="shortcut-desc">Switch session</span>
                    <span className="shortcut-key">Alt+1-9</span>
                    <span className="shortcut-desc">Switch terminal</span>
                    <span className="shortcut-key">Ctrl+Shift+P</span>
                    <span className="shortcut-desc">Command palette</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {/* Agent Rail (v1) — the third flex sibling of .sidebar + .main-area, on the
          RIGHT. A lens over existing seams (NOW + COST); collapses to a 32px spine so
          the center transcript reflows. Hidden in zen/focus mode (the .app.zen rule). */}
      <AgentRail
        open={railOpen}
        onToggle={toggleRail}
        hasTerminal={activeTerminalId != null}
        terminalId={activeTerminalId}
        busy={railBusy}
        activity={activeTerminalForRail?.activity}
        blocks={railBlocks}
      />
    </div>
  )
}
