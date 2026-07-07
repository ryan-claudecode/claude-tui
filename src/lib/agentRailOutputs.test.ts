import { describe, it, expect } from "vitest"
import {
  shouldPinToNewest,
  outputGlyph,
  outputRowAction,
  formatOutputTime,
} from "./agentRailOutputs"

describe("agentRailOutputs — shouldPinToNewest", () => {
  it("pins when the viewport is at/near the bottom", () => {
    // scrollHeight - (scrollTop + clientHeight) = 400 - (300 + 100) = 0 → at bottom.
    expect(shouldPinToNewest({ scrollTop: 300, scrollHeight: 400, clientHeight: 100 })).toBe(true)
  })

  it("de-arms (does NOT pin) once the user scrolls up past the threshold", () => {
    // gap = 400 - (100 + 100) = 200 > 24 → scrolled up, leave them reading history.
    expect(shouldPinToNewest({ scrollTop: 100, scrollHeight: 400, clientHeight: 100 })).toBe(false)
  })

  it("content that fits without scrolling counts as pinned (first entries follow)", () => {
    expect(shouldPinToNewest({ scrollTop: 0, scrollHeight: 80, clientHeight: 100 })).toBe(true)
  })
})

describe("agentRailOutputs — row projections", () => {
  it("maps each kind to its glyph", () => {
    expect(outputGlyph("link")).toBe("🔗")
    expect(outputGlyph("file")).toBe("📄")
    expect(outputGlyph("note")).toBe("📝")
  })

  it("gives link→Open, file→Reveal, note→expand (no verb label)", () => {
    expect(outputRowAction({ kind: "link" })).toEqual({ kind: "open", label: "Open" })
    expect(outputRowAction({ kind: "file" })).toEqual({ kind: "reveal", label: "Reveal" })
    expect(outputRowAction({ kind: "note" })).toEqual({ kind: "expand", label: null })
  })
})

describe("agentRailOutputs — formatOutputTime (relative, tz-independent)", () => {
  const now = 1_000_000_000_000
  it("< 1 minute reads 'now'", () => {
    expect(formatOutputTime(now - 30_000, now)).toBe("now")
  })
  it("minutes / hours / days", () => {
    expect(formatOutputTime(now - 5 * 60_000, now)).toBe("5m")
    expect(formatOutputTime(now - 2 * 3_600_000, now)).toBe("2h")
    expect(formatOutputTime(now - 3 * 86_400_000, now)).toBe("3d")
  })
  it("clamps a future ts to 'now' (never negative)", () => {
    expect(formatOutputTime(now + 10_000, now)).toBe("now")
  })
})
