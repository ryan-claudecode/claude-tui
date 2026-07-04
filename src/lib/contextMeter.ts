/**
 * CAPP-127 — the PURE derivation behind the live context-meter bar. ZERO React /
 * Electron / node imports (type-only imports from agentTranscript, which is itself
 * pure) so it's a plain unit-test seam, exactly like sessionRow / scheduleRow /
 * contextMeter's sibling reducers.
 *
 * A structured (headless) turn ends with a `result` event whose `usage` reports the
 * turn's INPUT-side token footprint. The context WINDOW a fresh `claude` is eating at
 * that moment ≈ `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
 * (the same three classes {@link ResultCost} already carries — see CAPP-125's
 * extractCost). Output tokens do NOT occupy the input window, so they're excluded.
 *
 * The bar shows three stacked segments that PARTITION the current total:
 *   - baseline  — the FIRST result's footprint (≈ system prompt + tools + CLAUDE.md +
 *                 our injected primer): the fixed cost every turn carries.
 *   - history   — growth accumulated between the first result and the turn BEFORE the
 *                 latest (the conversation's middle).
 *   - lastTurn  — the delta the latest result added on top (this turn's own growth).
 * baseline + history + lastTurn === total, so the three widths tile cleanly under the
 * model's context cap.
 */

import type { ResultCost, TranscriptBlock } from "./agentTranscript"

/** The default model context window (Claude's standard 200k). */
export const DEFAULT_CONTEXT_CAP = 200_000
/** The 1M-context window unlocked by a `[1m]` model alias. */
export const ONE_M_CONTEXT_CAP = 1_000_000

/** Zone thresholds (fraction of cap) at which the bar's remainder tints warning / danger. */
export const WARNING_PCT = 0.7
export const DANGER_PCT = 0.9

/**
 * The context cap (window size, in tokens) for a model string. A `[1m]` marker
 * (case-insensitive) — present in either the picked alias (`opus[1m]`) or a resolved
 * id — unlocks the 1M window; everything else uses the 200k default. Pass the alias
 * and the resolved id joined (e.g. `"opus[1m] claude-opus-4-8"`) so `[1m]` is detected
 * from whichever carries it. Empty/undefined → the default.
 */
export function contextCapForModel(model?: string): number {
  if (!model) return DEFAULT_CONTEXT_CAP
  return /\[1m\]/i.test(model) ? ONE_M_CONTEXT_CAP : DEFAULT_CONTEXT_CAP
}

/**
 * The context-window footprint a single `result` reports: input + cache-read +
 * cache-creation tokens. Returns `null` when the result carried NO usage at all (so it
 * is SKIPPED, never counted as a real 0 — a usage-less result must not reset the bar).
 */
export function resultContextFootprint(cost?: ResultCost): number | null {
  if (!cost) return null
  const { inputTokens, cacheReadTokens, cacheCreationTokens } = cost
  if (inputTokens == null && cacheReadTokens == null && cacheCreationTokens == null) return null
  return (inputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0)
}

/** The ordered per-result context footprints found in a folded transcript (usage-less
 *  results dropped). This is the ONLY input the meter math needs. */
export function footprintsFromBlocks(blocks: readonly TranscriptBlock[]): number[] {
  const out: number[] = []
  for (const b of blocks) {
    if (b.kind !== "result") continue
    const f = resultContextFootprint(b.cost)
    if (f != null) out.push(f)
  }
  return out
}

export type ContextZone = "normal" | "warning" | "danger"

export interface ContextMeter {
  /** The first result's footprint — the fixed per-turn cost (clamped ≤ total). */
  baseline: number
  /** Conversation growth between the first result and the turn before the latest (≥ 0). */
  history: number
  /** The latest result's own delta over the previous result (≥ 0). */
  lastTurn: number
  /** The current (latest) footprint — honest even when context SHRANK (/compact, --resume). */
  total: number
  /** The model's context window. */
  cap: number
  /** total / cap, clamped to 0..1 (the fill fraction). */
  pct: number
  /** Zone for tinting the remainder/edge: ≥90% danger, ≥70% warning, else normal. */
  zone: ContextZone
  /** How many results contributed (for tests / debugging). */
  results: number
}

/** The zone for a fill fraction (0..1). */
export function zoneForPct(pct: number): ContextZone {
  if (pct >= DANGER_PCT) return "danger"
  if (pct >= WARNING_PCT) return "warning"
  return "normal"
}

/**
 * Core meter math over an ordered footprint list + a cap. Returns `null` for an EMPTY
 * list (nothing to show yet → the bar hides). Guarantees:
 *   - baseline + history + lastTurn === total (the segments tile the total exactly);
 *   - every segment is ≥ 0 (context can SHRINK after /compact or --resume — no negative
 *     widths); the new latest is taken as the honest `total`;
 *   - a single result → baseline = total, history = 0, lastTurn = 0 (consistent convention).
 */
export function deriveContextMeter(footprints: readonly number[], cap: number): ContextMeter | null {
  const n = footprints.length
  if (n === 0) return null
  const first = Math.max(0, footprints[0])
  const total = Math.max(0, footprints[n - 1])
  const prev = n >= 2 ? Math.max(0, footprints[n - 2]) : total
  // Clamp baseline to the total so a heavy shrink (total below the first footprint)
  // never produces a baseline wider than the whole bar.
  const baseline = Math.min(first, total)
  // The latest turn's own growth — never negative (a shrinking last turn contributes 0).
  const lastTurn = Math.max(0, total - prev)
  // The middle absorbs whatever remains so the three segments tile `total` exactly.
  const history = Math.max(0, total - baseline - lastTurn)
  const safeCap = cap > 0 ? cap : DEFAULT_CONTEXT_CAP
  const pct = Math.max(0, Math.min(1, total / safeCap))
  return { baseline, history, lastTurn, total, cap: safeCap, pct, zone: zoneForPct(pct), results: n }
}

/**
 * Convenience: derive the meter straight from a folded transcript + the terminal's
 * model string(s). This is what the renderer calls — it feeds off the SAME `result`
 * blocks the transcript view renders (so it can't drift), and rehydrates for free
 * because a restored transcript re-folds those same blocks.
 */
export function contextMeterFromBlocks(
  blocks: readonly TranscriptBlock[],
  model?: string,
): ContextMeter | null {
  return deriveContextMeter(footprintsFromBlocks(blocks), contextCapForModel(model))
}
