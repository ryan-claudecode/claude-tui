import { useState, useEffect, useCallback, useRef, type MutableRefObject } from "react"
import type { Autonomy } from "../components/MissionPrompt"
import type { WorkSession } from "./useSessions"

// PanelState — panels now render in the companion window, but the main window
// still tracks panel state for the M5 overview-refresh.
export interface PanelState {
  id: string
  type: string
  position: "right" | "bottom"
  width?: number
  height?: number
  props: Record<string, any>
  visible: boolean
}

// Owns the main window's companion-panel bookkeeping: the locally-mirrored panel
// list, the panel:* IPC listeners, the M5 Session Overview live-refresh, and the
// show-panel helpers (mission / overview / create mission). Mission list state has
// moved to useMissions (MS-2 — push, not poll). The live missions list is passed
// in so open mission panels stay fresh reactively without a second listener on
// mission:updated (which useMissions already owns).
//
// This is panel-meta tracking — explicitly allowed to live outside the
// terminal/session core — pulled out of App.tsx so the root stays a composition
// shell. Owns the cleanup for exactly the listeners it registers: panel:show,
// panel:update, panel:hide, panel:hide-all, terminal:state.
//
// `refreshOverviewsRef` is shared with useSessions: the overview-refresh callback
// is stored in it so worksession:updated (owned by useSessions) can trigger a
// refresh without registering a second listener on that channel.
//
// PP: `recentlyChanged` is a short-lived flag (set on show/update, cleared after
// ~1.2s) that drives the presence-indicator pulse in the TabBar.
export function usePanels(
  refreshOverviewsRef: MutableRefObject<(() => void) | null>,
  activeSession: WorkSession | null,
  _missionsListOpen: boolean,
  liveMissions?: Array<{ id: string; [key: string]: any }>,
  liveSchedules?: Array<{ id: string; [key: string]: any }>,
) {
  const [panels, setPanels] = useState<PanelState[]>([])
  const [recentlyChanged, setRecentlyChanged] = useState(false)
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Briefly set the recentlyChanged flag to drive a pulse on the presence indicator.
  const triggerPulse = useCallback(() => {
    setRecentlyChanged(true)
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current)
    pulseTimerRef.current = setTimeout(() => {
      setRecentlyChanged(false)
      pulseTimerRef.current = null
    }, 1200)
  }, [])

  // Panel events from the main process (triggered by MCP tools).
  useEffect(() => {
    window.api.onPanelShow((panel) => {
      setPanels((prev) => [...prev.filter((p) => p.id !== panel.id), panel])
      triggerPulse()
    })

    window.api.onPanelUpdate(({ id, props }) => {
      setPanels((prev) => prev.map((p) => (p.id === id ? { ...p, props } : p)))
      triggerPulse()
    })

    window.api.onPanelHide((id) => {
      setPanels((prev) => prev.filter((p) => p.id !== id))
    })

    window.api.onPanelHideAll(() => {
      setPanels([])
    })

    return () => {
      window.api.removeAllListeners("panel:show")
      window.api.removeAllListeners("panel:update")
      window.api.removeAllListeners("panel:hide")
      window.api.removeAllListeners("panel:hide-all")
      if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current)
    }
  }, [triggerPulse])

  // MS-2: keep open mission dashboard panels fresh from the live missions list.
  // useMissions owns the mission:updated listener; we react to the derived state
  // (liveMissions) rather than registering a second listener on the same channel.
  //
  // PP fix: match by props identity (`props.id === mission.id`) rather than
  // panel-id string `mission-${x.id}` — panels use auto-generated `panel-N` ids,
  // so the old string match never fired. A mission panel's props IS the mission
  // object, so props.id is the stable identifier.
  useEffect(() => {
    if (!liveMissions || liveMissions.length === 0) return
    setPanels((prev) =>
      prev.map((p) => {
        if (p.type !== "mission") return p
        const m = liveMissions.find((x) => x.id === (p.props as { id?: string })?.id)
        return m ? { ...p, props: m } : p
      }),
    )
  }, [liveMissions])

  // CAPP-115 (SCHED-2): keep an open `schedule` detail panel fresh from the live
  // schedules list. useSchedules owns the `schedule:updated` listener; we react to the
  // derived state here (same pattern as the mission live-refresh above), matching on
  // props.id (the schedule id) because panels carry auto-generated panel-N ids.
  useEffect(() => {
    if (!liveSchedules || liveSchedules.length === 0) return
    setPanels((prev) =>
      prev.map((p) => {
        if (p.type !== "schedule") return p
        const s = liveSchedules.find((x) => x.id === (p.props as { id?: string })?.id)
        return s ? { ...p, props: s } : p
      }),
    )
  }, [liveSchedules])

  // M5: keep any open Session Overview panel live. When a terminal's state or the
  // container changes, re-fetch the overview for each open overview panel and
  // replace its props. Debounced so a burst of events coalesces into one refresh.
  //
  // PP fix: match by props identity (`props.id` = the session id, from the overview
  // result) rather than an `overview-<id>` panel-id prefix — panels use
  // auto-generated `panel-N` ids, so the old prefix match never fired. The panel
  // id is used only within setPanels to identify which entry to replace.
  //
  // Implementation note on the footgun: useSessions owns onWorkSessionUpdated
  // (registers + removeAllListeners on unmount). Adding a second
  // onWorkSessionUpdated listener in a [panels]-dep effect would accumulate
  // listeners on every panels change and fight with that hook's cleanup. Instead,
  // we store the refresh callback in a ref so useSessions can call it, and we
  // subscribe to terminal:state via the per-instance disposer (onTerminalState).
  // BO-10: terminal:state is now SHARED with useAgentBusy, so this MUST use the
  // disposer (not removeAllListeners, which fired on every panels change and would
  // clobber the other subscriber).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null

    const refreshOpenOverviews = () => {
      if (timer) return // coalesce: a refresh is already scheduled
      timer = setTimeout(async () => {
        timer = null
        // PP fix: find open overview panels by type + props.id (session id),
        // independent of the auto-generated panel-N id scheme.
        const openOverviewPanels = panels.filter(
          (p) => p.visible && p.type === "session-overview",
        )
        for (const panel of openOverviewPanels) {
          const sessionId = (panel.props as { id?: string })?.id
          if (!sessionId) continue
          const ov = await window.api.getSessionOverview(sessionId)
          if (!ov) continue // session gone mid-refresh: leave last content
          setPanels((prev) =>
            prev.map((p) =>
              p.id === panel.id
                ? {
                    ...p,
                    props: {
                      ...ov,
                      onReopenTerminal: (terminalId: string) =>
                        window.api.reopenTerminal(sessionId, terminalId),
                    },
                  }
                : p,
            ),
          )
        }
      }, 250)
    }

    // Expose to useSessions so worksession:updated also triggers a refresh.
    refreshOverviewsRef.current = refreshOpenOverviews

    // BO-10 — terminal:state is now SHARED with useAgentBusy (the composer Stop/
    // Send gating), so this uses the per-instance disposer instead of the old
    // removeAllListeners (which fired on every `panels` change and would clobber
    // the other subscriber). Each hook tears down only its own handler.
    const offState = window.api.onTerminalState(refreshOpenOverviews)

    return () => {
      if (timer) clearTimeout(timer)
      refreshOverviewsRef.current = null
      offState?.()
    }
  }, [panels, refreshOverviewsRef])

  // Open (or refresh) a mission's dashboard panel.
  const openMission = useCallback(async (m: { id: string }) => {
    await window.api.showPanel("mission", m, "right")
  }, [])

  // CAPP-115 (SCHED-2): open (or refresh) a schedule's detail panel. The full
  // ScheduleSummary snapshot rides as the panel props; the live-refresh effect above
  // keeps it current off `schedule:updated`.
  const openSchedule = useCallback(async (s: { id: string; [key: string]: any }) => {
    await window.api.showPanel("schedule", s, "right")
  }, [])

  const openOverview = useCallback(async (sessionId: string) => {
    const ov = await window.api.getSessionOverview(sessionId)
    if (!ov) return
    // Show in companion window via IPC
    const panel = await window.api.showPanel("session-overview", {
      ...ov,
    }, "right")
    // Track locally for M5 live-refresh
    setPanels((prev) => [...prev.filter((p) => p.id !== panel.id), { ...panel, id: panel.id }])
  }, [])

  // Open the session's durable timeline as a companion `timeline` panel
  // (snapshot — reopen to refresh). Maps each SessionEvent to a timeline Step.
  const openTimeline = useCallback(async (sessionId: string, sessionName?: string) => {
    const events: Array<{ time: number; kind: string; text: string }> =
      (await window.api.getSessionTimeline(sessionId)) ?? []
    const steps = events.map((e) => ({
      label: e.text,
      status: e.kind === "correction" ? "error" : (e.kind === "spawn" || e.kind === "handoff" ? "active" : "done"),
      meta: new Date(e.time).toLocaleString(),
    }))
    await window.api.showPanel("timeline", { title: `Timeline — ${sessionName ?? sessionId}`, steps }, "right")
  }, [])

  // Create a mission from the prompt overlay, then open its dashboard panel.
  const createMission = useCallback(
    async (goal: string, autonomy: Autonomy) => {
      const cwd = activeSession?.terminals[0]?.cwd ?? ""
      const m = await window.api.createMission(goal, cwd, autonomy)
      openMission(m)
    },
    [activeSession, openMission],
  )

  return {
    panels,
    recentlyChanged,
    setPanels,
    openMission,
    openSchedule,
    openOverview,
    openTimeline,
    createMission,
  }
}
