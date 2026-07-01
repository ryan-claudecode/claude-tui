import { useState, useEffect, useCallback } from "react"
import { toast } from "../lib/toast"
import type { Recurrence } from "../../electron/services/scheduleMath"

/** Renderer-facing shape for a schedule. Mirrors the durable Schedule (which lives
 *  in electron/services/scheduler.ts and imports node:fs, so it can't be imported
 *  here) — the full snapshot rides along in every `schedule:updated` push. */
export interface ScheduleSummary {
  id: string
  name: string
  prompt: string
  recurrence: Recurrence
  enabled: boolean
  workspaceId?: string
  cwd?: string
  model?: string
  effort?: string
  ultracode?: boolean
  maxRuntimeMs?: number
  catchUp?: boolean
  keepTerminal?: boolean
  nextRunAt: string | null
  runHistory?: Array<{ at: string; status: string; durationMs?: number; sessionId?: string; terminalId?: string; note?: string }>
  createdAt: string
}

/** The fields the create/edit overlay hands back (workspaceId is added by App.tsx). */
export interface ScheduleFormInput {
  name: string
  prompt: string
  recurrence: Recurrence
  model?: string
  catchUp?: boolean
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The renderer half of the SCHEDULED surface (CAPP-114 / SCHED-1). Seeds with one
 * `listSchedules()` on mount, then maintains state from `schedule:updated` (full
 * snapshot per mutation) and `schedule:removed` — no polling.
 */
export function useSchedules() {
  const [schedules, setSchedules] = useState<ScheduleSummary[]>([])

  useEffect(() => {
    Promise.resolve(window.api.listSchedules())
      .then((list) => setSchedules(list as ScheduleSummary[]))
      .catch((err) => toast("error", `Couldn't load schedules: ${errMsg(err)}`))

    window.api.onScheduleUpdated((s: ScheduleSummary) => {
      setSchedules((prev) => {
        const idx = prev.findIndex((x) => x.id === s.id)
        if (idx === -1) return [...prev, s]
        const next = [...prev]
        next[idx] = s
        return next
      })
    })

    window.api.onScheduleRemoved?.((id: string) => {
      setSchedules((prev) => prev.filter((s) => s.id !== id))
    })

    return () => {
      window.api.removeAllListeners("schedule:updated")
      window.api.removeAllListeners("schedule:removed")
    }
  }, [])

  const create = useCallback((input: ScheduleFormInput & { workspaceId?: string }) => {
    Promise.resolve(window.api.createSchedule(input)).catch((err) =>
      toast("error", `Couldn't create the schedule: ${errMsg(err)}`),
    )
  }, [])

  const update = useCallback((id: string, patch: Partial<ScheduleFormInput> & { enabled?: boolean }) => {
    Promise.resolve(window.api.updateSchedule(id, patch)).catch((err) =>
      toast("error", `Couldn't update the schedule: ${errMsg(err)}`),
    )
  }, [])

  const toggle = useCallback((id: string, enabled: boolean) => {
    Promise.resolve(window.api.updateSchedule(id, { enabled })).catch((err) =>
      toast("error", `Couldn't ${enabled ? "enable" : "pause"} the schedule: ${errMsg(err)}`),
    )
  }, [])

  const runNow = useCallback((id: string) => {
    Promise.resolve(window.api.runScheduleNow(id))
      .then((ok) => {
        if (!ok) toast("info", "A run is already in flight for this schedule.")
      })
      .catch((err) => toast("error", `Couldn't run the schedule: ${errMsg(err)}`))
  }, [])

  const remove = useCallback((id: string) => {
    Promise.resolve(window.api.deleteSchedule(id)).catch((err) =>
      toast("error", `Couldn't delete the schedule: ${errMsg(err)}`),
    )
  }, [])

  return { schedules, create, update, toggle, runNow, remove }
}
