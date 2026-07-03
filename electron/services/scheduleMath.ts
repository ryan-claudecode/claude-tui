/**
 * SCHED-1 (CAPP-114) — pure scheduling math for the on-device scheduler.
 *
 * Zero Electron imports (the `src/lib/sessionRow.ts` / `companionPlacement.ts`
 * pattern) so it runs in vitest's node env with no mocks and can be imported from
 * any layer. ALL times are LOCAL: the user thinks in local wall-clock, so window /
 * days / daily-at boundaries use the machine's local timezone (Date's local getters
 * + `setHours`), and DST transitions resolve to the next VALID local instant
 * (`setHours` normalizes a skipped spring-forward time forward automatically).
 *
 * `computeNextRun` is the single source of truth for "when does this fire next";
 * `isDue` / `describeNext` live beside it so the sidebar countdown can never drift
 * from the ticker.
 */

/** How a schedule recurs. See scheduler.ts §Data model. */
export type Recurrence =
  | {
      kind: "interval"
      /** Fire every N minutes, anchored to the last fire (not wall-clock minute 0). */
      everyMinutes: number
      /** Optional local time-of-day window, inclusive. A fire landing outside it
       *  rolls to the next window start. "HH:mm".."HH:mm". A start AFTER the end
       *  (e.g. 22:00–06:00) is a WRAP-AROUND, midnight-straddling window. */
      window?: { start: string; end: string }
      /** Optional allowed weekdays (0=Sun..6=Sat). Absent/empty = every day. */
      days?: number[]
    }
  | { kind: "daily"; at: string; days?: number[] }
  | { kind: "once"; at: string }

/** The minimal schedule shape the row helpers read (a subset of Schedule). */
export interface SchedulableView {
  enabled: boolean
  /** ISO string of the next fire, or null when exhausted (a spent one-shot). */
  nextRunAt: string | null
}

const DAY_MIN = 1440

/** Parse "HH:mm" to minutes-of-day (0..1439), or null when malformed / out of range. */
function parseHM(hm: string): number | null {
  if (typeof hm !== "string") return null
  const m = hm.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

/** Local minutes-of-day for a Date (seconds ignored). */
function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes()
}

/**
 * A NEW Date at the same local calendar day as `ref` but at `minutes` minutes-of-day
 * (seconds/ms zeroed). `setHours` uses LOCAL time and normalizes a nonexistent
 * spring-forward wall-clock time forward to the next valid instant — the DST rule.
 */
function atMinutesOfDay(ref: Date, minutes: number): Date {
  const d = new Date(ref.getTime())
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  return d
}

/** A NEW Date `n` local calendar days after `ref` (time-of-day carried, then usually re-pinned). */
function addDays(ref: Date, n: number): Date {
  const d = new Date(ref.getTime())
  d.setDate(d.getDate() + n)
  return d
}

/** Whether `d`'s local weekday is allowed. Absent/empty `days` = every day. */
function daysAllows(d: Date, days?: number[]): boolean {
  if (!days || days.length === 0) return true
  return days.includes(d.getDay())
}

/** The earliest local time STRICTLY after `after` that is at `startMin` on an allowed day. */
function nextWindowStart(after: Date, startMin: number, days?: number[]): Date {
  let d = atMinutesOfDay(after, startMin)
  if (d.getTime() <= after.getTime()) d = atMinutesOfDay(addDays(after, 1), startMin)
  let guard = 0
  while (!daysAllows(d, days) && guard++ < DAY_MIN) d = atMinutesOfDay(addDays(d, 1), startMin)
  return d
}

/** The next occurrence of local time `min` STRICTLY after `from`, on an allowed day. */
function nextDailyTime(from: Date, min: number, days?: number[]): Date {
  let d = atMinutesOfDay(from, min)
  if (d.getTime() <= from.getTime()) d = atMinutesOfDay(addDays(from, 1), min)
  let guard = 0
  while (!daysAllows(d, days) && guard++ < DAY_MIN) d = atMinutesOfDay(addDays(d, 1), min)
  return d
}

/**
 * The next fire time strictly after `from`, or null when there is none (a `once` in
 * the past, or an unparseable recurrence). Interval stepping is anchored to `from`
 * (the last fire), then clipped to the window + days: a candidate outside the window
 * rolls to the next window start; a candidate on a disallowed day rolls to the next
 * allowed day's window start.
 */
export function computeNextRun(recurrence: Recurrence, from: Date): Date | null {
  if (!recurrence || Number.isNaN(from.getTime())) return null

  if (recurrence.kind === "once") {
    const at = new Date(recurrence.at)
    if (Number.isNaN(at.getTime())) return null
    return at.getTime() > from.getTime() ? at : null
  }

  if (recurrence.kind === "daily") {
    const min = parseHM(recurrence.at)
    if (min == null) return null
    return nextDailyTime(from, min, recurrence.days)
  }

  // interval
  const every = Math.floor(recurrence.everyMinutes)
  if (!Number.isFinite(every) || every < 1) return null
  const win = recurrence.window
  const startMin = win ? parseHM(win.start) : 0
  const endMin = win ? parseHM(win.end) : DAY_MIN
  if (startMin == null || endMin == null) return null

  // Window membership. `start <= end` is the plain same-day window (inclusive both
  // ends); `start > end` is a WRAP-AROUND, midnight-straddling window like
  // 22:00–06:00 (the overnight-watch case) — in-window when the time-of-day is at/
  // after the start OR at/before the end. Only unparseable HH:mm is rejected. The
  // `days` filter applies to the local day the candidate LANDS on (a 00:20 fire in
  // a 22:00–06:00 window belongs to the NEW day), and the window still opens daily
  // at `start`, so the roll-to-next-window-start logic below is unchanged.
  const inWindow = (tod: number): boolean =>
    startMin <= endMin ? tod >= startMin && tod <= endMin : tod >= startMin || tod <= endMin

  let cand = new Date(from.getTime() + every * 60_000)
  // Bounded: each roll advances at least to the next window start, so a couple of
  // years of days is a generous ceiling that also guards a pathological days filter.
  for (let i = 0; i < 1500; i++) {
    if (daysAllows(cand, recurrence.days) && inWindow(minutesOfDay(cand))) return cand
    cand = nextWindowStart(cand, startMin, recurrence.days)
  }
  return null
}

/** Is the schedule enabled AND due to fire at `now`? */
export function isDue(schedule: SchedulableView, now: Date): boolean {
  if (!schedule.enabled || !schedule.nextRunAt) return false
  const next = new Date(schedule.nextRunAt)
  if (Number.isNaN(next.getTime())) return false
  return next.getTime() <= now.getTime()
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function fmtHM(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** Whole local-calendar-day difference `from`→`to` (midnight-anchored, so it counts
 *  day boundaries crossed rather than 24h chunks — robust across DST + partial days). */
function localDayDiff(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime()
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime()
  return Math.round((b - a) / (DAY_MIN * 60_000))
}

/**
 * A short human countdown for the sidebar row / detail panel: "paused" (disabled),
 * "done" (exhausted one-shot), "due now", "<1m", "in 14m", "at 14:30" (later today),
 * "tomorrow 08:00", "Mon 09:30" (2–6 days out — an unambiguous weekday), or "in 10d"
 * (a week or more out). Local time.
 */
export function describeNext(schedule: SchedulableView, now: Date): string {
  if (!schedule.enabled) return "paused"
  if (!schedule.nextRunAt) return "done"
  const next = new Date(schedule.nextRunAt)
  if (Number.isNaN(next.getTime())) return "—"
  const diff = next.getTime() - now.getTime()
  if (diff <= 0) return "due now"
  const mins = Math.round(diff / 60_000)
  // A 1–29s-away fire rounds to 0 — never render "in 0m".
  if (mins < 1) return "<1m"
  if (mins < 60) return `in ${mins}m`
  if (isSameLocalDay(next, now)) return `at ${fmtHM(next)}`
  if (isSameLocalDay(next, addDays(now, 1))) return `tomorrow ${fmtHM(next)}`
  // 2–6 calendar days out: name the weekday + time ("Mon 09:30"). Capped at 6 so a
  // bare weekday name can't collide with the SAME weekday a week later (ambiguous).
  const days = localDayDiff(now, next)
  if (days >= 2 && days <= 6) return `${DAY_NAMES[next.getDay()]} ${fmtHM(next)}`
  return `in ${days}d`
}
