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
 * into one spawn-cumulative figure for the rail's COST footer. Each turn-complete
 * `result` block carries THIS TURN's own cost + tokens; this folds them.
 *
 * CAPP-125 — the block's `costUsd` is the PER-TURN DELTA, not the raw
 * `result.total_cost_usd` (which is CUMULATIVE per process — live-proven in
 * resultCostSemantics.fixtures.ts). The cumulative→delta conversion happens upstream at
 * the fold ({@link toPerTurnCost} in useAgentCost / reduceTranscript), so summing here is
 * correct. Summing the RAW cumulatives instead triangular-overcounts (Σ of the running
 * totals showed ~$105 for a ~$26 spawn — the CAPP-125 bug). `totalTokens` was always
 * per-turn (built from the top-level `usage` object), so it was already summed correctly.
 *
 * Deliberate v1 limitation (design doc Q5 / risk 4): this is a RENDERER-side sum over
 * the in-memory folded blocks, so it counts only the CURRENT spawn — it resets on a
 * respawn/interrupt (the terminal mints a fresh id, useAgentCost prunes the old) and
 * misses turns scrolled out of the cache. That's accepted for a glance number — a
 * durable per-session total (a SessionService field) is a later option. The footer is
 * labeled "this spawn" so the window it measures is honest.
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

// ---------------------------------------------------------------------------
// KNOWS — the context digest (Agent Rail Phase 3 / CAPP-84 × CAPP-86 v1.5).
// ---------------------------------------------------------------------------
//
// Two digests for the ACTIVE session/workspace, sourced from EXISTING accessors —
// NO new backend:
//   • This session  ← getSessionOverview (the SAME shape the ⊕ Session Overview
//     panel reads): summary + active findings + ruled-out (with corrections) +
//     provisional findings.
//   • Across sessions ← RecallService.summary() via window.api.recallSummary,
//     scoped to the active session's WORKSPACE (default — no cross-workspace leak).
//
// This module shapes the COUNTS + the one-liners the rail renders, and decides when
// the section has nothing to show (so the calm rail isn't cluttered when empty). It
// is the one KNOWS decision worth proving — kept pure so it is fully unit-testable.

/** The minimal slice of a SessionOverview that the KNOWS per-session digest reads.
 *  Structurally compatible with electron's SessionOverview (no import — this module
 *  stays React/Electron-free, mirroring sumCost reading only TranscriptBlock fields). */
export interface KnowsOverviewInput {
  summary?: string
  /** Active findings (the overview's `notes`, already filtered to status:active). */
  notes?: Array<{ text: string }>
  /** Ruled-out findings with their forward correction (the `~~old~~ → new` pair). */
  ruledOut?: Array<{ text: string; correction?: string }>
  /** Provisional findings (observer seam) — counted when present, else absent. */
  provisionalFindings?: Array<{ text: string }>
}

/** The minimal slice of RecallService.summary() the cross-session digest reads.
 *  NOTE: RecallService.summary() EXCLUDES the caller's own session (matched by
 *  `sessionId`, and — for a workspace-memory finding promoted FROM the caller — by
 *  `originSessionId`), so `sessions`/`findings`/`ruledOut` reflect OTHER sessions only.
 *  The durable workspace-memory tier is a SEPARATE digest (`workspaceMemory`), counted
 *  in its own branch and surfaced as its own rail group (CAPP-87 / U4). */
export interface KnowsRecallInput {
  /** OTHER sessions that contributed at least one entry within scope (workspace by
   *  default) — the caller's own session is excluded. */
  sessions: number
  findings: number
  ruledOut: number
  /** The durable workspace-memory tier's counts in scope. Optional on the input shape
   *  (older callers/tests may omit it); when absent it's treated as empty (0/0). */
  workspaceMemory?: { findings: number; ruledOut: number }
  recentRuledOut?: { text: string; correction?: string; sessionName: string }
}

/** A ruled-out one-liner the rail renders as `~~text~~ → correction`. */
export interface RuledOutLine {
  text: string
  correction?: string
}

/** The per-session ("This session") digest the KNOWS section renders. */
export interface KnowsSession {
  /** Count of active findings (the overview's notes). */
  findings: number
  /** Count of ruled-out (superseded) findings. */
  ruledOut: number
  /** Count of provisional findings, or undefined when the seam is empty/absent
   *  (so the chip is simply not rendered rather than showing a misleading 0). */
  provisional?: number
  /** The 1-line summary, trimmed; undefined when the session has none yet. */
  summary?: string
  /** The most-recent ruled-out one-liner (newest is last in the overview's array),
   *  with its correction; undefined when nothing has been ruled out. */
  recentRuledOut?: RuledOutLine
}

/** The cross-session ("Across sessions") recall digest the KNOWS section renders. */
export interface KnowsRecall {
  /** Contributing OTHER sessions in scope (workspace). Excludes the active session —
   *  RecallService.summary() now subtracts it (see KnowsRecallInput). */
  sessions: number
  findings: number
  ruledOut: number
  /** The most-recent cross-session ruled-out one-liner (+ its owning session name). */
  recentRuledOut?: RuledOutLine & { sessionName: string }
}

/** The durable workspace-memory ("Workspace memory") digest the KNOWS section renders
 *  as its OWN third group (CAPP-87 / U4) — independent of how many other sessions
 *  contributed, since memory is the always-present tier. */
export interface KnowsWorkspaceMemory {
  /** Active workspace-memory findings in scope. */
  findings: number
  /** Ruled-out workspace-memory findings in scope. */
  ruledOut: number
}

/** The shaped KNOWS view-model — the digests + whether the section renders at all. */
export interface RailKnows {
  /** True IFF any digest has something worth showing. When false the rail OMITS the
   *  whole KNOWS section so an empty session never clutters the calm column. */
  hasContent: boolean
  /** The per-session digest, or null when the active session has no context yet. */
  session: KnowsSession | null
  /** The cross-session recall digest, or null when no OTHER sessions have hits. */
  recall: KnowsRecall | null
  /** The durable workspace-memory digest, or null when memory is empty in scope. */
  workspaceMemory: KnowsWorkspaceMemory | null
}

/**
 * Shape the KNOWS section's two digests from the EXISTING accessors. Pure + tolerant:
 * a missing overview (no active session) yields `session: null`; a missing/empty
 * recall summary yields `recall: null`; and `hasContent` is false only when BOTH are
 * empty — that's the signal the component uses to OMIT the section entirely.
 *
 * Per-session ("This session"): findings = active notes; ruledOut = superseded; the
 * most-recent ruled-out is the LAST entry of the overview's `ruledOut` array (the
 * overview preserves note order, so newest-superseded is last). A session counts as
 * having content if it has any summary, finding, ruled-out, or provisional.
 *
 * Cross-session ("Across sessions"): straight from RecallService.summary() (already
 * scoped to the caller's workspace by the IPC default). It counts as content only
 * when there is at least one contributing session AND at least one finding or
 * ruled-out — a lone empty digest (0/0 across 0 sessions) is treated as nothing to
 * show. (The digest EXCLUDES the active session — and a memory finding promoted from
 * it — see KnowsRecallInput.)
 *
 * Workspace memory ("Workspace memory", CAPP-87 / U4): the durable tier's counts, also
 * straight from RecallService.summary().workspaceMemory. It has its OWN non-empty gate
 * (any finding or ruled-out) — it is NOT gated on other sessions contributing, because
 * memory is the always-present tier (it can be the ONLY thing in scope and must still
 * render).
 */
export function deriveKnows(
  overview: KnowsOverviewInput | null | undefined,
  recallSummary: KnowsRecallInput | null | undefined,
): RailKnows {
  const session = deriveKnowsSession(overview)
  const recall = deriveKnowsRecall(recallSummary)
  const workspaceMemory = deriveKnowsWorkspaceMemory(recallSummary)
  return {
    hasContent: session != null || recall != null || workspaceMemory != null,
    session,
    recall,
    workspaceMemory,
  }
}

function deriveKnowsSession(ov: KnowsOverviewInput | null | undefined): KnowsSession | null {
  if (!ov) return null
  const summary = ov.summary?.trim() || undefined
  const findings = ov.notes?.length ?? 0
  const ruled = ov.ruledOut ?? []
  const ruledOut = ruled.length
  const provisionalCount = ov.provisionalFindings?.length ?? 0
  const provisional = provisionalCount > 0 ? provisionalCount : undefined

  // Nothing accumulated yet → no per-session digest (so the section can hide).
  if (!summary && findings === 0 && ruledOut === 0 && provisional == null) return null

  // Newest-superseded is the LAST ruled-out entry (the overview keeps note order).
  const last = ruled.length ? ruled[ruled.length - 1] : undefined
  const recentRuledOut = last
    ? { text: last.text, ...(last.correction ? { correction: last.correction } : {}) }
    : undefined

  return {
    findings,
    ruledOut,
    ...(provisional != null ? { provisional } : {}),
    ...(summary ? { summary } : {}),
    ...(recentRuledOut ? { recentRuledOut } : {}),
  }
}

function deriveKnowsRecall(rs: KnowsRecallInput | null | undefined): KnowsRecall | null {
  if (!rs) return null
  // A digest with no other sessions OR no findings/ruled-out is nothing to show.
  if (rs.sessions <= 0 || (rs.findings === 0 && rs.ruledOut === 0)) return null
  const recent = rs.recentRuledOut
  const recentRuledOut = recent
    ? {
        text: recent.text,
        sessionName: recent.sessionName,
        ...(recent.correction ? { correction: recent.correction } : {}),
      }
    : undefined
  return {
    sessions: rs.sessions,
    findings: rs.findings,
    ruledOut: rs.ruledOut,
    ...(recentRuledOut ? { recentRuledOut } : {}),
  }
}

/**
 * Shape the durable workspace-memory digest from RecallService.summary().workspaceMemory
 * (CAPP-87 / U4). Its OWN non-empty gate — `findings > 0 || ruledOut > 0` — deliberately
 * does NOT reuse {@link deriveKnowsRecall}'s `rs.sessions <= 0` gate: memory is the
 * always-present tier, independent of how many OTHER sessions contributed, so it must
 * render even when it's the only thing in scope. Returns null (group hidden) when empty
 * or when the digest is absent (an older summary that predates the field).
 */
function deriveKnowsWorkspaceMemory(
  rs: KnowsRecallInput | null | undefined,
): KnowsWorkspaceMemory | null {
  const wm = rs?.workspaceMemory
  if (!wm) return null
  if (wm.findings <= 0 && wm.ruledOut <= 0) return null
  return { findings: wm.findings, ruledOut: wm.ruledOut }
}
