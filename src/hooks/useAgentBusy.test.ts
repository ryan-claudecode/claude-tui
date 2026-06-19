import { describe, it, expect } from "vitest"
import { applyGenerating } from "./useAgentBusy"

// Pure logic test — no DOM/jsdom. Locks in the BO-10 generating-set transitions plus
// the CAPP-49 fix: a terminal:exit (active=false) prunes a killed/respawned id so it
// can't linger in the busy set as a phantom-busy entry.
describe("applyGenerating (BO-10 / CAPP-49 busy set)", () => {
  it("adds an id when it goes active", () => {
    expect([...applyGenerating(new Set(), "t1", true)]).toEqual(["t1"])
  })

  it("removes an id when it goes idle (active=false)", () => {
    expect([...applyGenerating(new Set(["t1", "t2"]), "t1", false)]).toEqual(["t2"])
  })

  it("removes an id on exit (active=false) — CAPP-49 phantom-busy prune", () => {
    expect([...applyGenerating(new Set(["t1"]), "t1", false)]).toEqual([])
  })

  it("returns the SAME reference when adding an already-present id", () => {
    const prev = new Set(["t1"])
    expect(applyGenerating(prev, "t1", true)).toBe(prev)
  })

  it("returns the SAME reference when removing an absent id (no needless re-render)", () => {
    const prev = new Set(["t1"])
    expect(applyGenerating(prev, "tX", false)).toBe(prev)
  })
})
