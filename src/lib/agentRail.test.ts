import { describe, it, expect } from "vitest"
import {
  sumCost,
  formatTokens,
  formatCost,
  formatElapsed,
  deriveNow,
  effectiveRailOpen,
  RAIL_WIDTH_FLOOR,
} from "./agentRail"
import type { TranscriptBlock } from "./agentTranscript"

// Helpers to build the minimal block shapes sumCost reads.
function resultBlock(
  id: string,
  cost?: { costUsd?: number; totalTokens?: number },
): TranscriptBlock {
  return { kind: "result", id, isError: false, cost }
}
function assistantBlock(id: string, text = "hi"): TranscriptBlock {
  return { kind: "assistant", id, text }
}

describe("sumCost", () => {
  it("empty transcript: no cost, no tokens, zero turns", () => {
    expect(sumCost([])).toEqual({ costUsd: undefined, totalTokens: undefined, turns: 0 })
  })

  it("ignores non-result blocks entirely", () => {
    expect(sumCost([assistantBlock("b0"), assistantBlock("b1")])).toEqual({
      costUsd: undefined,
      totalTokens: undefined,
      turns: 0,
    })
  })

  it("sums costUsd + totalTokens across multiple result turns", () => {
    const blocks = [
      assistantBlock("b0"),
      resultBlock("b1", { costUsd: 0.01, totalTokens: 6200 }),
      assistantBlock("b2"),
      resultBlock("b3", { costUsd: 0.0134, totalTokens: 6200 }),
    ]
    const sum = sumCost(blocks)
    expect(sum.turns).toBe(2)
    expect(sum.costUsd).toBeCloseTo(0.0234, 6)
    expect(sum.totalTokens).toBe(12400)
  })

  it("counts a result turn that reported NO cost (turns increments, money stays undefined)", () => {
    // A turn-complete result with no cost still counts as a turn; if NO turn reports a
    // cost, costUsd/totalTokens stay undefined (not a misleading 0).
    const sum = sumCost([resultBlock("b0"), resultBlock("b1")])
    expect(sum.turns).toBe(2)
    expect(sum.costUsd).toBeUndefined()
    expect(sum.totalTokens).toBeUndefined()
  })

  it("mixes turns where only some report cost", () => {
    const sum = sumCost([
      resultBlock("b0", { costUsd: 0.02 }), // no tokens
      resultBlock("b1", { totalTokens: 500 }), // no cost
      resultBlock("b2"), // neither
    ])
    expect(sum.turns).toBe(3)
    expect(sum.costUsd).toBeCloseTo(0.02, 6)
    expect(sum.totalTokens).toBe(500)
  })
})

describe("formatTokens", () => {
  it("formats sub-thousand verbatim (rounded)", () => {
    expect(formatTokens(980)).toBe("980")
    expect(formatTokens(0)).toBe("0")
  })
  it("formats thousands with one decimal + k", () => {
    expect(formatTokens(12400)).toBe("12.4k")
    expect(formatTokens(1000)).toBe("1.0k")
  })
  it("formats millions with one decimal + M", () => {
    expect(formatTokens(2_000_000)).toBe("2.0M")
  })
})

describe("formatCost", () => {
  it("returns null when there is no turn data (resting state)", () => {
    expect(formatCost({ costUsd: undefined, totalTokens: undefined, turns: 0 })).toBeNull()
  })

  it("formats USD (4dp) + compact tokens + turn count", () => {
    expect(formatCost({ costUsd: 0.0234, totalTokens: 12400, turns: 3 })).toBe(
      "$0.0234 · 12.4k tok · 3 turns",
    )
  })

  it("singularizes a single turn", () => {
    expect(formatCost({ costUsd: 0.01, totalTokens: 6200, turns: 1 })).toBe(
      "$0.0100 · 6.2k tok · 1 turn",
    )
  })

  it("shows just the turn count when a turn reported no money", () => {
    expect(formatCost({ costUsd: undefined, totalTokens: undefined, turns: 2 })).toBe("2 turns")
  })
})

describe("formatElapsed", () => {
  it("formats sub-minute as 0:ss with zero-pad", () => {
    expect(formatElapsed(47_000)).toBe("0:47")
    expect(formatElapsed(3_000)).toBe("0:03")
  })
  it("formats minutes:seconds", () => {
    expect(formatElapsed(612_000)).toBe("10:12")
  })
  it("formats past an hour as h:mm:ss", () => {
    expect(formatElapsed(3_661_000)).toBe("1:01:01")
  })
  it("clamps negatives to 0:00", () => {
    expect(formatElapsed(-500)).toBe("0:00")
  })
})

describe("deriveNow", () => {
  it("busy with an activity string surfaces it and pulses", () => {
    expect(deriveNow({ hasTerminal: true, busy: true, activity: "Editing terminals.ts" })).toEqual(
      { state: "busy", label: "Editing terminals.ts", pulsing: true },
    )
  })

  it("busy with no activity falls back to a calm 'Working'", () => {
    expect(deriveNow({ hasTerminal: true, busy: true, activity: null })).toEqual({
      state: "busy",
      label: "Working",
      pulsing: true,
    })
  })

  it("idle with a selected terminal reads 'Ready'", () => {
    expect(deriveNow({ hasTerminal: true, busy: false, activity: "stale" })).toEqual({
      state: "idle",
      label: "Ready",
      pulsing: false,
    })
  })

  it("idle with no terminal reads 'Idle'", () => {
    expect(deriveNow({ hasTerminal: false, busy: false })).toEqual({
      state: "idle",
      label: "Idle",
      pulsing: false,
    })
  })

  it("trims whitespace-only activity to the Working fallback", () => {
    expect(deriveNow({ hasTerminal: true, busy: true, activity: "   " }).label).toBe("Working")
  })
})

describe("effectiveRailOpen", () => {
  it("open at a wide width with no explicit collapse", () => {
    expect(effectiveRailOpen({ collapsed: false, width: 1920 })).toBe(true)
  })

  it("an explicit collapse always wins, even at a wide width", () => {
    expect(effectiveRailOpen({ collapsed: true, width: 1920 })).toBe(false)
  })

  it("auto-collapses below the width floor without an explicit collapse", () => {
    expect(effectiveRailOpen({ collapsed: false, width: RAIL_WIDTH_FLOOR - 1 })).toBe(false)
  })

  it("stays open exactly AT the floor (collapse is strictly below)", () => {
    expect(effectiveRailOpen({ collapsed: false, width: RAIL_WIDTH_FLOOR })).toBe(true)
  })

  it("the saved-open pref does NOT override the width auto-collapse", () => {
    // collapsed=false models a saved "open" pref; a narrow window still collapses,
    // and (critically) the pref itself is untouched — that invariant lives in the
    // component (this asserts the derivation respects width regardless of the pref).
    expect(effectiveRailOpen({ collapsed: false, width: 800 })).toBe(false)
  })
})
