/**
 * CAPP-129 — pure cost-rollup helpers for the sidebar's DURABLE cost surfaces. Zero
 * React / DOM imports (mirrors sessionRow.ts / workspaceFilter.ts) so they're unit-
 * testable in vitest's node env.
 *
 *   • {@link formatCompactMoney} — the compact "$X" the sidebar session row + workspace
 *     header render (denser than the rail's 4dp per-turn figure: this is a glance total).
 *   • {@link sumSessionsCost} — Σ the per-session durable totals for a WORKSPACE rollup.
 *
 * The per-session/per-terminal accumulation itself lives in the MAIN process
 * (SessionService, CAPP-129) — this module only reads the persisted totals for display.
 */

/** The minimal per-session shape the rollup reads (the renderer's WorkSession is a superset). */
export interface SessionCost {
  costUsd?: number
}

/**
 * Format a USD total compactly for an at-a-glance sidebar label: 2dp under $10, 1dp
 * under $100, else whole dollars. e.g. 1.237 → "$1.24", 42.31 → "$42.3", 142.6 → "$143".
 * Clamps negatives to 0 (a durable total can only grow; this is defensive). Pure.
 */
export function formatCompactMoney(usd: number): string {
  const v = usd > 0 ? usd : 0
  if (v < 10) return `$${v.toFixed(2)}`
  if (v < 100) return `$${v.toFixed(1)}`
  return `$${Math.round(v)}`
}

/**
 * CAPP-129 — Σ the durable per-session cost totals across a list of sessions, for the
 * workspace-header rollup. Pass the sessions ALREADY SCOPED to the active workspace
 * (App.tsx's `scopedSessions` == filterByWorkspace(sessions, activeWorkspaceId)): that
 * mirrors the sidebar's own filter semantics exactly — a SPECIFIC workspace sums only its
 * tagged sessions, and "All" mode sums EVERYTHING (tagged + untagged), because untagged
 * sessions belong to the "All" bucket only. Tolerant: a session with no `costUsd`
 * contributes 0; the result is a plain number (0 when nothing has cost yet).
 */
export function sumSessionsCost(sessions: readonly SessionCost[]): number {
  let total = 0
  for (const s of sessions) {
    if (s.costUsd != null && s.costUsd > 0) total += s.costUsd
  }
  return total
}
