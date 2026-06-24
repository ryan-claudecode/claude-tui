import { describe, it, expect } from "vitest"
import {
  initialHiddenCount,
  revealEarlier,
  visibleBlocks,
  INITIAL_WINDOW,
  LOAD_EARLIER_PAGE,
} from "./transcriptWindow"

/**
 * CAPP-103 — the pure render-windowing math for AgentView. Unit-tested as a DOM-free seam
 * (the same pattern as scrollStick.ts) so the windowing logic is verified without a DOM and
 * the flicker-prone component wiring is the only thing left to manual/cross-frame review.
 */

describe("initialHiddenCount", () => {
  it("hides nothing when the conversation fits the window", () => {
    expect(initialHiddenCount(0, 80)).toBe(0)
    expect(initialHiddenCount(80, 80)).toBe(0) // exactly the window → nothing hidden
    expect(initialHiddenCount(10, 80)).toBe(0)
  })

  it("hides everything beyond the most-recent window", () => {
    expect(initialHiddenCount(81, 80)).toBe(1)
    expect(initialHiddenCount(500, 80)).toBe(420)
    expect(initialHiddenCount(2000, 100)).toBe(1900)
  })

  it("defaults to INITIAL_WINDOW", () => {
    expect(initialHiddenCount(INITIAL_WINDOW)).toBe(0)
    expect(initialHiddenCount(INITIAL_WINDOW + 5)).toBe(5)
  })

  it("is safe for a degenerate / non-finite total", () => {
    expect(initialHiddenCount(-3, 80)).toBe(0)
    expect(initialHiddenCount(Number.NaN, 80)).toBe(0)
    expect(initialHiddenCount(Infinity, 80)).toBe(0)
  })
})

describe("revealEarlier", () => {
  it("decreases hidden by a page", () => {
    expect(revealEarlier(420, 80)).toBe(340)
  })

  it("clamps at 0 — the last reveal shows the whole history", () => {
    expect(revealEarlier(50, 80)).toBe(0)
    expect(revealEarlier(0, 80)).toBe(0)
  })

  it("defaults to LOAD_EARLIER_PAGE", () => {
    expect(revealEarlier(LOAD_EARLIER_PAGE + 1)).toBe(1)
    expect(revealEarlier(LOAD_EARLIER_PAGE)).toBe(0)
  })
})

describe("visibleBlocks", () => {
  const blocks = Array.from({ length: 10 }, (_, i) => i) // [0..9]

  it("returns the same array reference when nothing is hidden", () => {
    expect(visibleBlocks(blocks, 0)).toBe(blocks)
    expect(visibleBlocks(blocks, -2)).toBe(blocks)
  })

  it("returns only the tail when older blocks are hidden", () => {
    expect(visibleBlocks(blocks, 7)).toEqual([7, 8, 9])
    expect(visibleBlocks(blocks, 1)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it("clamps an out-of-range hidden count (never throws / never drops to empty unexpectedly)", () => {
    expect(visibleBlocks(blocks, 10)).toEqual([]) // exactly all hidden
    expect(visibleBlocks(blocks, 99)).toEqual([]) // beyond length → clamped to length
  })

  it("the newest block is ALWAYS in the visible tail (streaming-append invariant)", () => {
    // Whatever the hidden count, the last block (the streaming target) is rendered.
    for (const hidden of [0, 3, 9]) {
      const vis = visibleBlocks(blocks, hidden)
      expect(vis[vis.length - 1]).toBe(9)
    }
  })
})
