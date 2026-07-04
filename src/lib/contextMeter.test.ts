import { describe, it, expect } from "vitest"
import {
  contextCapForModel,
  resultContextFootprint,
  footprintsFromBlocks,
  deriveContextMeter,
  contextMeterFromBlocks,
  zoneForPct,
  DEFAULT_CONTEXT_CAP,
  ONE_M_CONTEXT_CAP,
} from "./contextMeter"
import type { ResultBlock, TranscriptBlock, ResultCost } from "./agentTranscript"

// A folded `result` block carrying a given per-turn usage footprint.
function resultBlock(id: string, cost?: Partial<ResultCost>): ResultBlock {
  return { kind: "result", id, isError: false, cost: cost as ResultCost | undefined }
}

describe("contextCapForModel", () => {
  it("defaults to 200k for a plain / unknown / empty model", () => {
    expect(contextCapForModel(undefined)).toBe(DEFAULT_CONTEXT_CAP)
    expect(contextCapForModel("")).toBe(DEFAULT_CONTEXT_CAP)
    expect(contextCapForModel("opus")).toBe(200_000)
    expect(contextCapForModel("claude-opus-4-8")).toBe(200_000)
    expect(contextCapForModel("sonnet")).toBe(200_000)
  })
  it("unlocks the 1M window for a [1m] alias (case-insensitive), in either string", () => {
    expect(contextCapForModel("opus[1m]")).toBe(ONE_M_CONTEXT_CAP)
    expect(contextCapForModel("SONNET[1M]")).toBe(1_000_000)
    // alias joined with a resolved id — [1m] detected from whichever carries it
    expect(contextCapForModel("opus[1m] claude-opus-4-8")).toBe(1_000_000)
    expect(contextCapForModel("claude-opus-4-8[1m]")).toBe(1_000_000)
  })
})

describe("resultContextFootprint", () => {
  it("sums input + cache-read + cache-creation, excluding output", () => {
    expect(
      resultContextFootprint({
        inputTokens: 100,
        outputTokens: 9999,
        cacheReadTokens: 5000,
        cacheCreationTokens: 400,
      } as ResultCost),
    ).toBe(5500)
  })
  it("treats missing token classes as 0 when at least one is present", () => {
    expect(resultContextFootprint({ cacheReadTokens: 2000 } as ResultCost)).toBe(2000)
  })
  it("returns null when the result reported NO usage at all (skipped, not 0)", () => {
    expect(resultContextFootprint(undefined)).toBeNull()
    expect(resultContextFootprint({} as ResultCost)).toBeNull()
    expect(resultContextFootprint({ costUsd: 0.02, durationMs: 500 } as ResultCost)).toBeNull()
  })
  it("prefers contextTokens (the LAST API request's window snapshot) over the per-turn sum", () => {
    // A tool-heavy turn: top-level classes SUM across the turn's API requests (~1.48M
    // billed), but the window at turn end is only the last request's footprint.
    expect(
      resultContextFootprint({
        inputTokens: 12_000,
        outputTokens: 40_000,
        cacheReadTokens: 1_400_000,
        cacheCreationTokens: 66_025,
        contextTokens: 82_500,
      } as ResultCost),
    ).toBe(82_500)
  })
  it("falls back to the summed classes when contextTokens is absent (old payloads)", () => {
    expect(
      resultContextFootprint({
        inputTokens: 100,
        cacheReadTokens: 5000,
        cacheCreationTokens: 400,
      } as ResultCost),
    ).toBe(5500)
  })
})

describe("footprintsFromBlocks", () => {
  it("extracts ordered footprints from result blocks, dropping usage-less ones", () => {
    const blocks: TranscriptBlock[] = [
      { kind: "user", id: "u0", text: "hi" },
      resultBlock("r0", { inputTokens: 100, cacheReadTokens: 900 }), // 1000
      { kind: "assistant", id: "a1", text: "…" },
      resultBlock("r1"), // no usage → skipped
      resultBlock("r2", { inputTokens: 200, cacheReadTokens: 4800 }), // 5000
    ]
    expect(footprintsFromBlocks(blocks)).toEqual([1000, 5000])
  })
  it("returns [] when there are no result blocks", () => {
    expect(footprintsFromBlocks([{ kind: "user", id: "u0", text: "x" }])).toEqual([])
  })
})

describe("deriveContextMeter", () => {
  it("returns null for zero results (hidden state)", () => {
    expect(deriveContextMeter([], 200_000)).toBeNull()
  })

  it("single result → baseline = total, history = 0, lastTurn = 0", () => {
    const m = deriveContextMeter([12_000], 200_000)!
    expect(m.baseline).toBe(12_000)
    expect(m.history).toBe(0)
    expect(m.lastTurn).toBe(0)
    expect(m.total).toBe(12_000)
    expect(m.baseline + m.history + m.lastTurn).toBe(m.total)
    expect(m.results).toBe(1)
  })

  it("multi-result monotonic growth partitions total into baseline/history/lastTurn", () => {
    // [10k baseline, 30k, 50k latest]
    const m = deriveContextMeter([10_000, 30_000, 50_000], 200_000)!
    expect(m.baseline).toBe(10_000)
    expect(m.lastTurn).toBe(20_000) // 50k - 30k
    expect(m.history).toBe(20_000) // 30k - 10k
    expect(m.total).toBe(50_000)
    expect(m.baseline + m.history + m.lastTurn).toBe(m.total)
    expect(m.pct).toBeCloseTo(0.25, 5)
    expect(m.zone).toBe("normal")
  })

  it("two results: history is the growth minus the last turn (may be 0)", () => {
    const m = deriveContextMeter([10_000, 25_000], 200_000)!
    expect(m.baseline).toBe(10_000)
    expect(m.lastTurn).toBe(15_000) // 25k - 10k
    expect(m.history).toBe(0)
    expect(m.baseline + m.history + m.lastTurn).toBe(m.total)
  })

  it("clamps segments ≥ 0 and honors the shrink after /compact (new latest = honest total)", () => {
    // grows to 500k then /compact drops it to 120k
    const m = deriveContextMeter([100_000, 500_000, 120_000], 1_000_000)!
    expect(m.total).toBe(120_000) // honest shrunk total
    expect(m.lastTurn).toBe(0) // 120k - 500k clamped to 0, never negative
    expect(m.baseline).toBe(100_000)
    expect(m.history).toBe(20_000) // 120k - 100k - 0
    expect(m.baseline + m.history + m.lastTurn).toBe(m.total)
  })

  it("clamps baseline when the total shrinks BELOW the first footprint", () => {
    const m = deriveContextMeter([100_000, 40_000], 200_000)!
    expect(m.total).toBe(40_000)
    expect(m.lastTurn).toBe(0)
    expect(m.baseline).toBe(40_000) // min(first=100k, total=40k)
    expect(m.history).toBe(0)
    expect(m.baseline + m.history + m.lastTurn).toBe(m.total)
  })

  it("computes pct against the cap and tints the zone at 70% / 90%", () => {
    expect(deriveContextMeter([139_999], 200_000)!.zone).toBe("normal") // just under 70%
    expect(deriveContextMeter([140_000], 200_000)!.zone).toBe("warning") // exactly 70%
    expect(deriveContextMeter([140_001], 200_000)!.zone).toBe("warning")
    expect(deriveContextMeter([180_000], 200_000)!.zone).toBe("danger") // 0.9
    expect(deriveContextMeter([220_000], 200_000)!.pct).toBe(1) // over cap clamps to 1
    expect(deriveContextMeter([220_000], 200_000)!.zone).toBe("danger")
  })

  it("guards a non-positive cap by falling back to the default", () => {
    const m = deriveContextMeter([50_000], 0)!
    expect(m.cap).toBe(DEFAULT_CONTEXT_CAP)
    expect(m.pct).toBeCloseTo(0.25, 5)
  })
})

describe("zoneForPct", () => {
  it("maps fractions to zones", () => {
    expect(zoneForPct(0)).toBe("normal")
    expect(zoneForPct(0.69)).toBe("normal")
    expect(zoneForPct(0.7)).toBe("warning")
    expect(zoneForPct(0.89)).toBe("warning")
    expect(zoneForPct(0.9)).toBe("danger")
    expect(zoneForPct(1)).toBe("danger")
  })
})

describe("contextMeterFromBlocks", () => {
  it("derives the meter end-to-end from folded blocks + a [1m] model", () => {
    const blocks: TranscriptBlock[] = [
      resultBlock("r0", { inputTokens: 50_000, cacheReadTokens: 0, cacheCreationTokens: 0 }),
      resultBlock("r1", { inputTokens: 90_000, cacheReadTokens: 10_000 }),
    ]
    const m = contextMeterFromBlocks(blocks, "opus[1m]")!
    expect(m.cap).toBe(ONE_M_CONTEXT_CAP)
    expect(m.total).toBe(100_000)
    expect(m.baseline).toBe(50_000)
    expect(m.lastTurn).toBe(50_000)
    expect(m.pct).toBeCloseTo(0.1, 5)
  })
  it("returns null when the transcript has no usage-bearing results", () => {
    expect(contextMeterFromBlocks([{ kind: "user", id: "u", text: "x" }], "opus")).toBeNull()
    expect(contextMeterFromBlocks([resultBlock("r0")], "opus")).toBeNull()
  })
})
