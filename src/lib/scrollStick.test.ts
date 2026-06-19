import { describe, it, expect } from "vitest"
import { isAtBottom, nextScrollTop, scrollFollowBehavior } from "./scrollStick"

describe("isAtBottom", () => {
  it("is true when scrolled to the exact bottom", () => {
    expect(isAtBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 })).toBe(true)
  })

  it("is true within the threshold of the bottom", () => {
    expect(isAtBottom({ scrollTop: 790, scrollHeight: 1000, clientHeight: 200 }, 24)).toBe(true)
  })

  it("is false when the user has scrolled up beyond the threshold", () => {
    expect(isAtBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 200 }, 24)).toBe(false)
  })

  it("is true for content that fits without scrolling", () => {
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 150, clientHeight: 200 })).toBe(true)
  })
})

describe("nextScrollTop", () => {
  it("follows the new bottom when previously pinned to bottom", () => {
    const before = { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 }
    // content grew to 1400 tall, viewport still 200
    expect(nextScrollTop(before, 1400, 200)).toBe(1200)
  })

  it("returns null (leave viewport alone) when the user had scrolled up", () => {
    const before = { scrollTop: 300, scrollHeight: 1000, clientHeight: 200 }
    expect(nextScrollTop(before, 1400, 200)).toBeNull()
  })

  it("does not yank the viewport across repeated growth while scrolled up", () => {
    let before = { scrollTop: 100, scrollHeight: 1000, clientHeight: 200 }
    expect(nextScrollTop(before, 1500, 200)).toBeNull()
    before = { scrollTop: 100, scrollHeight: 1500, clientHeight: 200 }
    expect(nextScrollTop(before, 2000, 200)).toBeNull()
  })
})

describe("scrollFollowBehavior (WS5 instant-vs-smooth)", () => {
  // BO-12 cold-restore regression guard: the always-mounted outer div's scroll
  // effect fires FIRST on the empty initial mount (blocks.length === 0), BEFORE the
  // async on-disk transcript seed commits. That empty settle must NOT consume the
  // one-shot — otherwise the later disk-seed commit (first run WITH blocks) takes the
  // "smooth" branch and animates a full top→bottom SLIDE.
  it("does NOT consume the one-shot on the empty initial mount", () => {
    const r = scrollFollowBehavior(false, 0, false)
    expect(r.markFirstDone).toBe(false) // one-shot untouched — stays available
  })

  // THE FIX: with the empty mount no longer consuming the one-shot, the first NON-
  // EMPTY settle (the BO-12 disk-seed commit) snaps INSTANT. jsdom/node don't animate,
  // so the regression surface is exactly the `behavior` argument: "auto" not "smooth".
  it("snaps the first NON-EMPTY settle instant (BO-12 disk-seed restore does not slide)", () => {
    // Simulate the cold-restore sequence: empty mount fires first (one-shot intact),
    // then the async seed commits with a tall transcript.
    const emptyMount = scrollFollowBehavior(false, 0, false)
    expect(emptyMount.markFirstDone).toBe(false)
    // firstScrollDone is still false → the seed commit is the FIRST non-empty settle.
    const seedCommit = scrollFollowBehavior(emptyMount.markFirstDone, 42, false)
    expect(seedCommit.behavior).toBe("auto") // instant snap — NO top→bottom slide
    expect(seedCommit.markFirstDone).toBe(true)
  })

  // Post-restore streaming: a later same-session settle animates smoothly so the
  // viewport glides with arriving deltas.
  it("smooth-follows a later same-session settle (post-restore streaming intact)", () => {
    const r = scrollFollowBehavior(true, 43, false)
    expect(r.behavior).toBe("smooth")
    expect(r.markFirstDone).toBe(false)
  })

  // Cache-WARM respawn/tab-switch seeds synchronously in the useState initializer, so
  // the very first effect run already has tall content — and snaps instant, unchanged.
  it("snaps instant when content is present on the first settle (cache-warm respawn)", () => {
    const r = scrollFollowBehavior(false, 17, false)
    expect(r.behavior).toBe("auto")
    expect(r.markFirstDone).toBe(true)
  })

  // Reduced-motion always snaps instant, even mid-stream — the explicit smooth
  // scrollTo must opt out of animation when the user asked for none.
  it("always snaps instant under reduced-motion, even on a later settle", () => {
    const r = scrollFollowBehavior(true, 9, true)
    expect(r.behavior).toBe("auto")
  })
})
