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
 * (full snapshot per mutation) and `mission:removed` (the durable-delete event,
 * emitted by MissionService.deleteMission).
 *
 * `dismiss` is now DURABLE: it calls `deleteMission`, which unlinks the mission's
 * persisted JSON and drops it from the main-process map, so the row CANNOT
 * reappear on relaunch (and the Supervisor can't resurrect it). The local
 * `dismissed` Set is kept only as an OPTIMISTIC hide so the row vanishes the
 * instant the user clicks ✕, before the `mission:removed` event round-trips —
 * `onMissionRemoved` then removes it from `missions` for good.
 *
 * `visible` is the filtered list the sidebar section renders: active missions
 * always show; terminal-state missions show until deleted.
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

  // Durably delete the mission (the sidebar ✕). Optimistically hide the row
  // immediately, then fire the IPC; the main process emits `mission:removed`
  // which `onMissionRemoved` (below) uses to drop it from `missions` for good.
  // deleteMission returns Promise<boolean>: it RESOLVES `false` on a service
  // refusal (mission already gone, or no longer in a deletable terminal state) and
  // REJECTS on an IPC/transport error. Both cases must roll back the optimistic
  // hide + toast, otherwise the row stays hidden with nothing persisted.
  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => new Set([...prev, id]))
    const rollback = () =>
      setDismissed((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    Promise.resolve(window.api.deleteMission(id))
      .then((ok) => {
        if (!ok) {
          toast("error", "Couldn't delete the mission: it may already be gone or still running.")
          rollback()
        }
      })
      .catch((err) => {
        toast("error", `Couldn't delete the mission: ${errMsg(err)}`)
        rollback()
      })
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

    // mission:removed is the durable-delete event (MissionService.deleteMission,
    // fired by the sidebar ✕). Drop the mission from state and clear any
    // optimistic dismissed-id for it.
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
