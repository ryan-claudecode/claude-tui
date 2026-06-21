import { describe, it, expect } from "vitest"
import {
  DEFAULT_REVEAL_CONFIG,
  isFullyRevealed,
  MAX_WORD_HOLDBACK,
  nextRevealedLen,
  revealedWordEnd,
  snapToWordBoundary,
  ThroughputTracker,
  type RevealConfig,
} from "./smoothReveal"

/**
 * CAPP-74 / CAPP-77 — the PURE pacing model for the streamed-text smoothing buffer.
 * These tests pin the floor rate, the backlog-scaled catch-up safety net, the
 * CAPP-77 ADAPTIVE throughput match (rate tracks the incoming chars/sec and stays ≥
 * output so the backlog converges near zero), the drain-to-target on a large frame,
 * and the clamps — the seam the rAF hook (useSmoothReveal) drives. DOM-free,
 * deterministic.
 */

// A small explicit config so the arithmetic is easy to reason about: 100 cps FLOOR,
// tolerate at most 0.1s of backlog (= 10 chars standing), match 1.2× the incoming rate.
const CFG: RevealConfig = { baseRate: 100, maxLagSec: 0.1, matchFactor: 1.2 }

describe("nextRevealedLen — constant base rate", () => {
  it("advances baseRate * dt/1000 chars per frame when within the backlog cap", () => {
    // target only a little ahead (backlog 5 < maxBacklog 10) → base rate governs.
    // 100 cps over 100ms = 10 chars, but clamped to the target (revealed+5).
    expect(nextRevealedLen(5, 0, 100, CFG)).toBe(5)
    // A 16ms frame (~one rAF tick) with backlog 8 < cap 10: 100 * 16/1000 = 1.6 chars.
    expect(nextRevealedLen(8, 0, 16, CFG)).toBeCloseTo(1.6, 5)
  })

  it("accumulates a sub-char-per-frame base rate across frames (float carry)", () => {
    // Target within the backlog cap (8 < maxBacklog 10) so the BASE rate governs.
    // Two 16ms frames at 100cps = 3.2 chars total — the float carry, not 0 then 0.
    let r = nextRevealedLen(8, 0, 16, CFG)
    r = nextRevealedLen(8, r, 16, CFG)
    expect(r).toBeCloseTo(3.2, 5)
  })

  it("is roughly constant-rate over many uniform frames (smooths a steady target)", () => {
    // Target already far ahead but we measure the BASE behavior under the cap by
    // keeping the backlog small each step (simulate target growing in step with reveal).
    let revealed = 0
    let target = 0
    const frames = 30
    const dt = 16
    for (let i = 0; i < frames; i++) {
      target += (CFG.baseRate * dt) / 1000 // target grows at exactly the base rate
      revealed = nextRevealedLen(target, revealed, dt, CFG)
    }
    // With target and reveal both moving at the base rate, the reveal tracks it
    // closely (within the head room), i.e. output rate ≈ base rate — smooth.
    expect(revealed).toBeCloseTo(target, 5)
  })
})

describe("nextRevealedLen — backlog-scaled catch-up", () => {
  it("scales the rate UP when the backlog exceeds the cap (proportional speedup)", () => {
    // Big burst: target 200 ahead, far over the 10-char cap. speedup = 200/10 = 20×,
    // so a 16ms frame reveals 20× the base (1.6) = 32 chars — much more than base.
    const r = nextRevealedLen(200, 0, 16, CFG)
    expect(r).toBeCloseTo(32, 5)
    // …and that is 20× the base-rate progress (the catch-up multiplier).
    const base = nextRevealedLen(8, 0, 16, CFG) // within-cap → base rate
    expect(r).toBeCloseTo(base * 20, 5)
  })

  it("converges the standing backlog back toward ~maxLagSec of text across frames", () => {
    // A single huge dump drained frame-by-frame: the proportional catch-up pulls the
    // backlog DOWN every frame and converges toward the cap (smooth, not a one-frame snap).
    const target = 5000
    const maxBacklog = CFG.baseRate * CFG.maxLagSec
    let revealed = 0
    let prevBacklog = target
    for (let i = 0; i < 200; i++) {
      revealed = nextRevealedLen(target, revealed, 16, CFG)
      const backlog = target - revealed
      expect(backlog).toBeLessThanOrEqual(prevBacklog) // monotonically shrinking
      prevBacklog = backlog
    }
    // After enough frames it has converged to roughly the tolerated cap.
    expect(target - revealed).toBeLessThanOrEqual(maxBacklog * 1.5)
  })

  it("a catch-up frame reveals strictly more than the base rate would", () => {
    const over = nextRevealedLen(500, 0, 16, CFG) // backlog 500 ≫ cap → sped up
    const base = nextRevealedLen(8, 0, 16, CFG) // within cap → base rate
    expect(over).toBeGreaterThan(base)
  })
})

describe("nextRevealedLen — CAPP-77 adaptive throughput match", () => {
  it("paces ABOVE the floor when the incoming rate exceeds it (matchFactor × inRate)", () => {
    // Incoming 500 cps ≫ the 100cps floor. Backlog kept small (8 < cap 10) so the
    // catch-up multiplier is 1 → the ADAPTIVE term governs: matchFactor 1.2 × 500 =
    // 600 cps. Over 16ms that's 600 * 16/1000 = 9.6 chars (clamped only by target).
    const r = nextRevealedLen(8, 0, 16, CFG, 500)
    // …but it's clamped to the target (8) since 9.6 > backlog.
    expect(r).toBe(8)
    // With more headroom (target far ahead but backlog still under the cap is
    // impossible; instead verify the rate directly at a tiny dt where it won't clamp):
    // 600 cps over 10ms = 6 chars, target 100 (clamp irrelevant).
    expect(nextRevealedLen(100, 90, 10, CFG, 500)).toBeCloseTo(96, 5)
  })

  it("never drops BELOW the floor when the incoming rate is slow", () => {
    // Trickle stream: 20 cps incoming, well under the 100cps floor. Backlog kept small
    // (revealed 95, target 100 → backlog 5 < cap 10) so catch-up stays inert and we
    // isolate the floor-vs-adaptive choice. matchRate = 1.2*20 = 24 < floor 100 → the
    // FLOOR wins: the reveal types at 100 cps, not the 20 cps trickle (readability).
    const slow = nextRevealedLen(100, 95, 16, CFG, 20)
    const floorOnly = nextRevealedLen(100, 95, 16, CFG, 0)
    expect(slow).toBeCloseTo(floorOnly, 5)
    expect(slow).toBeCloseTo(95 + 1.6, 5) // 95 + 100 cps * 16ms
  })

  it("keeps the visible backlog bounded NEAR ZERO under a fast steady stream (converges)", () => {
    // Stream at a steady 600 cps (far above the floor) for a long turn, feeding the
    // matching incoming-rate estimate each frame. Because the reveal paces at
    // matchFactor(1.2) × 600 = 720 cps > the 600 input rate, the backlog DRAINS toward
    // zero rather than standing at maxLagSec — the reveal keeps pace and converges.
    const dt = 16
    const inRate = 600
    const perFrameIn = (inRate * dt) / 1000 // chars added per frame
    let revealed = 0
    let target = 0
    const FRAMES = 200
    let maxBacklog = 0
    for (let i = 0; i < FRAMES; i++) {
      target += perFrameIn
      revealed = nextRevealedLen(target, revealed, dt, CFG, inRate)
      maxBacklog = Math.max(maxBacklog, target - revealed)
    }
    // Steady-state backlog is tiny — a fast stream is matched, not lagged. With a
    // 1.2× over-rate the standing lag collapses to ~0 (the reveal outruns the input).
    const endBacklog = target - revealed
    expect(endBacklog).toBeLessThanOrEqual(perFrameIn + 1e-6) // ≤ one frame of input
    // And it was never allowed to balloon mid-stream either.
    expect(maxBacklog).toBeLessThan(inRate * 0.2) // < 0.2s of text, ever
  })

  it("converges to DONE as the stream stops (input goes quiet → reveal finishes)", () => {
    // Fast stream for a while, then the input STOPS but the incoming-rate estimate is
    // still nonzero (stale). The reveal must still drain to full (it paces ≥ the floor),
    // not stall waiting for more input. Simulate: target frozen, keep ticking frames.
    let revealed = 50
    const target = 100
    // A handful of frames at the floor finish the remaining 50 chars: 100cps → 0.5s.
    let inRate = 600
    for (let i = 0; i < 40; i++) {
      revealed = nextRevealedLen(target, revealed, 16, CFG, inRate)
      inRate *= 0.7 // the EWMA would decay as quiet frames arrive (no new chars)
    }
    expect(isFullyRevealed(target, revealed)).toBe(true)
  })

  it("catch-up safety net still applies over the adaptive term for a big lump", () => {
    // A single huge dump (backlog 5000 ≫ cap) with a MODEST incoming-rate estimate.
    // The backlog-proportional catch-up must dominate so the lump drains fast — the
    // adaptive match alone (1.2 × modest rate) would be far too slow for the lump.
    const withCatchup = nextRevealedLen(5000, 0, 16, CFG, 50)
    const adaptiveOnly = (CFG.matchFactor * 50 * 16) / 1000 // 1.2*50*0.016 = 0.96 chars
    expect(withCatchup).toBeGreaterThan(adaptiveOnly * 10) // catch-up dominates by far
  })
})

describe("nextRevealedLen — drain & clamps", () => {
  it("reaches the target on a large dt (turn-end / tab-return drain)", () => {
    // A long frame (e.g. resumed after the loop slept) drains straight to full.
    expect(nextRevealedLen(500, 100, 100_000, CFG)).toBe(500)
  })

  it("never overshoots the target", () => {
    expect(nextRevealedLen(10, 8, 100_000, CFG)).toBe(10)
  })

  it("clamps to target and never goes backwards if already caught up", () => {
    expect(nextRevealedLen(10, 10, 16, CFG)).toBe(10)
    expect(nextRevealedLen(10, 12, 16, CFG)).toBe(10) // target shrank → snap down, no phantom
  })

  it("treats a non-positive dt as zero progress (no backwards / NaN)", () => {
    expect(nextRevealedLen(50, 20, 0, CFG)).toBe(20)
    expect(nextRevealedLen(50, 20, -5, CFG)).toBe(20)
  })

  it("works with the shipped DEFAULT_REVEAL_CONFIG (sane, advancing)", () => {
    const r = nextRevealedLen(1000, 0, 16, DEFAULT_REVEAL_CONFIG)
    expect(r).toBeGreaterThan(0)
    expect(r).toBeLessThan(1000)
  })
})

describe("ThroughputTracker — CAPP-77 incoming-rate estimate", () => {
  it("estimates the steady incoming rate (chars/sec) from per-frame samples", () => {
    const t = new ThroughputTracker()
    // 8 chars every 16ms = 500 cps, fed repeatedly. The EWMA converges to ~500.
    let rate = 0
    for (let i = 0; i < 50; i++) rate = t.sample(8, 16)
    expect(rate).toBeCloseTo(500, 0)
    expect(t.rate()).toBeCloseTo(500, 0)
  })

  it("smooths a single fat delta (does NOT spike to the instant rate)", () => {
    const t = new ThroughputTracker(0.3)
    // Warm up at a steady 100 cps (1.6 chars/16ms).
    for (let i = 0; i < 40; i++) t.sample(1.6, 16)
    const steady = t.rate()
    expect(steady).toBeCloseTo(100, 0)
    // One fat 160-char delta in a 16ms frame = an instantaneous 10000 cps. The EWMA
    // moves toward it but is nowhere near the raw spike (smoothed, not a lurch).
    const afterSpike = t.sample(160, 16)
    expect(afterSpike).toBeGreaterThan(steady)
    expect(afterSpike).toBeLessThan(10000 * 0.5) // far below the instant 10000 cps
  })

  it("decays toward ~0 as the stream goes quiet (0-char frames)", () => {
    const t = new ThroughputTracker(0.4)
    for (let i = 0; i < 30; i++) t.sample(8, 16) // ramp up to 500 cps
    expect(t.rate()).toBeGreaterThan(400)
    // Input stops: a run of empty frames decays the estimate toward zero, so the
    // adaptive drain stops racing ahead on a stale rate and converges to done.
    let rate = t.rate()
    for (let i = 0; i < 40; i++) rate = t.sample(0, 16)
    expect(rate).toBeLessThan(10) // collapsed toward 0
  })

  it("ignores a non-positive dt (no divide-by-zero / infinite rate)", () => {
    const t = new ThroughputTracker()
    expect(t.sample(100, 0)).toBe(0) // no sample taken, rate stays at the initial 0
    t.sample(8, 16)
    const r = t.rate()
    expect(t.sample(100, 0)).toBe(r) // a 0-dt frame leaves the estimate untouched
    expect(t.sample(100, -5)).toBe(r)
  })

  it("reset() forgets the estimate so a new turn starts clean", () => {
    const t = new ThroughputTracker()
    for (let i = 0; i < 20; i++) t.sample(8, 16)
    expect(t.rate()).toBeGreaterThan(0)
    t.reset()
    expect(t.rate()).toBe(0)
  })
})

describe("snapToWordBoundary — CAPP-78 word-granular reveal", () => {
  // Snaps the char-granular revealed length DOWN to the last whole word, so the
  // trailing partial word being typed stays hidden until it's complete — words pop
  // in instead of letters streaming in, killing the letter-by-letter "typewriter"
  // staccato. The trailing partial is ALWAYS released once the reveal catches up to
  // the target (so no word is ever stranded hidden).

  it("hides the trailing partial word mid-stream (backs up to the last whole word)", () => {
    // "hello world", cut at 8 = inside "world" (…wo|rld). Back up to just after the
    // space at index 5 → 6, i.e. slice "hello ". "world" stays hidden until complete.
    expect(snapToWordBoundary("hello world", 8, 11)).toBe(6)
  })

  it("leaves a cut that already sits at a word boundary untouched", () => {
    // Next hidden char is the space → "hello" is a complete word, keep all 5.
    expect(snapToWordBoundary("hello world", 5, 11)).toBe(5)
    // Last shown char is the space, the next word has 0 chars shown → keep 6.
    expect(snapToWordBoundary("hello world", 6, 11)).toBe(6)
  })

  it("releases the trailing partial word once caught up to the target", () => {
    // Stream paused mid-word and the reveal caught up (shown === target): show it all,
    // never strand the final partial word behind the boundary snap.
    expect(snapToWordBoundary("hello wor", 9, 9)).toBe(9)
    // Also when shown has run to/over the full text.
    expect(snapToWordBoundary("hello world", 11, 11)).toBe(11)
  })

  it("shows nothing until the very first word completes (no prior whitespace)", () => {
    // Cut inside the first word with no earlier whitespace to back up to → 0.
    expect(snapToWordBoundary("hello world", 3, 11)).toBe(0)
  })

  it("treats a newline as a word boundary (won't split a word across lines)", () => {
    // "foo\nbar", cut at 5 = inside "bar". Back up past the newline at index 3 → 4.
    expect(snapToWordBoundary("foo\nbar", 5, 7)).toBe(4)
  })

  it("clamps a non-positive shown to 0", () => {
    expect(snapToWordBoundary("hello", 0, 5)).toBe(0)
    expect(snapToWordBoundary("hello", -3, 5)).toBe(0)
  })
})

describe("revealedWordEnd — CAPP-78 MONOTONIC word reveal (BLOCKER 1 fix)", () => {
  // `revealedWordEnd` wraps the raw word-snap so the revealed END is MONOTONIC
  // NON-DECREASING across frames: the word-snap may only DELAY a not-yet-shown trailing
  // partial, never RE-HIDE already-shown chars. It also streams long boundary-less runs
  // (URLs / CJK) instead of stalling at 0, and reveals the first word promptly.

  // Drive a realistic catch-up→delta sequence: each frame has a (text, shown, target).
  // The drain catches a word fully (shown === target) then the next delta grows target
  // with a fresh trailing partial and shown ticks up behind it. This is the exact cycle
  // the raw snap re-hides on. Sequence over "hello world foo":
  // The key re-hide trigger: the drain CATCHES UP while a trailing partial word is the
  // current edge (shown === target shows a half-word, e.g. "hello wor"), so that partial
  // is RELEASED; then the next delta EXTENDS that same word ("hello world"), and the raw
  // snap — with shown still mid the now-longer word — drops BACK to the previous space
  // (9 → 6), re-hiding the "wor" the user already saw. That backwards step is the flicker.
  type Frame = { text: string; shown: number; target: number }
  const catchUpThenDelta: Frame[] = [
    { text: "hello", shown: 3, target: 5 }, // first word mid-type
    { text: "hello", shown: 5, target: 5 }, // caught up → "hello" fully shown
    { text: "hello wor", shown: 7, target: 9 }, // delta: new partial "wor" streaming
    { text: "hello wor", shown: 9, target: 9 }, // caught up → "wor" RELEASED (partial shown)
    { text: "hello world", shown: 9, target: 11 }, // delta extends "wor"→"world"; raw RE-HIDES to 6
    { text: "hello world", shown: 11, target: 11 }, // caught up → "world" fully shown
    { text: "hello world fo", shown: 12, target: 14 }, // delta: new partial "fo"
    { text: "hello world foo", shown: 14, target: 15 }, // grows; raw re-hides "fo" again
    { text: "hello world foo", shown: 15, target: 15 }, // caught up → all shown
  ]

  it("is MONOTONIC NON-DECREASING across a catch-up→delta sequence (never re-hides)", () => {
    let prev = 0
    const ends: number[] = []
    for (const f of catchUpThenDelta) {
      const end = revealedWordEnd(f.text, f.shown, f.target, prev)
      ends.push(end)
      // The shown length NEVER decreases frame-to-frame — the core invariant.
      expect(end).toBeGreaterThanOrEqual(prev)
      prev = end
    }
    // And the FINAL text fully reveals at the end of the stream.
    expect(ends[ends.length - 1]).toBe(15)
  })

  it("REGRESSION: the raw snapToWordBoundary GOES BACKWARDS on the same sequence", () => {
    // The negative control — the shipped non-monotonic snap. After "hello" releases fully
    // (snap returns 5), the next delta's partial makes the raw snap drop BACK to 6 then,
    // crucially, a frame where the new partial has no completed word yet makes it shrink
    // below the prior shown. We assert at least one frame-to-frame DECREASE exists.
    let prev = 0
    let sawDecrease = false
    for (const f of catchUpThenDelta) {
      const raw = snapToWordBoundary(f.text, f.shown, f.target)
      if (raw < prev) sawDecrease = true
      prev = raw
    }
    expect(sawDecrease).toBe(true) // proves the raw snap re-hides released text
    // …and the monotonic wrapper has ZERO decreases on the identical input (contrast).
    let mPrev = 0
    let mDecrease = false
    for (const f of catchUpThenDelta) {
      const end = revealedWordEnd(f.text, f.shown, f.target, mPrev)
      if (end < mPrev) mDecrease = true
      mPrev = end
    }
    expect(mDecrease).toBe(false)
  })

  it("releases the full text at turn end (shown caught up to target)", () => {
    // No matter what was held back, once the drain reaches the target the partial is
    // released in full — never stranded behind the boundary snap.
    expect(revealedWordEnd("the quick brown fox", 19, 19, 10)).toBe(19)
    // Even a half-typed final word at a stream pause releases when shown === target.
    expect(revealedWordEnd("hello wor", 9, 9, 6)).toBe(9)
  })

  it("a transcript reset (target shrank under us) snaps DOWN to the new target", () => {
    // prevShown was 11 but the target reset to 4 → snap to the new target, no phantom.
    expect(revealedWordEnd("test", 4, 4, 11)).toBe(4)
  })

  describe("boundary-less runs stream progressively (no stall at 0)", () => {
    it("a long space-free string (URL) advances char-by-char past the holdback cap", () => {
      // A single space-free token longer than the holdback. With NO whitespace anywhere,
      // the raw snap returns 0 the whole time → nothing shows until it completes. The
      // monotonic wrapper streams it: once the unrevealed run exceeds the cap, it reveals
      // up to `shown`, advancing every frame.
      const url = "https://example.com/" + "a".repeat(200)
      const target = url.length
      let prev = 0
      const ends: number[] = []
      // Drive shown from a few chars up to most of the string.
      for (let shown = 4; shown < target; shown += 10) {
        const end = revealedWordEnd(url, shown, target, prev)
        ends.push(end)
        expect(end).toBeGreaterThanOrEqual(prev)
        prev = end
      }
      // It made real progress (not stuck at 0) — the last revealed end is well past 0.
      expect(ends[ends.length - 1]).toBeGreaterThan(MAX_WORD_HOLDBACK)
      // And the run keeps advancing (strictly more than the first frame).
      expect(ends[ends.length - 1]).toBeGreaterThan(ends[0])
    })

    it("a CJK run with no ASCII whitespace reveals progressively", () => {
      // No /\s/ boundaries anywhere → the raw snap would hold at 0. The wrapper streams it.
      const cjk = "速い茶色のキツネが怠惰な犬を飛び越える".repeat(6) // long, space-free
      const target = cjk.length
      let prev = 0
      let advanced = false
      for (let shown = 2; shown < target; shown += 12) {
        const end = revealedWordEnd(cjk, shown, target, prev)
        if (end > prev) advanced = true
        expect(end).toBeGreaterThanOrEqual(prev)
        prev = end
      }
      expect(advanced).toBe(true)
      expect(prev).toBeGreaterThan(MAX_WORD_HOLDBACK)
    })

    it("REGRESSION: the raw snap is STUCK AT 0 for a boundary-less run", () => {
      const url = "https://example.com/" + "x".repeat(100)
      // Every partial frame of a space-free run snaps to 0 — nothing ever shows.
      for (let shown = 4; shown < url.length; shown += 20) {
        expect(snapToWordBoundary(url, shown, url.length)).toBe(0)
      }
    })
  })

  describe("CAPP-74 HEAD_START reconcile (no empty first paint)", () => {
    it("reveals the first word promptly when it is longer than the head start", () => {
      // First word "Resolving" (9 chars) longer than the 3-char head start. The raw snap
      // returns 0 (no prior whitespace) → an EMPTY first paint. The wrapper reveals what
      // the drain reached (the head start) so the first paint is non-empty.
      const text = "Resolving the issue now"
      const target = text.length
      expect(revealedWordEnd(text, 3, target, 0)).toBe(3) // head start shows, not 0
      expect(revealedWordEnd(text, 5, target, 3)).toBe(5) // first word streams in
    })

    it("REGRESSION: the raw snap shows NOTHING for a head start inside a long first word", () => {
      expect(snapToWordBoundary("Resolving the issue", 3, 19)).toBe(0)
    })
  })
})

describe("isFullyRevealed", () => {
  it("is true at or past target (within float epsilon)", () => {
    expect(isFullyRevealed(10, 10)).toBe(true)
    expect(isFullyRevealed(10, 11)).toBe(true)
    expect(isFullyRevealed(10, 9.9999999)).toBe(true) // within epsilon
  })
  it("is false while still draining", () => {
    expect(isFullyRevealed(10, 9)).toBe(false)
    expect(isFullyRevealed(10, 0)).toBe(false)
  })
})
