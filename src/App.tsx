import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { cmdOrCtrl } from "./lib/platform"
import type {
  TerminalStreamPayload,
  PermissionRequest,
  PermissionDecision,
  AgentCatalog,
  StreamEvent,
} from "../electron/services/streamProtocol"
import Sidebar from "./components/Sidebar"
import TabBar from "./components/TabBar"
import TerminalPane from "./components/TerminalPane"
import AgentSurface from "./components/AgentSurface"
import type { TranscriptCache } from "./components/AgentView"
import PermissionPrompt from "./components/PermissionPrompt"
import SplitView from "./components/SplitView"
import DropZone from "./components/DropZone"
import { usePermissions } from "./hooks/usePermissions"
import { useGeneratingTerminals } from "./hooks/useAgentBusy"
import CommandPalette, { Command } from "./components/CommandPalette"
import ToastHost from "./components/ToastHost"
import ShortcutsHelp from "./components/ShortcutsHelp"
import HistorySearch from "./components/HistorySearch"
import MissionPrompt from "./components/MissionPrompt"
import MissionsList from "./components/MissionsList"
import WorkspaceCreateModal from "./components/WorkspaceCreateModal"
import { toast } from "./lib/toast"
import { useSessions } from "./hooks/useSessions"
import { useAttention } from "./hooks/useAttention"
import { useMissions } from "./hooks/useMissions"
import { useWorkspaces } from "./hooks/useWorkspaces"
import { filterByWorkspace } from "./lib/workspaceFilter"
import { filterAttentionByWorkspace } from "./lib/workspaceScope"
import { useSplitView } from "./hooks/useSplitView"
import { useOverlays } from "./hooks/useOverlays"
import { useTheme } from "./hooks/useTheme"
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
      // BO-7: structured composer `/`-command picker catalog + native-command bridge
      getAgentCatalog: (terminalId: string) => Promise<AgentCatalog | null>
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
      reopenTerminal: (sessionId: string, terminalId: string) => Promise<{ terminalId: string } | undefined>
      closeTerminal: (sessionId: string, terminalId: string) => Promise<void>
      killWorkSession: (sessionId: string) => Promise<void>
      getWorkSessionContext: (sessionId: string) => Promise<string | undefined>
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
      createWorkspace: (name: string, dirs?: string[]) => Promise<any | null>
      renameWorkspace: (id: string, name: string) => Promise<any | null>
      addWorkspaceDir: (id: string, dir: string) => Promise<any | null>
      removeWorkspaceDir: (id: string, dir: string) => Promise<any | null>
      deleteWorkspace: (id: string) => Promise<boolean>
      setActiveWorkspace: (id: string | null) => Promise<boolean>
      launchWorkspace: (id: string) => Promise<any | null>
      // WS-F — on-demand discovery refresh (switcher ⟳). Returns the updated
      // PUBLIC list (seeds new manifests; never duplicates / reverts user edits).
      rescanWorkspaces: () => Promise<any[]>
      // WS-D — native folder picker (create-workspace modal). [] on cancel.
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
      hideAllPanels: () => Promise<void>
      submitForm: (id: string, data: Record<string, any>) => void
      // Notifications
      listNotifications: () => Promise<any[]>
      dismissNotification: (id: string) => Promise<boolean>
      onNotificationShow: (callback: (notification: any) => void) => void
      onNotificationDismiss: (callback: (id: string) => void) => void
      // Attention queue (AQ-2)
      attentionSeen: (terminalId: string) => Promise<void>
      attentionSeenMission: (missionId: string) => Promise<void>
      attentionDismiss: (id: string) => Promise<boolean>
      onAttentionUpdated: (callback: (entries: any[]) => void) => void
      onAttentionJump: (callback: (id: string) => void) => void
      // Mission push events (MS-2 — push not poll)
      onMissionUpdated: (callback: (mission: any) => void) => void
      onMissionRemoved?: (callback: (id: string) => void) => void
      onPanelShow: (callback: (panel: PanelState) => void) => void
      onPanelUpdate: (callback: (payload: { id: string; props: any }) => void) => void
      onPanelHide: (callback: (id: string) => void) => void
      onPanelHideAll: (callback: () => void) => void
      // Missions
      createMission: (goal: string, cwd: string, autonomy?: string) => Promise<any>
      listMissions: () => Promise<any[]>
      getMissionStatus: (id?: string) => Promise<any>
      stopMission: (id: string) => Promise<any>
      pauseMission: (id: string) => Promise<any>
      resumeMission: (id: string) => Promise<any>
      deleteMission: (id: string) => Promise<boolean>
      // WW-2b — worktree review
      approveWorktreeTask: (missionId: string, taskId: string) => Promise<{ status?: string; reviewReason?: string } | null>
      rejectWorktreeTask: (missionId: string, taskId: string, reason?: string) => Promise<{ status?: string; reviewReason?: string } | null>
      getReviewTask: (missionId: string, taskId: string) => Promise<{ missionId: string; taskId: string; title: string; diff: string; reviewReason?: string; status?: string } | null>
      removeAllListeners: (channel: string) => void
      getSessionOverview: (sessionId: string) => Promise<any>
      getSessionTimeline: (sessionId: string) => Promise<Array<{ time: number; kind: string; text: string; terminalId?: string }>>
      handoffTerminal: (sessionId: string, terminalId: string) => Promise<{ terminalId: string } | undefined>
      // CAPP-39 gate ② — launch an interactive `claude /login` terminal (structured
      // engine can't show OAuth UI); from the AgentView "not signed in" Sign-in button.
      startLogin: (sessionId?: string) => Promise<{ terminalId: string } | undefined>
      // BO-6 — switch a structured terminal's --model (respawns + resumes the chat)
      setTerminalModel: (sessionId: string, terminalId: string, model: string) => Promise<{ terminalId: string } | undefined>
      // CAPP-46 — switch a structured terminal's --effort level (respawns + resumes the chat)
      setTerminalEffort: (sessionId: string, terminalId: string, effort: string) => Promise<{ terminalId: string } | undefined>
      // CAPP-39 gate ③ — per-terminal raw-view escape hatch: toggle one terminal between
      // the structured and xterm engines at runtime (respawns + resumes the chat).
      setTerminalEngine: (sessionId: string, terminalId: string, targetEngine: "xterm" | "structured") => Promise<{ terminalId: string } | undefined>
      // BO-10 — stop/interrupt a structured terminal (kills + resumes the chat).
      // Returns the respawned terminal id so the caller re-points the active tab.
      interruptAgent: (terminalId: string) => Promise<{ terminalId: string } | undefined>
      // Theme
      getTheme: () => Promise<string>
      setTheme: (mode: string) => Promise<void>
      onThemeChanged: (callback: (mode: string) => void) => void
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

  const {
    sessions,
    activeSessionId,
    activeTerminalId,
    setActiveTerminalId,
    config,
    activeSession,
    activeTerminals,
    handleNewSession,
    handleNewTerminal,
    handleCloseTerminal,
    handleHandoff,
    handleKillSession,
    handleKillSessionById,
    handleRenameTerminal,
    handleSelectSession,
  } = useSessions(refreshOverviewsRef)

  // BO-12 (CAPP-51) — the shared, cross-pane transcript cache (folded TranscriptState
  // keyed by the STABLE Claude Code conversation id). Held in a ref so the Map
  // instance is stable across renders; lives above AgentView so a structured
  // respawn (which remounts AgentView under a new terminal id, but the SAME convo
  // id) re-seeds the prior turns INSTANTLY from memory, and split panes sharing a
  // convo share the entry.
  const transcriptCacheRef = useRef<TranscriptCache>(new Map())

  // GC cache entries whose convo id no longer belongs to any live terminal — i.e.
  // a closed terminal or a killed session. A `--resume` respawn keeps the convo id
  // on its ref, so it stays "live" and is never evicted mid-respawn; only a genuine
  // close/kill drops it. Cheap set-diff on each session change.
  useEffect(() => {
    const live = new Set<string>()
    for (const s of sessions) {
      for (const t of s.terminals) if (t.ccConversationId) live.add(t.ccConversationId)
    }
    for (const key of transcriptCacheRef.current.keys()) {
      if (!live.has(key)) transcriptCacheRef.current.delete(key)
    }
  }, [sessions])

  // BO-4b — the renderer fork is PER TERMINAL (on `t.engine`, surfaced from the
  // backend), not a single global config boolean. The old global derived from the
  // async-loaded config ("xterm" until it arrived) raced session restore: a
  // structured terminal could mount under TerminalPane (a blank xterm awaiting
  // ANSI that never comes) with no composer at all. Forking on each terminal's
  // ACTUAL engine removes that race and fixes split panes in one move. See the
  // `activeTerminals.map` fork and SplitView below.

  // Attention queue: focus an entry's session+terminal (terminal entries), or open
  // the mission dashboard panel (mission entries carrying missionId). Held in a ref
  // so the hook's mount-once `attention:jump` listener always calls the latest closure.
  const focusEntryRef = useRef<(sessionId: string, terminalId?: string) => void>(() => {})
  // MS-2: mission attention entries open the dashboard panel. Ref so useAttention's
  // mount-once handler always calls the latest closure. Set after usePanels is called.
  const jumpToMissionRef = useRef<((missionId: string) => void) | null>(null)
  // WW-2b: worktree-review attention entries (carrying a taskId) open the review
  // panel for that mission+task. Same ref pattern as jumpToMissionRef.
  const jumpToReviewRef = useRef<((missionId: string, taskId: string) => void) | null>(null)

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
  } = useAttention(focusEntryRef, jumpToMissionRef, jumpToReviewRef)

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

  const {
    paletteOpen,
    setPaletteOpen,
    helpOpen,
    setHelpOpen,
    historyOpen,
    setHistoryOpen,
    missionPromptOpen,
    setMissionPromptOpen,
    missionsListOpen,
    setMissionsListOpen,
    zenMode,
    setZenMode,
  } = useOverlays()

  const { themeMode } = useTheme()

  // useMissions must come before usePanels so allMissions can be passed for panel refresh.
  const {
    missions: allMissions,
    visible: visibleMissions,
    dismiss: dismissMission,
  } = useMissions()

  // WS-D — the workspaces surface (switcher + active-workspace scoping). The
  // active id drives the FILTER & HIDE of the three sidebar sections below.
  const {
    workspaces,
    activeId: activeWorkspaceId,
    active: activeWorkspace,
    setActive: setActiveWorkspace,
    create: createWorkspace_,
    rename: renameWorkspace_,
    remove: deleteWorkspace_,
    rescan: rescanWorkspaces_,
  } = useWorkspaces()
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false)

  // WS-D — FILTER & HIDE. A specific active workspace scopes each section to its
  // own items; "All" (activeWorkspaceId null) shows everything (untagged/legacy
  // items are "All"-only). SESSIONS + MISSIONS carry workspaceId directly;
  // attention entries resolve theirs from the owning session/mission. Re-derived
  // reactively whenever the active id or the underlying lists change.
  const scopedSessions = useMemo(
    () => filterByWorkspace(sessions, activeWorkspaceId),
    [sessions, activeWorkspaceId],
  )
  const scopedMissions = useMemo(
    () => filterByWorkspace(visibleMissions, activeWorkspaceId),
    [visibleMissions, activeWorkspaceId],
  )
  const scopedAttention = useMemo(
    () => filterAttentionByWorkspace(attentionEntries, activeWorkspaceId, sessions, allMissions),
    [attentionEntries, activeWorkspaceId, sessions, allMissions],
  )

  const {
    panels,
    recentlyChanged: panelsRecentlyChanged,
    setPanels,
    openMission,
    openOverview,
    openTimeline,
    createMission,
  } = usePanels(refreshOverviewsRef, activeSession, missionsListOpen, allMissions)

  // MS-2: wire the mission-dashboard opener into the attention-jump ref so that
  // attention entries carrying missionId route to the panel (not a terminal).
  // openMission is stable (useCallback in usePanels), so the effect runs once.
  useEffect(() => {
    jumpToMissionRef.current = (missionId: string) => {
      openMission({ id: missionId }).catch(() => {})
    }
  }, [openMission])

  // WW-2b: wire the worktree-review opener into the attention-jump ref. A review
  // entry carries missionId+taskId; we fetch the LATEST captured diff via IPC
  // (so the panel always has fresh content) then open the review panel in the
  // companion window. P0-5: surface a fetch/open failure as a toast.
  useEffect(() => {
    jumpToReviewRef.current = (missionId: string, taskId: string) => {
      void (async () => {
        try {
          const task = await window.api.getReviewTask(missionId, taskId)
          if (!task) {
            toast("warning", "That review task is no longer available.")
            return
          }
          await window.api.showPanel("worktree-review", task, "right")
        } catch (err) {
          toast("error", `Couldn't open the review panel: ${errMsg(err)}`)
        }
      })()
    }
  }, [])

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
      { id: "shortcuts", label: "Keyboard Shortcuts", hint: "Ctrl+/", keywords: "help keys bindings", run: () => setHelpOpen(true) },
      { id: "mission", label: "Start Mission…", keywords: "orchestrate conductor autonomous build", run: () => setMissionPromptOpen(true) },
      { id: "missions", label: "View Missions", keywords: "orchestrate conductor list dashboard status", run: () => setMissionsListOpen(true) },
      { id: "session-overview", label: "Show Session Overview", keywords: "context summary findings notes birdseye", run: () => activeSessionId && openOverview(activeSessionId) },
      { id: "session-timeline", label: "Show Session Timeline", keywords: "history events chronology activity log", run: () => { const s = sessions.find((x) => x.id === activeSessionId); if (s) openTimeline(s.id, s.name) } },
      { id: "handoff", label: "Retire & Continue Terminal", hint: "Ctrl+Shift+H", keywords: "handoff flush summary fresh terminal retire context", run: () => handleHandoff() },
      {
        id: "switch-theme",
        label: `Switch theme (current: ${themeMode})`,
        run: cycleTheme,
      },
    ]
    // CAPP-39 gate ③ — the per-terminal raw-view escape hatch, bidirectional from the
    // palette. Only offered when there IS an active terminal; the label reflects the
    // active terminal's current engine (structured → "raw terminal", xterm → "structured").
    const active = activeTerminals.find((t) => t.id === activeTerminalId)
    if (active) {
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
  }, [handleNewSession, handleNewTerminal, handleCloseTerminal, handleKillSession, handleHandoff, toggleSplit, handleExportLog, handleSelectSession, zenMode, splitLeft, sessions, openOverview, openTimeline, activeSessionId, activeTerminals, activeTerminalId, handleToggleEngine, themeMode, cycleTheme, setPaletteOpen, setHelpOpen, setHistoryOpen, setMissionPromptOpen, setMissionsListOpen, setZenMode])

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
        // could yank the user to an off-scope session/mission, or fire when no rows
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
        !paletteOpen && !historyOpen && !missionPromptOpen && !missionsListOpen
      ) {
        // BO-10 — Esc stops a structured terminal mid-turn (generating OR awaiting a
        // permission): kill + resume the conversation. escInterruptRef returns false
        // when the active terminal isn't structured+busy, so Esc passes through
        // untouched to an xterm/PTY (where it is load-bearing) and is a no-op when idle.
        // Guarded on the nav overlays so an open palette/history/mission overlay closes
        // via its OWN Esc handler instead of being hijacked into an interrupt — this
        // capture-phase handler would otherwise stopPropagation and suppress that close.
        // (helpOpen is handled by the arm above; the permission prompt is intentionally
        // NOT guarded — Esc-to-stop while awaiting a permission is the whole point.)
        if (escInterruptRef.current()) {
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
  }, [handleNewSession, handleNewTerminal, handleCloseTerminal, handleKillSession, handleHandoff, toggleSplit, handleSelectSession, sessions, activeTerminals, activeTerminalId, helpOpen, paletteOpen, historyOpen, missionPromptOpen, missionsListOpen, setActiveTerminalId, setPaletteOpen, setHistoryOpen, setZenMode, setHelpOpen, scopedAttention, jumpToAttention])

  return (
    <div
      className={`app${zenMode ? " zen" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <DropZone active={dragActive} />
      <ToastHost />
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
      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <HistorySearch
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onSelectSession={(id) => setActiveTerminalId(id)}
      />
      <MissionPrompt
        open={missionPromptOpen}
        onClose={() => setMissionPromptOpen(false)}
        onSubmit={createMission}
      />
      <WorkspaceCreateModal
        open={createWorkspaceOpen}
        onClose={() => setCreateWorkspaceOpen(false)}
        existingNames={workspaces.map((w) => w.name)}
        onCreate={async (name, dirs) => {
          // Create, then make the new workspace active (routes through the
          // active-changed push so the filter + pill flip to it).
          const ws = await createWorkspace_(name, dirs)
          if (ws) setActiveWorkspace(ws.id)
          return ws
        }}
      />
      <MissionsList
        open={missionsListOpen}
        missions={allMissions}
        onClose={() => setMissionsListOpen(false)}
        onOpen={(m) => {
          openMission(m)
          setMissionsListOpen(false)
        }}
        onStop={(id) => window.api.stopMission(id)}
        onPause={(id) => window.api.pauseMission(id)}
        onResume={(id) => window.api.resumeMission(id)}
      />
      <Sidebar
        sessions={scopedSessions}
        activeSessionId={activeSessionId}
        attentionEntries={scopedAttention}
        attentionNow={attentionNow}
        onJumpAttention={jumpToAttention}
        onDismissAttention={dismissAttention}
        missions={scopedMissions}
        onOpenMission={(m) => {
          openMission(m).catch(() => {})
          Promise.resolve(window.api.attentionSeenMission(m.id)).catch(() => {})
        }}
        onDismissMission={dismissMission}
        onNewMission={() => setMissionPromptOpen(true)}
        onFocusConductor={(sessionId) => handleSelectSession(sessionId)}
        onNewSession={handleNewSession}
        onKillSession={handleKillSession}
        onKillSessionById={handleKillSessionById}
        onSelectSession={handleSelectSession}
        workspaces={workspaces}
        activeWorkspace={activeWorkspace}
        workspaceScoped={activeWorkspaceId != null}
        onSelectAllWorkspaces={() => setActiveWorkspace(null)}
        onSelectWorkspace={(id) => setActiveWorkspace(id)}
        onNewWorkspace={() => setCreateWorkspaceOpen(true)}
        onRenameWorkspace={(id, name) => renameWorkspace_(id, name)}
        onDeleteWorkspace={(id) => deleteWorkspace_(id)}
        onRescanWorkspaces={async () => {
          // WS-F — on-demand discovery refresh. Surface a quiet result toast so
          // the action feels acknowledged even when nothing new turned up. The
          // hook owns the failure toast; null means it already reported.
          const res = await rescanWorkspaces_()
          if (res)
            toast(
              "success",
              res.added > 0
                ? `Found ${res.added} new workspace${res.added === 1 ? "" : "s"}`
                : "Workspaces up to date",
            )
        }}
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
              onSwitched={setActiveTerminalId}
              isTerminalBusy={isTerminalBusy}
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
                // (or legacy/undefined) terminal keeps TerminalPane. Default stays
                // xterm, so live behavior is unchanged unless the terminal was
                // spawned structured.
                t.engine === "structured" ? (
                  <AgentSurface
                    key={t.id}
                    terminalId={t.id}
                    sessionId={activeSessionId}
                    model={t.model}
                    effort={t.effort}
                    ccConversationId={t.ccConversationId}
                    transcriptCache={transcriptCacheRef.current}
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
    </div>
  )
}
