import { useState, useEffect, useCallback, type MutableRefObject } from "react"
import { toast } from "../lib/toast"

export interface Terminal {
  id: string
  name: string
  cwd: string
  lastState: "active" | "idle" | "dead"
  /**
   * BO-4b — the transport this terminal was actually spawned with, surfaced from
   * the backend (TerminalRef.engine). The renderer forks PER TERMINAL on this:
   * "structured" → AgentView + AgentComposer, "xterm" (or undefined, the legacy
   * default) → TerminalPane. Replaces the global config boolean that raced the
   * async config load.
   */
  engine?: "xterm" | "structured"
  /** BO-6 — the `--model` a structured terminal runs (from TerminalRef.model);
   *  shown in + driven by the in-app model picker. Undefined for xterm. */
  model?: string
  /** CAPP-46 — the `--effort` level a structured terminal runs (from
   *  TerminalRef.effort); shown in + driven by the in-app effort picker. Undefined
   *  for xterm or when no level is set. Flows to the renderer via the `{...t}` spread
   *  in SessionService.withEffectiveActivity. */
  effort?: string
  /**
   * BO-12 — the Claude Code conversation id this terminal is bound to (from
   * TerminalRef.ccConversationId; already flows to the renderer via the `{...t}`
   * spread in SessionService.withEffectiveActivity). STABLE across a `--resume`
   * respawn (Stop/model-switch/handoff/restart all append to the SAME transcript),
   * so it keys the transcript rehydrate + the in-memory transcript cache. Undefined
   * until Claude Code writes the transcript (first turn) or for an xterm terminal.
   */
  ccConversationId?: string
  activity?: string
}

export interface WorkSession {
  id: string
  name: string
  status: "active" | "stopped"
  summary: string
  terminals: Terminal[]
  /** WS-C — the workspace this session belongs to (stamped at create() time;
   *  undefined for untagged/legacy sessions → the "All" bucket). Rides along in
   *  every worksession:updated / list() snapshot via the service's `...s` spread.
   *  WS-D filters the sidebar's SESSIONS section on it. */
  workspaceId?: string
}

// Normalize an unknown thrown value into a human-readable message for toasts.
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Owns the durable work-session container state (sessions, the active session/
// terminal selection, workspaces, config) plus the session/terminal IPC listeners
// and the P0-5 toast-wrapped action handlers (new/terminal/close/kill/rename/
// handoff/select). Owns the cleanup for exactly the listeners it registers:
// worksession:updated, worksession:removed, terminal:focus, terminal:renamed.
//
// `refreshOverviews` is supplied by App.tsx so worksession:updated can also kick
// the Session Overview live-refresh without registering a second listener on that
// channel (the overview/panel logic stays in App.tsx). It is passed as a ref so
// this mount-once effect always calls the latest callback.
export function useSessions(
  refreshOverviews: MutableRefObject<(() => void) | null>,
) {
  const [sessions, setSessions] = useState<WorkSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null)
  const [config, setConfig] = useState<any>(null)

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null
  const activeTerminals = activeSession?.terminals ?? []
  const activeTerminal = activeTerminals.find((t) => t.id === activeTerminalId) ?? null

  // Load config and existing session records on mount, then auto-restore all
  // terminals in parallel. (Workspaces are owned by useWorkspaces — WS-D — so
  // this hook no longer fetches them.)
  useEffect(() => {
    window.api.getConfig().then(setConfig)
    window.api.listWorkSessions().then(async (list: WorkSession[]) => {
      setSessions(list)
      if (list.length) {
        setActiveSessionId(list[0].id)
      }
      // Auto-restore: reopen every dead terminal in parallel
      const reopens = list.flatMap((s) =>
        s.terminals
          .filter((t) => t.lastState === "dead")
          .map((t) => window.api.reopenTerminal(s.id, t.id))
      )
      await Promise.all(reopens)
      // Re-read sessions after restore — terminal IDs change during reopen
      const updated = await window.api.listWorkSessions()
      setSessions(updated)
      if (updated.length) {
        setActiveSessionId((cur) => cur ?? updated[0].id)
        setActiveTerminalId(updated[0].terminals[0]?.id ?? null)
      }
    })
  }, [])

  // Listen for container + terminal events from the main process.
  useEffect(() => {
    window.api.onWorkSessionUpdated((updated: WorkSession) => {
      setSessions((prev) => {
        const i = prev.findIndex((s) => s.id === updated.id)
        if (i === -1) return [...prev, updated]
        const next = [...prev]
        next[i] = updated
        return next
      })
      setActiveSessionId((cur) => cur ?? updated.id)
      setActiveTerminalId(
        (cur) => cur ?? updated.terminals[updated.terminals.length - 1]?.id ?? null,
      )
      // M5: also refresh any open overview panels when the container updates.
      refreshOverviews.current?.()
    })

    window.api.onWorkSessionRemoved((id: string) => {
      setSessions((prev) => prev.filter((s) => s.id !== id))
      setActiveSessionId((cur) => (cur === id ? null : cur))
    })

    // Switch the visible terminal when the focus_session MCP tool fires.
    window.api.onSessionFocus((id) => setActiveTerminalId(id))

    // Terminal rename — update the name in session state
    window.api.onSessionRenamed((id, newName) => {
      setSessions((prev) =>
        prev.map((s) => ({
          ...s,
          terminals: s.terminals.map((t) =>
            t.id === id ? { ...t, name: newName } : t
          ),
        }))
      )
    })

    return () => {
      window.api.removeAllListeners("worksession:updated")
      window.api.removeAllListeners("worksession:removed")
      window.api.removeAllListeners("terminal:focus")
      window.api.removeAllListeners("terminal:renamed")
    }
  }, [])

  const handleNewSession = useCallback(async () => {
    try {
      const { session, terminalId } = await window.api.openWorkSession("")
      setActiveSessionId(session.id)
      setActiveTerminalId(terminalId)
    } catch (err) {
      toast("error", `Couldn't start a new session: ${errMsg(err)}`)
    }
  }, [])

  const handleNewTerminal = useCallback(async () => {
    try {
      if (activeSessionId) {
        const result = await window.api.addTerminal(activeSessionId, "")
        if (result) setActiveTerminalId(result.terminalId)
      } else {
        const { session, terminalId } = await window.api.openWorkSession("")
        setActiveSessionId(session.id)
        setActiveTerminalId(terminalId)
      }
    } catch (err) {
      toast("error", `Couldn't add a terminal: ${errMsg(err)}`)
    }
  }, [activeSessionId])

  const handleCloseTerminal = useCallback(async () => {
    if (activeSessionId && activeTerminalId) {
      try {
        await window.api.closeTerminal(activeSessionId, activeTerminalId)
      } catch (err) {
        toast("error", `Couldn't close the terminal: ${errMsg(err)}`)
      }
    }
  }, [activeSessionId, activeTerminalId])

  const handleHandoff = useCallback(async () => {
    if (!activeSessionId || !activeTerminalId) return
    try {
      const r = await window.api.handoffTerminal(activeSessionId, activeTerminalId)
      if (r?.terminalId) setActiveTerminalId(r.terminalId)
    } catch (err) {
      toast("error", `Couldn't hand off the terminal: ${errMsg(err)}`)
    }
  }, [activeSessionId, activeTerminalId])

  // Kill a SPECIFIC session by id (the sidebar row ✕). Shares the exact confirm +
  // killWorkSession semantics with Ctrl+K so the two entry points stay in lockstep.
  const handleKillSessionById = useCallback(async (id: string) => {
    if (!id) return
    if (window.confirm("Kill this session and all its terminals? This deletes its record.")) {
      try {
        await window.api.killWorkSession(id)
      } catch (err) {
        toast("error", `Couldn't kill the session: ${errMsg(err)}`)
      }
    }
  }, [])

  // Ctrl+K / the sidebar "Kill session" action — kills the ACTIVE session via the
  // shared by-id path above.
  const handleKillSession = useCallback(async () => {
    if (!activeSessionId) return
    await handleKillSessionById(activeSessionId)
  }, [activeSessionId, handleKillSessionById])

  const handleRenameTerminal = useCallback(async (id: string, newName: string) => {
    try {
      await window.api.renameSession(id, newName)
    } catch (err) {
      toast("error", `Couldn't rename the terminal: ${errMsg(err)}`)
    }
  }, [])

  const handleSelectSession = useCallback(
    (id: string) => {
      setActiveSessionId(id)
      const s = sessions.find((x) => x.id === id)
      setActiveTerminalId(s?.terminals[0]?.id ?? null)
    },
    [sessions],
  )

  return {
    sessions,
    activeSessionId,
    activeTerminalId,
    setActiveTerminalId,
    config,
    activeSession,
    activeTerminals,
    activeTerminal,
    handleNewSession,
    handleNewTerminal,
    handleCloseTerminal,
    handleHandoff,
    handleKillSession,
    handleKillSessionById,
    handleRenameTerminal,
    handleSelectSession,
  }
}
