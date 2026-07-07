import { describe, it, expect } from "vitest"
import {
  railCostFromTerminal,
  formatTokens,
  formatCost,
  formatElapsed,
  deriveNow,
  effectiveRailOpen,
  RAIL_WIDTH_FLOOR,
} from "./agentRail"

describe("railCostFromTerminal (CAPP-129 — durable per-terminal totals → RailCost)", () => {
  it("maps a terminal's durable ref fields onto the RailCost surface", () => {
    expect(
      railCostFromTerminal({ costUsd: 0.0234, costTokens: 12400, costTurns: 3 }),
    ).toEqual({ costUsd: 0.0234, totalTokens: 12400, turns: 3 })
  })

  it("a null/undefined terminal → an empty cost (turns 0, money undefined)", () => {
    expect(railCostFromTerminal(null)).toEqual({
      costUsd: undefined,
      totalTokens: undefined,
      turns: 0,
    })
    expect(railCostFromTerminal(undefined)).toEqual({
      costUsd: undefined,
      totalTokens: undefined,
      turns: 0,
    })
  })

  it("absent cost fields stay undefined (footer shows '—', not a misleading $0) but turns defaults to 0", () => {
    expect(railCostFromTerminal({})).toEqual({
      costUsd: undefined,
      totalTokens: undefined,
      turns: 0,
    })
  })

  it("a terminal with turns but no money keeps turns (formatCost then shows just 'N turns')", () => {
    const cost = railCostFromTerminal({ costTurns: 2 })
    expect(cost).toEqual({ costUsd: undefined, totalTokens: undefined, turns: 2 })
    expect(formatCost(cost)).toBe("2 turns")
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
