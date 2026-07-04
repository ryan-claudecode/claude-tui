/**
 * Pure view-model helpers for the SCHEDULED sidebar rows (CAPP-114 / SCHED-1).
 * Kept separate from the hook/component so they unit-test in vitest's node env
 * (no React, no DOM) — mirrors `sessionRow.ts`. Reuses the pure
 * `scheduleMath` countdown so the row text can never drift from the ticker.
 */
import { describeNext, type Recurrence, type SchedulableView } from "../../electron/services/scheduleMath"

/** A single run outcome as it rides the schedule snapshot (subset of RunRecord). */
export interface ScheduleRunView {
  at: string
  status: string
  durationMs?: number
  note?: string
}

/** The renderer-facing schedule shape the rows read (subset of the durable Schedule). */
export interface ScheduleView extends SchedulableView {
  id: string
  name: string
  recurrence: Recurrence
  workspaceId?: string
  runHistory?: ScheduleRunView[]
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function formatMinutes(m: number): string {
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem === 0 ? `${h}h` : `${h}h${rem}m`
}

function formatDays(days: number[]): string {
  return days
    .filter((d) => d >= 0 && d <= 6)
    .map((d) => DAY_NAMES[d])
    .join(",")
}

/** A short "once, Jun 1 10:00"-style label for a one-shot's datetime. */
function formatOnce(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  return `${month} ${d.getDate()} ${hh}:${mm}`
}

/** A human summary of a recurrence for the row's first line. */
export function recurrenceSummary(r: Recurrence): string {
  if (r.kind === "interval") {
    const win = r.window ? ` · ${r.window.start}–${r.window.end}` : ""
    const days = r.days && r.days.length ? ` · ${formatDays(r.days)}` : ""
    return `every ${formatMinutes(r.everyMinutes)}${win}${days}`
  }
  if (r.kind === "daily") {
    const days = r.days && r.days.length ? ` · ${formatDays(r.days)}` : ""
    return `daily ${r.at}${days}`
  }
  return `once · ${formatOnce(r.at)}`
}

/** The next-run countdown text (delegates to the shared math). */
export function nextRunText(schedule: SchedulableView, now: Date): string {
  return describeNext(schedule, now)
}

/** The most recent run record, or undefined when a schedule has never run. */
export function lastRun(runHistory?: ScheduleRunView[]): ScheduleRunView | undefined {
  return runHistory && runHistory.length ? runHistory[0] : undefined
}

/** Map a run status to a status-dot tone for the row's second line. */
export function runStatusTone(status: string): "ok" | "error" | "skipped" {
  if (status === "ok") return "ok"
  if (status === "error" || status === "timeout" || status === "killed") return "error"
  return "skipped" // skipped-overlap / skipped-missed
}
