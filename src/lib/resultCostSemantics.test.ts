import { describe, it, expect } from "vitest"
import {
  extractCost,
  toPerTurnCost,
  lastCumulativeCostUsd,
  foldTranscript,
  type ResultCost,
  type TranscriptBlock,
} from "./agentTranscript"
import type { StreamEvent } from "../../electron/services/streamProtocol"
import {
  P1_TURN1_RESULT_RAW,
  P1_TURN2_RESULT_RAW,
  P2_RESUME_RESULT_RAW,
} from "./resultCostSemantics.fixtures"

/**
 * CAPP-125 — proves the cumulative→delta fold no longer triangular-overcounts, driven by
 * the LIVE-captured wire semantics (resultCostSemantics.fixtures.ts):
 *   • `result.total_cost_usd` is CUMULATIVE per process,
 *   • the top-level `usage` object is PER-TURN,
 *   • `--resume` in a fresh process RESETS the cumulative counter.
 * The fold (toPerTurnCost) converts cost cumulative→delta so the PER-TURN deltas sum to the
 * true total. (CAPP-129 retired the renderer-side `sumCost`; the durable rolling totals are
 * now accumulated in the main process from these same per-turn deltas. This test asserts the
 * fold semantics via a local reduce over the folded blocks, so the CAPP-125 pin is intact.)
 */

/** The per-turn-delta sum a consumer folds off the transcript blocks — the exact reduction
 *  both the (deleted) rail `sumCost` and the main-process CAPP-129 accumulator perform. */
function sumResultDeltas(blocks: readonly TranscriptBlock[]): {
  costUsd?: number
  totalTokens?: number
  turns: number
} {
  let costUsd: number | undefined
  let totalTokens: number | undefined
  let turns = 0
  for (const b of blocks) {
    if (b.kind !== "result") continue
    turns++
    if (b.cost?.costUsd != null) costUsd = (costUsd ?? 0) + b.cost.costUsd
    if (b.cost?.totalTokens != null) totalTokens = (totalTokens ?? 0) + b.cost.totalTokens
  }
  return { costUsd, totalTokens, turns }
}

// Build the `result` StreamEvent the transport hands the reducer (raw = the payload).
function resultEvent(raw: Record<string, unknown>): StreamEvent {
  return {
    kind: "result",
    isError: Boolean(raw.is_error),
    subtype: typeof raw.subtype === "string" ? raw.subtype : undefined,
    result: typeof raw.result === "string" ? raw.result : undefined,
    raw,
  }
}

// The per-turn deltas the live capture implies (see the fixture header):
const TURN1_COST = 0.013738 //             process1 turn1 — first result, its own cost
const TURN2_CUMULATIVE = 0.0263881 //      process1 turn2 — CUMULATIVE (turn1 + turn2)
const TURN2_DELTA = TURN2_CUMULATIVE - TURN1_COST // ≈ 0.0126501 — turn2's OWN cost
const RESUME_COST = 0.005355500000000001 // process2 resume turn1 — RESET, its own cost

describe("CAPP-125 — the live wire verdict (documented by the captured fixtures)", () => {
  it("total_cost_usd is CUMULATIVE per process (turn2 > turn1, carries turn1)", () => {
    expect(P1_TURN2_RESULT_RAW.total_cost_usd).toBeGreaterThan(P1_TURN1_RESULT_RAW.total_cost_usd)
    // turn2 cumulative − turn1 = turn2's own increment (a plausible positive delta).
    expect(P1_TURN2_RESULT_RAW.total_cost_usd - P1_TURN1_RESULT_RAW.total_cost_usd).toBeCloseTo(
      TURN2_DELTA,
      9,
    )
  })

  it("the top-level `usage` object is PER-TURN (turn2 output is THIS turn, not the cumulative)", () => {
    // Per-turn: turn2 output_tokens is its own 106 — NOT the cumulative 564 modelUsage carries.
    expect(P1_TURN2_RESULT_RAW.usage.output_tokens).toBe(106)
    expect(P1_TURN1_RESULT_RAW.usage.output_tokens).toBe(458)
    // And modelUsage IS cumulative — the mirror that proves top-level usage is per-turn.
    expect(P1_TURN2_RESULT_RAW.modelUsage["claude-haiku-4-5-20251001"].outputTokens).toBe(
      458 + 106,
    )
    expect(P1_TURN2_RESULT_RAW.modelUsage["claude-haiku-4-5-20251001"].cacheReadInputTokens).toBe(
      25160 + 29621,
    )
  })

  it("`--resume` in a fresh process RESETS the cumulative counter (< the prior process's)", () => {
    expect(P2_RESUME_RESULT_RAW.total_cost_usd).toBeLessThan(P1_TURN2_RESULT_RAW.total_cost_usd)
    // The resumed turn's cumulative equals its own single-turn modelUsage cost — no history.
    expect(P2_RESUME_RESULT_RAW.total_cost_usd).toBeCloseTo(
      P2_RESUME_RESULT_RAW.modelUsage["claude-haiku-4-5-20251001"].costUSD,
      9,
    )
  })

  it("extractCost surfaces the RAW cumulative in costUsd + per-turn totalTokens", () => {
    const c1 = extractCost(P1_TURN1_RESULT_RAW)
    expect(c1.costUsd).toBeCloseTo(TURN1_COST, 9) // raw cumulative (== turn1's own here)
    expect(c1.totalTokens).toBe(10 + 458 + 4461 + 25160) // per-turn token classes summed
    const c2 = extractCost(P1_TURN2_RESULT_RAW)
    expect(c2.costUsd).toBeCloseTo(TURN2_CUMULATIVE, 9) // RAW cumulative (the trap)
    expect(c2.totalTokens).toBe(10 + 106 + 4574 + 29621) // per-turn — safe to sum
  })

  it("extractCost captures contextTokens from the LAST usage.iterations entry (window snapshot)", () => {
    // Single-request turns: the one iteration IS the snapshot (== the summed classes).
    const c1 = extractCost(P1_TURN1_RESULT_RAW)
    expect(c1.contextTokens).toBe(10 + 25160 + 4461)

    // Tool-heavy turn: top-level classes SUM across the turn's API requests, so a
    // 200k-window turn can report >1M billed input-side tokens. The window at turn end
    // is the LAST iteration's input+cache_read+cache_creation — NOT the top-level sum.
    const multiIteration = {
      ...P1_TURN1_RESULT_RAW,
      usage: {
        ...P1_TURN1_RESULT_RAW.usage,
        input_tokens: 30,
        cache_creation_input_tokens: 9_000,
        cache_read_input_tokens: 160_000,
        iterations: [
          { type: "message", input_tokens: 10, output_tokens: 400, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 4_000 },
          { type: "message", input_tokens: 10, output_tokens: 300, cache_read_input_tokens: 54_000, cache_creation_input_tokens: 3_000 },
          { type: "message", input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 56_000, cache_creation_input_tokens: 2_000 },
        ],
      },
    }
    const cm = extractCost(multiIteration)
    expect(cm.contextTokens).toBe(10 + 56_000 + 2_000) // last iteration only
    expect(cm.totalTokens).toBe(30 + 458 + 9_000 + 160_000) // billed sum untouched

    // No iterations array (older claude versions) → undefined, callers fall back.
    const noIterations = {
      ...P1_TURN1_RESULT_RAW,
      usage: { ...P1_TURN1_RESULT_RAW.usage, iterations: undefined },
    }
    expect(extractCost(noIterations).contextTokens).toBeUndefined()
  })
})

describe("toPerTurnCost — cumulative → this turn's own cost (reset-safe)", () => {
  it("the first turn (prev 0) is its own cumulative", () => {
    const t1 = toPerTurnCost(extractCost(P1_TURN1_RESULT_RAW), 0)
    expect(t1.costUsd).toBeCloseTo(TURN1_COST, 9)
    expect(t1.cumulativeCostUsd).toBeCloseTo(TURN1_COST, 9)
  })

  it("a later turn subtracts the previous cumulative → the true per-turn delta", () => {
    const t2 = toPerTurnCost(extractCost(P1_TURN2_RESULT_RAW), TURN1_COST)
    expect(t2.costUsd).toBeCloseTo(TURN2_DELTA, 9) // 0.0126501, NOT 0.0263881
    expect(t2.cumulativeCostUsd).toBeCloseTo(TURN2_CUMULATIVE, 9)
  })

  it("a fresh-process RESET (current < previous) contributes its own cost, never negative", () => {
    // prev is process1's final cumulative; the resumed turn's cumulative is smaller.
    const r = toPerTurnCost(extractCost(P2_RESUME_RESULT_RAW), TURN2_CUMULATIVE)
    expect(r.costUsd).toBeCloseTo(RESUME_COST, 9) // its own cost — NOT 0.0053555 − 0.0263881
    expect(r.costUsd!).toBeGreaterThan(0)
    expect(r.cumulativeCostUsd).toBeCloseTo(RESUME_COST, 9)
  })

  it("a turn that reported NO cost is passed through unchanged (undefined stays undefined)", () => {
    const noCost: ResultCost = { totalTokens: 500 }
    const out = toPerTurnCost(noCost, 5)
    expect(out.costUsd).toBeUndefined()
    expect(out.cumulativeCostUsd).toBeUndefined()
    expect(out.totalTokens).toBe(500)
  })
})

describe("lastCumulativeCostUsd — the prev baseline recovered from ordered blocks", () => {
  const rb = (id: string, cumulativeCostUsd?: number): TranscriptBlock => ({
    kind: "result",
    id,
    isError: false,
    cost: cumulativeCostUsd == null ? undefined : { cumulativeCostUsd },
  })

  it("empty / no result blocks → 0", () => {
    expect(lastCumulativeCostUsd([])).toBe(0)
    expect(lastCumulativeCostUsd([{ kind: "assistant", id: "b0", text: "hi" }])).toBe(0)
  })

  it("returns the LAST result block's raw cumulative", () => {
    expect(lastCumulativeCostUsd([rb("b0", 0.01), rb("b1", 0.03)])).toBe(0.03)
  })

  it("skips result blocks that carried no cumulative (cost-less turns)", () => {
    expect(lastCumulativeCostUsd([rb("b0", 0.02), rb("b1", undefined)])).toBe(0.02)
  })
})

describe("foldTranscript + per-turn-delta sum — the end-to-end cost total (no overcount)", () => {
  it("two turns in one process: the footer shows the true spawn total, not the triangular sum", () => {
    const blocks = foldTranscript([resultEvent(P1_TURN1_RESULT_RAW), resultEvent(P1_TURN2_RESULT_RAW)])
    const results = blocks.filter((b) => b.kind === "result")
    expect(results).toHaveLength(2)

    // Each folded block carries its PER-TURN cost (turn2 is the delta, not the cumulative).
    expect((results[0] as { cost?: ResultCost }).cost?.costUsd).toBeCloseTo(TURN1_COST, 9)
    expect((results[1] as { cost?: ResultCost }).cost?.costUsd).toBeCloseTo(TURN2_DELTA, 9)

    // The rail sum equals the LAST cumulative (the true spawn spend) — 0.0263881.
    const sum = sumResultDeltas(blocks)
    expect(sum.turns).toBe(2)
    expect(sum.costUsd).toBeCloseTo(TURN2_CUMULATIVE, 9)

    // REGRESSION: the OLD code summed the RAW cumulatives → an overcount.
    const oldTriangular = P1_TURN1_RESULT_RAW.total_cost_usd + P1_TURN2_RESULT_RAW.total_cost_usd
    expect(oldTriangular).toBeCloseTo(0.0401261, 6)
    expect(sum.costUsd!).toBeLessThan(oldTriangular) // the bug is gone
  })

  it("tokens (per-turn) are summed across both turns (unchanged, already correct)", () => {
    const blocks = foldTranscript([resultEvent(P1_TURN1_RESULT_RAW), resultEvent(P1_TURN2_RESULT_RAW)])
    const sum = sumResultDeltas(blocks)
    const t1 = 10 + 458 + 4461 + 25160
    const t2 = 10 + 106 + 4574 + 29621
    expect(sum.totalTokens).toBe(t1 + t2)
  })

  it("respawn/resume in the SAME block list: sums each process's own spend (reset-safe)", () => {
    // process1's two turns, then a resumed process's result appended in the same list
    // (the BO-12 rehydrate-then-resume shape). True spend = 0.0263881 + 0.0053555.
    const blocks = foldTranscript([
      resultEvent(P1_TURN1_RESULT_RAW),
      resultEvent(P1_TURN2_RESULT_RAW),
      resultEvent(P2_RESUME_RESULT_RAW),
    ])
    const sum = sumResultDeltas(blocks)
    expect(sum.turns).toBe(3)
    expect(sum.costUsd).toBeCloseTo(TURN2_CUMULATIVE + RESUME_COST, 9)
    // The reset turn contributed its own cost, not a negative — so the total is > process1's.
    expect(sum.costUsd!).toBeGreaterThan(TURN2_CUMULATIVE)
  })

  it("REGRESSION — the reported $105 shape: 8 cumulative turns, +$2.90 each", () => {
    // Model the bug report: a spawn whose per-turn cost is ~$2.90 and whose result
    // total_cost_usd climbs 2.90, 5.80, … 23.20 across 8 turns. OLD = Σ cumulatives
    // ≈ $104.40 (the "$105" shown). NEW = the final cumulative ≈ $23.20 (true spend).
    const perTurn = 2.9
    const events: StreamEvent[] = []
    for (let i = 1; i <= 8; i++) {
      events.push(resultEvent({ subtype: "success", is_error: false, total_cost_usd: perTurn * i }))
    }
    const sum = sumResultDeltas(foldTranscript(events))
    expect(sum.turns).toBe(8)
    expect(sum.costUsd).toBeCloseTo(perTurn * 8, 6) // $23.20 — the true total

    const oldTriangular = Array.from({ length: 8 }, (_, i) => perTurn * (i + 1)).reduce((a, b) => a + b, 0)
    expect(oldTriangular).toBeCloseTo(104.4, 6) // the "$105" overcount
    expect(sum.costUsd!).toBeCloseTo(23.2, 6)
    expect(sum.costUsd! * 4).toBeLessThan(oldTriangular) // ~4.5x smaller — the fix
  })
})
