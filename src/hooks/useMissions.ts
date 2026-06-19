import { useState, useEffect, useCallback } from "react"
import { toast } from "../lib/toast"
import { isMissionActive, isMissionDismissable } from "../lib/missionRow"

/** Renderer-facing shape for a mission. Tasks and workers are included because
 *  the dashboard panel needs them, and they ride along in every `mission:updated`
 *  snapshot (the service already serializes the full Mission to JSON for disk). */
export interface MissionSummary {
  id: string
  goal: string
  status: string
  autonomy?: string
  conductorSessionId?: string
  tasks?: Array<{ id: string; status: string }>
  workers?: Array<{ sessionId: string; role?: string }>
  createdAt: number
  updatedAt: number
}

// Normalize an unknown thrown value into a human-readable message for toasts.
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The renderer half of the missions surface (P1-4 hook pattern). Seeds with one
 * `listMissions()` call on mount, then maintains state from `mission:updated`
 * (full snapshot per mutation) and `mission:removed` (if the main process ever
 * emits one). Renderer-side dismissed-ids track terminal-state rows dismissed by
 * the user; they are lost on reload — acceptable per spec.
 *
 * `visible` is the filtered list the sidebar section renders: active missions
 * always show; terminal-state missions show until dismissed.
 */
export function useMissions() {
  const [missions, setMissions] = useState<MissionSummary[]>([])
  // Renderer-side: Set of ids for dismissed terminal-state missions.
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())

  // visible = active always + terminal-state until dismissed.
  const visible = missions.filter((m) => {
    if (isMissionActive(m.status as any)) return true
    if (isMissionDismissable(m.status as any)) return !dismissed.has(m.id)
    return false
  })

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => new Set([...prev, id]))
  }, [])

  useEffect(() => {
    // Seed on mount (P0-5: wrap in try/catch + toast on failure).
    Promise.resolve(window.api.listMissions())
      .then((list) => setMissions(list as MissionSummary[]))
      .catch((err) => toast("error", `Couldn't load missions: ${errMsg(err)}`))

    // Push: full snapshot on every mutation. Upsert by id.
    window.api.onMissionUpdated((m: MissionSummary) => {
      setMissions((prev) => {
        const idx = prev.findIndex((x) => x.id === m.id)
        if (idx === -1) return [...prev, m]
        const next = [...prev]
        next[idx] = m
        return next
      })
      // When a mission transitions back to running (resumed) un-dismiss it so
      // it re-appears as an active row.
      if (isMissionActive(m.status as any)) {
        setDismissed((prev) => {
          if (!prev.has(m.id)) return prev
          const next = new Set(prev)
          next.delete(m.id)
          return next
        })
      }
    })

    // mission:removed is emitted defensively (missions are not currently deleted,
    // but the seam reserves it). Handle gracefully.
    window.api.onMissionRemoved?.((id: string) => {
      setMissions((prev) => prev.filter((m) => m.id !== id))
      setDismissed((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    })

    return () => {
      window.api.removeAllListeners("mission:updated")
      window.api.removeAllListeners("mission:removed")
    }
  }, [])

  return { missions, visible, dismissed, dismiss }
}
