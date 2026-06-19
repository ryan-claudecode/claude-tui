import { describe, it, expect } from "vitest"
import { menuNav } from "./menuNav"

// The WorkspaceSwitcher dropdown's keyboard reducer. These exercise the SAME
// key path the live menu now drives (after the MAJOR 3 fix that moves focus into
// the menu so onMenuKeyDown actually fires) — ↑/↓ move the highlight (wrapping),
// Enter activates, Esc closes, everything else passes through.
describe("menuNav — dropdown keyboard navigation", () => {
  // A representative menu: "All" (0), two workspaces (1, 2), "New" (3) → count 4.
  const COUNT = 4

  describe("ArrowDown / ArrowUp move the highlight (wrapping)", () => {
    it("ArrowDown advances by one", () => {
      expect(menuNav("ArrowDown", 0, COUNT)).toEqual({ type: "move", highlight: 1 })
      expect(menuNav("ArrowDown", 2, COUNT)).toEqual({ type: "move", highlight: 3 })
    })

    it("ArrowDown wraps past the last option to the first", () => {
      expect(menuNav("ArrowDown", 3, COUNT)).toEqual({ type: "move", highlight: 0 })
    })

    it("ArrowUp retreats by one", () => {
      expect(menuNav("ArrowUp", 2, COUNT)).toEqual({ type: "move", highlight: 1 })
    })

    it("ArrowUp wraps past the first option to the last", () => {
      expect(menuNav("ArrowUp", 0, COUNT)).toEqual({ type: "move", highlight: 3 })
    })
  })

  describe("Enter activates the highlighted option", () => {
    it("returns an activate intent regardless of which option is highlighted", () => {
      expect(menuNav("Enter", 0, COUNT)).toEqual({ type: "activate" })
      expect(menuNav("Enter", 3, COUNT)).toEqual({ type: "activate" })
    })
  })

  describe("Escape closes the menu", () => {
    it("returns a close intent (the component returns focus to the pill)", () => {
      expect(menuNav("Escape", 1, COUNT)).toEqual({ type: "close" })
    })
  })

  describe("other keys pass through", () => {
    it("returns none for unhandled keys (so they reach the input / browser)", () => {
      expect(menuNav("a", 0, COUNT)).toEqual({ type: "none" })
      expect(menuNav("Tab", 0, COUNT)).toEqual({ type: "none" })
      expect(menuNav(" ", 0, COUNT)).toEqual({ type: "none" })
    })
  })

  describe("empty list (count <= 0)", () => {
    it("ArrowDown/ArrowUp are no-ops (nothing to move to)", () => {
      expect(menuNav("ArrowDown", 0, 0)).toEqual({ type: "none" })
      expect(menuNav("ArrowUp", 0, 0)).toEqual({ type: "none" })
    })

    it("Enter and Escape still resolve with an empty list", () => {
      expect(menuNav("Enter", 0, 0)).toEqual({ type: "activate" })
      expect(menuNav("Escape", 0, 0)).toEqual({ type: "close" })
    })
  })

  it("single-option list: ArrowDown/ArrowUp stay put (wrap to self)", () => {
    expect(menuNav("ArrowDown", 0, 1)).toEqual({ type: "move", highlight: 0 })
    expect(menuNav("ArrowUp", 0, 1)).toEqual({ type: "move", highlight: 0 })
  })
})
