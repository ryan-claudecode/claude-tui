import { useState, useEffect, useCallback, type MutableRefObject } from "react"
import { toast } from "../lib/toast"
import { commitRenameValue } from "../lib/renameValue"
import { countResuming, resumingNotice, restoreSeeds, type ResumingSeed } from "../lib/resumingList"

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
  // CAPP-80 — the transient "RESUMING" section. `resumingSeeds` are the immutable
  // restore seeds (one per startup-restored terminal: stable `${sessionId}::${id}`
  // token + the pre-reopen display name, captured BEFORE reopen mints new live ids).
  // `resumingTracked` is the shrinking set of tokens still surfaced — a token is
  // dropped only by USER action (focus / dismiss / stop / select its session). When
  // the set empties, the section hides — self-closing. `resumingLiveIds` maps each
  // token to its fresh live terminal id as that reopen resolves, so rows resolve by
  // STABLE id (never array position — a sibling close/handoff must not re-target other
  // rows). All three stay empty for a no-restore boot.
  const [resumingSeeds, setResumingSeeds] = useState<ResumingSeed[]>([])
  const [resumingTracked, setResumingTracked] = useState<Set<string>>(() => new Set())
  const [resumingLiveIds, setResumingLiveIds] = useState<Map<string, string>>(() => new Map())

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
      // CAPP-80 — surface the APP-MANAGED terminals being restored (dead refs across
      // the loaded sessions; NEVER the external claude.exe farm). The toast counts ALL
      // of them for global awareness across workspaces; the RESUMING section itself is
      // workspace-scoped (App.tsx), so its visible count may be smaller — intentional.
      const notice = resumingNotice(countResuming(list))
      if (notice) toast("info", notice)
      // Seed the section from the pre-reopen refs (reopen mints fresh ids). Exclude the
      // foreground (auto-selected first) session — the user is already looking at it,
      // so it counts as seen and shouldn't list itself as "resuming".
      const seeds = restoreSeeds(list)
      setResumingSeeds(seeds)
      const firstId = list[0]?.id
      setResumingTracked(
        new Set(seeds.filter((s) => s.sessionId !== firstId).map((s) => s.token)),
      )
      // Auto-restore: reopen every dead terminal in parallel, recording each fresh
      // live id against its restore-token as it resolves so rows resolve by STABLE id.
      await Promise.all(
        seeds.map(async (seed) => {
          try {
            const res = await window.api.reopenTerminal(seed.sessionId, seed.originalId)
            if (res?.terminalId) {
              setResumingLiveIds((prev) => {
                const next = new Map(prev)
                next.set(seed.token, res.terminalId)
                return next
              })
            }
          } catch {
            // A failed reopen leaves the row in "resuming" (honest); user can dismiss.
          }
        }),
      )
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

  // CAPP-75 — restore a past Claude Code conversation (by id) for a folder: spawns
  // `claude --resume <id>` in the folder as a new work session and points the active
  // selection at it. Returns the result (or null on failure) so the picker can close
  // only on success. Shares handleNewSession's set-active semantics.
  const handleRestoreConversation = useCallback(
    async (
      folder: string,
      conversationId: string,
    ): Promise<{ session: { id: string }; terminalId: string } | null> => {
      try {
        const result = await window.api.restoreConversation(folder, conversationId)
        if (!result) {
          toast("error", "Couldn't restore that conversation.")
          return null
        }
        setActiveSessionId(result.session.id)
        setActiveTerminalId(result.terminalId)
        return result
      } catch (err) {
        toast("error", `Couldn't restore the conversation: ${errMsg(err)}`)
        return null
      }
    },
    [],
  )

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

  // Rename a TERMINAL (the tab). Optimistically reflect the new name locally so the
  // tab doesn't flash the old name before the terminal:renamed event lands; the
  // authoritative update still arrives via onSessionRenamed. CAPP-81: check the
  // returned boolean — a headless terminal used to silently no-op — and toast (and
  // roll back the optimistic name) on a false/throw so the failure isn't lost.
  const handleRenameTerminal = useCallback(async (id: string, newName: string) => {
    let prev: string | undefined
    setSessions((cur) =>
      cur.map((s) => ({
        ...s,
        terminals: s.terminals.map((t) => {
          if (t.id !== id) return t
          prev = t.name
          return { ...t, name: newName }
        }),
      })),
    )
    const rollback = () => {
      if (prev === undefined) return
      const old = prev
      setSessions((cur) =>
        cur.map((s) => ({
          ...s,
          terminals: s.terminals.map((t) => (t.id === id ? { ...t, name: old } : t)),
        })),
      )
    }
    try {
      const ok = await window.api.renameSession(id, newName)
      if (!ok) {
        toast("error", "Couldn't rename the terminal: it may have already closed.")
        rollback()
      }
    } catch (err) {
      toast("error", `Couldn't rename the terminal: ${errMsg(err)}`)
      rollback()
    }
  }, [])

  // CAPP-82 — rename a WORK SESSION (the sidebar container row). Mirrors
  // handleRenameTerminal: optimistic local name + rollback + toast on failure, but
  // calls the NEW renameWorkSession accessor (-> worksession:rename), NOT the
  // terminal-tier renameSession. The authoritative update arrives via the
  // worksession:updated snapshot.
  const handleRenameSession = useCallback(async (id: string, newName: string) => {
    let prev: string | undefined
    setSessions((cur) =>
      cur.map((s) => {
        if (s.id !== id) return s
        prev = s.name
        return { ...s, name: newName }
      }),
    )
    const rollback = () => {
      if (prev === undefined) return
      const old = prev
      setSessions((cur) => cur.map((s) => (s.id === id ? { ...s, name: old } : s)))
    }
    try {
      const ok = await window.api.renameWorkSession(id, newName)
      if (!ok) {
        toast("error", "Couldn't rename the session.")
        rollback()
      }
    } catch (err) {
      toast("error", `Couldn't rename the session: ${errMsg(err)}`)
      rollback()
    }
  }, [])

  // CAPP-80 — drop one RESUMING token from the tracked set (focused/dismissed/seen).
  // The derived rows shrink accordingly; the section hides when the set empties.
  const clearResuming = useCallback((token: string) => {
    setResumingTracked((prev) => {
      if (!prev.has(token)) return prev
      const next = new Set(prev)
      next.delete(token)
      return next
    })
  }, [])

  // CAPP-80 — drop every RESUMING token belonging to a session (focusing the session
  // counts as "seen" for all its restored terminals).
  const clearResumingForSession = useCallback((sessionId: string) => {
    setResumingTracked((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const token of prev) {
        if (token.startsWith(`${sessionId}::`)) {
          next.delete(token)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  const handleSelectSession = useCallback(
    (id: string) => {
      setActiveSessionId(id)
      const s = sessions.find((x) => x.id === id)
      setActiveTerminalId(s?.terminals[0]?.id ?? null)
      // CAPP-80 — focusing a session clears its RESUMING rows (the user has noticed).
      clearResumingForSession(id)
    },
    [sessions, clearResumingForSession],
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
    handleRestoreConversation,
    handleNewTerminal,
    handleCloseTerminal,
    handleHandoff,
    handleKillSession,
    handleKillSessionById,
    handleRenameTerminal,
    handleRenameSession,
    handleSelectSession,
    // CAPP-80 — the transient RESUMING section: tracked tokens + restore seeds +
    // live-id map (consumed by App.tsx's deriveResumingRows) and the clear callback.
    resumingTracked,
    resumingSeeds,
    resumingLiveIds,
    clearResuming,
  }
}
