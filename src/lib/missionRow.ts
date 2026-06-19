/**
 * Pure view-model helpers for the MISSIONS sidebar rows. Kept separate from
 * the hook/component so they can be unit-tested in vitest's node environment
 * (no React, no DOM) — mirrors `attentionRow.ts` / `sessionRow.ts`.
 */

export type MissionStatus = "planning" | "running" | "paused" | "blocked" | "done" | "stopped"

/** The statuses that are "terminal" (no live activity). */
export const TERMINAL_STATUSES: MissionStatus[] = ["done", "blocked", "stopped"]

/** The statuses that are always shown (not dismissable). */
export const ACTIVE_STATUSES: MissionStatus[] = ["planning", "running", "paused"]

/**
 * Whether a mission should be shown in the sidebar regardless of dismissal.
 * Active missions always show; terminal-state missions linger until dismissed.
 * The caller still needs to check the dismissed-ids Set for terminal-state rows.
 */
export function isMissionActive(status: MissionStatus): boolean {
  return ACTIVE_STATUSES.includes(status)
}

/**
 * Whether a mission row can be dismissed (hover ×). Only terminal-state rows.
 */
export function isMissionDismissable(status: MissionStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

/**
 * Truncate a mission goal to a one-line excerpt for the sidebar row. Goal text
 * that is already short passes through untouched.
 */
export function goalExcerpt(goal: string, maxLen = 48): string {
  const clean = goal.replace(/\s+/g, " ").trim()
  return clean.length > maxLen ? clean.slice(0, maxLen - 1) + "…" : clean
}

/**
 * Derive the `done/total` task progress values. Safe when `tasks` is undefined
 * (e.g. a freshly-planned mission with no tasks yet).
 */
export function missionProgress(tasks?: Array<{ status: string }>): {
  done: number
  total: number
  pct: number
} {
  if (!tasks || tasks.length === 0) return { done: 0, total: 0, pct: 0 }
  const done = tasks.filter((t) => t.status === "done").length
  const total = tasks.length
  const pct = Math.round((done / total) * 100)
  return { done, total, pct }
}

/**
 * Map a mission status to the CSS chip class suffix used in the sidebar.
 * Maps to the `--attn-*` tier tokens:
 *   running   → "running"  (accent color)
 *   paused / blocked → "paused"   (--attn-2 gold)
 *   done      → "done"     (--attn-3 sage)
 *   planning  → "planning" (muted text)
 *   stopped   → "stopped"  (muted text)
 */
export function missionStatusChip(status: MissionStatus): string {
  return status // used directly as class suffix; CSS handles the mapping
}
