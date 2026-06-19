import { describe, it, expect } from "vitest"
import { WORKSPACE_COLORS, autoColor, colorFor } from "./workspaceColors"

describe("autoColor — warm auto-assign palette cycle", () => {
  it("returns the palette color at the given index", () => {
    expect(autoColor(0)).toBe(WORKSPACE_COLORS[0])
    expect(autoColor(1)).toBe(WORKSPACE_COLORS[1])
    expect(autoColor(WORKSPACE_COLORS.length - 1)).toBe(
      WORKSPACE_COLORS[WORKSPACE_COLORS.length - 1],
    )
  })

  it("wraps past the palette length (modulo cycle)", () => {
    const n = WORKSPACE_COLORS.length
    expect(autoColor(n)).toBe(WORKSPACE_COLORS[0])
    expect(autoColor(n + 2)).toBe(WORKSPACE_COLORS[2])
  })

  it("falls back to the first color for negative / NaN indices", () => {
    expect(autoColor(-1)).toBe(WORKSPACE_COLORS[0])
    expect(autoColor(NaN)).toBe(WORKSPACE_COLORS[0])
  })

  it("floors a fractional index", () => {
    expect(autoColor(1.9)).toBe(WORKSPACE_COLORS[1])
  })
})

describe("colorFor — persisted color wins, else auto-color", () => {
  it("prefers a persisted color when present", () => {
    expect(colorFor({ color: "#abcdef" }, 3)).toBe("#abcdef")
  })

  it("auto-colors by index when no color is persisted", () => {
    expect(colorFor({}, 2)).toBe(WORKSPACE_COLORS[2])
    expect(colorFor(undefined, 2)).toBe(WORKSPACE_COLORS[2])
    expect(colorFor(null, 0)).toBe(WORKSPACE_COLORS[0])
  })

  it("ignores an empty-string color (falsy → auto-color)", () => {
    expect(colorFor({ color: "" }, 1)).toBe(WORKSPACE_COLORS[1])
  })
})
