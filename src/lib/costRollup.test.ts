import { describe, it, expect } from "vitest"
import { formatCompactMoney, sumSessionsCost } from "./costRollup"

describe("formatCompactMoney (CAPP-129)", () => {
  it("2dp under $10", () => {
    expect(formatCompactMoney(1.237)).toBe("$1.24")
    expect(formatCompactMoney(0.5)).toBe("$0.50")
    expect(formatCompactMoney(9.999)).toBe("$10.00") // rounds up but stays 2dp at the boundary
  })

  it("1dp from $10 up to (not incl.) $100", () => {
    expect(formatCompactMoney(10)).toBe("$10.0")
    expect(formatCompactMoney(42.31)).toBe("$42.3")
    expect(formatCompactMoney(99.94)).toBe("$99.9")
  })

  it("whole dollars at $100 and above", () => {
    expect(formatCompactMoney(100)).toBe("$100")
    expect(formatCompactMoney(142.6)).toBe("$143")
    expect(formatCompactMoney(1234.5)).toBe("$1235")
  })

  it("clamps 0 / negatives to $0.00 (a durable total never renders negative)", () => {
    expect(formatCompactMoney(0)).toBe("$0.00")
    expect(formatCompactMoney(-3.2)).toBe("$0.00")
  })
})

describe("sumSessionsCost (CAPP-129 — workspace rollup)", () => {
  it("sums the durable per-session totals", () => {
    expect(
      sumSessionsCost([{ costUsd: 1.2 }, { costUsd: 3.05 }, { costUsd: 0.75 }]),
    ).toBeCloseTo(5.0, 6)
  })

  it("tolerates sessions with no cost (contributes 0)", () => {
    expect(sumSessionsCost([{ costUsd: 2.5 }, {}, { costUsd: undefined }])).toBeCloseTo(2.5, 6)
  })

  it("an empty list totals 0", () => {
    expect(sumSessionsCost([])).toBe(0)
  })

  it("ignores negative totals defensively (never subtracts)", () => {
    expect(sumSessionsCost([{ costUsd: 4 }, { costUsd: -10 }])).toBeCloseTo(4, 6)
  })
})
