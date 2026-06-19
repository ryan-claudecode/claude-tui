import { describe, it, expect } from "vitest"
import { FOCUSABLE_SELECTOR } from "./useFocusTrap"

// Pure logic test — no DOM/jsdom required.
// Verifies the focusable selector string is structurally sound.
describe("FOCUSABLE_SELECTOR", () => {
  it("is a non-empty string", () => {
    expect(typeof FOCUSABLE_SELECTOR).toBe("string")
    expect(FOCUSABLE_SELECTOR.length).toBeGreaterThan(0)
  })

  it("covers anchor, button, input, select, textarea, tabindex", () => {
    expect(FOCUSABLE_SELECTOR).toContain("a[href]")
    expect(FOCUSABLE_SELECTOR).toContain("button:not([disabled])")
    expect(FOCUSABLE_SELECTOR).toContain("input:not([disabled])")
    expect(FOCUSABLE_SELECTOR).toContain("select:not([disabled])")
    expect(FOCUSABLE_SELECTOR).toContain("textarea:not([disabled])")
    expect(FOCUSABLE_SELECTOR).toContain("[tabindex]:not([tabindex='-1'])")
  })

  it("excludes hidden inputs and negative tabindex", () => {
    expect(FOCUSABLE_SELECTOR).toContain(':not([type="hidden"])')
    expect(FOCUSABLE_SELECTOR).toContain("[tabindex]:not([tabindex='-1'])")
  })
})
