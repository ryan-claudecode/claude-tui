/**
 * Agent Rail (v1, Phase 1) — the PURE decision layer for the right-edge agent-state
 * column. Zero React / Electron imports (mirrors src/lib/sessionRow.ts → Sidebar,
 * src/lib/agentTranscript.ts → AgentView) so every rail decision is unit-testable in
 * the node-only test env.
 *
 * The rail itself (src/components/AgentRail.tsx) is a thin lens over EXISTING seams —
 * it owns no backend. This module holds the three decisions worth proving:
 *   1. {@link sumCost} — session-cumulative COST footer (sum the per-turn ResultCost
 *      already parsed in agentTranscript.ts across the active terminal's blocks).
 *   2. {@link deriveNow} + {@link formatElapsed} — the NOW line's action + running
 *      elapsed while busy, and a calm rest state otherwise.
 *   3. {@link effectiveRailOpen} — the open/collapsed derivation from the saved pref,
 *      the responsive width breakpoint, and an explicit collapse.
 *
 * See docs/roadmap/agent-rail-design.md (Phase 1 / §3). The WORKING / KNOWS /
 * AWAITING sections + the inline-answer composer are LATER phases — this module
 * deliberately covers only the v1 surface.
 */

import type { ResultCost, TranscriptBlock } from "./agentTranscript"

// ---------------------------------------------------------------------------
// COST — session-cumulative spend for the active terminal.
// ---------------------------------------------------------------------------

/** The summed cost surface the rail's COST footer renders. */
export interface RailCost {
  /** Total USD across all result turns that reported a cost (undefined if none did). */
  costUsd?: number
  /** Total billed tokens across all result turns (undefined if none reported). */
  totalTokens?: number
  /** How many turn-complete `result` blocks contributed (the "N turns" hint). */
  turns: number
}

/**
 * Sum the per-turn {@link ResultCost} across an active terminal's transcript blocks
 * into one session-cumulative figure for the rail's COST footer. Each turn-complete
 * `result` block carries its own cost (parsed in agentTranscript.ts); this folds them.
 *
 * Deliberate v1 limitation (design doc Q5 / risk 4): this is a RENDERER-side sum over
 * the in-memory folded blocks, so it resets on a transcript rehydrate (BO-12) and
 * misses turns scrolled out of the cache. That's accepted for a glance number — a
 * durable per-session total (a SessionService field) is a later option.
 *
 * Pure + tolerant: a block with no `result`/`cost`, or a cost with all-undefined
 * fields, simply contributes nothing. `costUsd`/`totalTokens` stay `undefined` (not
 * `0`) until at least one turn reports them, so the footer can show "—" rather than a
 * misleading "$0.0000" before any turn lands.
 */
export function sumCost(blocks: readonly TranscriptBlock[]): RailCost {
  let costUsd: number | undefined
  let totalTokens: number | undefined
  let turns = 0
  for (const b of blocks) {
    if (b.kind !== "result") continue
    turns++
    const cost: ResultCost | undefined = b.cost
    if (!cost) continue
    if (cost.costUsd != null) costUsd = (costUsd ?? 0) + cost.costUsd
    if (cost.totalTokens != null) totalTokens = (totalTokens ?? 0) + cost.totalTokens
  }
  return { costUsd, totalTokens, turns }
}

/** Format a token count compactly: 12_400 → "12.4k", 980 → "980", 2_000_000 → "2.0M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${Math.round(n)}`
}

/**
 * The human-readable COST footer string, e.g. "$0.0234 · 12.4k tok · 3 turns".
 * Returns `null` when there is NO turn data yet (so the footer hides / shows its
 * resting copy rather than a misleading zero). USD is shown to 4dp (matching the
 * inline per-turn CostChips so the two read as the same currency, just per-session vs
 * per-turn). Tokens are compacted; turns are appended only when ≥1.
 */
export function formatCost(cost: RailCost): string | null {
  if (cost.turns === 0 && cost.costUsd == null && cost.totalTokens == null) return null
  const parts: string[] = []
  if (cost.costUsd != null) parts.push(`$${cost.costUsd.toFixed(4)}`)
  if (cost.totalTokens != null) parts.push(`${formatTokens(cost.totalTokens)} tok`)
  if (cost.turns > 0) parts.push(`${cost.turns} ${cost.turns === 1 ? "turn" : "turns"}`)
  return parts.length ? parts.join(" · ") : null
}

// ---------------------------------------------------------------------------
// NOW — the single live line for the active terminal.
// ---------------------------------------------------------------------------

/** The rail's NOW line: a live action while busy, or a calm rest state otherwise. */
export interface RailNow {
  /** "busy" → an agent turn is in flight; "idle" → at rest. */
  state: "busy" | "idle"
  /** The primary line. While busy: the current action ("Editing terminals.ts" or a
   *  calm "Working"). While idle: "Idle" / "Ready". */
  label: string
  /** Whether the pulse bar should animate (busy only). */
  pulsing: boolean
}

/**
 * Format a running elapsed duration (ms) as "m:ss" (or "h:mm:ss" past an hour), e.g.
 * 47_000 → "0:47", 612_000 → "10:12". Clamps negatives to 0. Pure (the live-ticking
 * clock that feeds `ms` lives in the component).
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, "0")
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`
  return `${m}:${pad(s)}`
}

/**
 * Derive the NOW line for the active terminal from the EXISTING signals the sidebar
 * dot already uses — there is NO new backend:
 *   - `busy` ← the App's `isTerminalBusy` (useGeneratingTerminals ∪ pending permission).
 *   - `activity` ← the terminal's `effectiveActivity` (self-reported set_terminal_activity
 *     or the parsed last tool-call line), same string the sidebar row reads.
 *
 * Busy → "<activity>" (or a calm "Working" when no activity string is known yet); the
 * caller appends the live elapsed. Idle → "Idle" when there's no terminal at all/just
 * at rest; "Ready" when a terminal is selected but quiet (it reads as "ready for your
 * next message", matching the AgentView empty state). The elapsed timer only runs while
 * busy, so the idle line carries none.
 */
export function deriveNow(input: {
  hasTerminal: boolean
  busy: boolean
  activity?: string | null
}): RailNow {
  const { hasTerminal, busy } = input
  const activity = input.activity?.trim() || ""
  if (busy) {
    return { state: "busy", label: activity || "Working", pulsing: true }
  }
  return { state: "idle", label: hasTerminal ? "Ready" : "Idle", pulsing: false }
}

// ---------------------------------------------------------------------------
// COLLAPSE — effective open/closed from saved pref + width + explicit collapse.
// ---------------------------------------------------------------------------

/**
 * The viewport width (px) at/below which the rail auto-collapses to its spine, to
 * protect the center transcript's reading width on smaller windows (design doc §3 /
 * risk 1). Strictly: collapse when width < this floor.
 */
export const RAIL_WIDTH_FLOOR = 1400

/**
 * Derive whether the rail renders OPEN (full column) vs COLLAPSED (the spine), from
 * three independent inputs, in precedence order:
 *   1. `collapsed` — an EXPLICIT user collapse (the header chevron / the toggle
 *      shortcut / the palette / the saved pref `open === false`) → always the spine.
 *   2. width < {@link RAIL_WIDTH_FLOOR} — the responsive auto-collapse → the spine,
 *      WITHOUT mutating the saved pref (so widening back restores the user's choice).
 *   3. otherwise → open.
 *
 * Pure: the component holds `collapsed` (seeded from the persisted pref, toggled by
 * the controls) and the live `width`, and renders open IFF this returns true. Keeping
 * the width auto-collapse OUT of the persisted pref is the whole point — a narrow
 * window must never overwrite the user's saved preference.
 */
export function effectiveRailOpen(input: { collapsed: boolean; width: number }): boolean {
  if (input.collapsed) return false
  if (input.width < RAIL_WIDTH_FLOOR) return false
  return true
}
