import { describe, it, expect } from "vitest"
import {
  formatAge,
  findingFreshness,
  deriveFindingRows,
  type WorkspaceFinding,
} from "./workspaceMemoryView"

const NOW = 1_000_000_000_000

function finding(over: Partial<WorkspaceFinding>): WorkspaceFinding {
  return {
    id: "f1",
    text: "a finding",
    createdAt: NOW,
    source: "user",
    status: "active",
    promotedAt: NOW,
    ...over,
  }
}

describe("formatAge (CAPP-94 / U6)", () => {
  it("renders 'just now' for sub-45s deltas", () => {
    expect(formatAge(NOW - 10_000, NOW)).toBe("just now")
    expect(formatAge(NOW, NOW)).toBe("just now")
  })

  it("renders minute / hour / day / week buckets", () => {
    expect(formatAge(NOW - 5 * 60_000, NOW)).toBe("5m ago")
    expect(formatAge(NOW - 3 * 3_600_000, NOW)).toBe("3h ago")
    expect(formatAge(NOW - 2 * 86_400_000, NOW)).toBe("2d ago")
    expect(formatAge(NOW - 4 * 604_800_000, NOW)).toBe("4w ago")
  })

  it("returns '' for an absent/zero/non-finite timestamp", () => {
    expect(formatAge(0, NOW)).toBe("")
    expect(formatAge(-1, NOW)).toBe("")
    expect(formatAge(NaN, NOW)).toBe("")
  })

  it("clamps a future timestamp (clock skew) to 'just now'", () => {
    expect(formatAge(NOW + 60_000, NOW)).toBe("just now")
  })
})

describe("findingFreshness (CAPP-94 / U6)", () => {
  it("an authored finding (createdAt === promotedAt) reads a single 'Added' age", () => {
    const f = finding({ createdAt: NOW - 5 * 60_000, promotedAt: NOW - 5 * 60_000, source: "user" })
    expect(findingFreshness(f, NOW)).toBe("Added 5m ago")
  })

  it("a promoted finding (origin pre-dates promotion) shows BOTH ages", () => {
    const f = finding({
      originSessionId: "s1",
      originNoteId: "n1",
      source: "self",
      createdAt: NOW - 2 * 86_400_000, // found 2d ago
      promotedAt: NOW - 3 * 3_600_000, // promoted 3h ago
    })
    expect(findingFreshness(f, NOW)).toBe("Found 2d ago · promoted 3h ago")
  })

  it("returns '' when there is no usable timestamp", () => {
    const f = finding({ createdAt: 0, promotedAt: 0 })
    expect(findingFreshness(f, NOW)).toBe("")
  })
})

describe("deriveFindingRows (CAPP-94 / U6)", () => {
  it("flags ruled-out findings and resolves the corrector text off supersededBy", () => {
    const findings: WorkspaceFinding[] = [
      finding({ id: "old", text: "wrong claim", status: "superseded", supersededBy: "new" }),
      finding({ id: "new", text: "the right answer", status: "active" }),
    ]
    const rows = deriveFindingRows(findings, NOW)
    expect(rows[0].ruledOut).toBe(true)
    expect(rows[0].correction).toBe("the right answer")
    expect(rows[1].ruledOut).toBe(false)
    expect(rows[1].correction).toBeUndefined()
  })

  it("a superseded finding whose corrector was trimmed renders a BARE strike (no dangling arrow)", () => {
    const findings: WorkspaceFinding[] = [
      // supersededBy points at an id NOT in the list (corrector trimmed on promote).
      finding({ id: "old", text: "wrong claim", status: "superseded", supersededBy: "gone" }),
    ]
    const rows = deriveFindingRows(findings, NOW)
    expect(rows[0].ruledOut).toBe(true)
    expect(rows[0].correction).toBeUndefined()
  })

  it("a superseded finding with NO supersededBy renders a bare strike", () => {
    const rows = deriveFindingRows([finding({ status: "superseded" })], NOW)
    expect(rows[0].ruledOut).toBe(true)
    expect(rows[0].correction).toBeUndefined()
  })
})
