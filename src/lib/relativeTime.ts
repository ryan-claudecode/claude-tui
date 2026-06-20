/**
 * CAPP-75 — a compact "N ago" relative-time formatter for the restore-conversation
 * picker (each row shows when its transcript was last written). Pure + injectable
 * `now` so it's hermetically testable. Mirrors the granularity of
 * `attentionRow.formatWaitTime` (s / m / h) and extends it with days for older
 * conversations. A future or just-now timestamp reads "just now".
 */
export function relativeTime(then: number, now: number): string {
  const deltaMs = now - then
  if (deltaMs < 45_000) return "just now"
  const sec = Math.floor(deltaMs / 1000)
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  const wk = Math.floor(day / 7)
  if (wk < 5) return `${wk}w ago`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo}mo ago`
  const yr = Math.floor(day / 365)
  return `${yr}y ago`
}
