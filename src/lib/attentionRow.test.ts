import { describe, it, expect } from "vitest"
import { formatWaitTime } from "./attentionRow"

describe("formatWaitTime", () => {
  const now = 1_000_000_000_000

  it("renders sub-minute waits in seconds", () => {
    expect(formatWaitTime(now - 0, now)).toBe("0s")
    expect(formatWaitTime(now - 5_000, now)).toBe("5s")
    expect(formatWaitTime(now - 59_000, now)).toBe("59s")
  })

  it("renders whole minutes under an hour", () => {
    expect(formatWaitTime(now - 60_000, now)).toBe("1m")
    expect(formatWaitTime(now - 6 * 60_000, now)).toBe("6m")
    expect(formatWaitTime(now - 59 * 60_000, now)).toBe("59m")
  })

  it("renders hours past an hour", () => {
    expect(formatWaitTime(now - 60 * 60_000, now)).toBe("1h")
    expect(formatWaitTime(now - 3 * 60 * 60_000 + 1000, now)).toBe("2h")
  })

  it("clamps a future/negative elapsed to 0s", () => {
    expect(formatWaitTime(now + 5_000, now)).toBe("0s")
  })

  it("shows 0s when nowMs equals sinceMs (entry just arrived, nowTick just reset)", () => {
    // Regression: when a new entry arrives and nowTick is reset to Date.now() at
    // the same moment, nowMs ≈ sinceMs → elapsed ≈ 0 → "0s" is correct.
    // The bug was that nowTick was NOT reset on entry arrival, so nowMs could be
    // *older* than sinceMs (negative elapsed, also clamped to "0s") and stay
    // there for up to 30s. The fix (setNowTick on attention:updated) keeps nowMs
    // current so the counter advances correctly on the next interval tick.
    expect(formatWaitTime(now, now)).toBe("0s")
    // One tick later (30s), the entry should advance normally.
    expect(formatWaitTime(now, now + 30_000)).toBe("30s")
  })
})
