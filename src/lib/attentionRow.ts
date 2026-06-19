/**
 * Pure view-model helpers for the "NEEDS YOU" attention-queue rows. Kept separate
 * from the hook/component so the wait-time formatting can be unit-tested in
 * vitest's node environment (no React, no DOM) — mirrors `sessionRow.ts`.
 */

/**
 * Format how long an entry has been waiting, derived from its `since` epoch-ms.
 * Compact and quiet: seconds under a minute, whole minutes under an hour, then
 * hours. Negative/future timestamps clamp to "now". Used as the trailing token
 * of a row's second line, e.g. `form waiting · 6m`.
 */
export function formatWaitTime(sinceMs: number, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - sinceMs)
  const secs = Math.floor(elapsed / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h`
}
