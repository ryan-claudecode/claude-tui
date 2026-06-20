import { describe, it, expect } from "vitest"
import {
  DEFAULT_REVEAL_CONFIG,
  isFullyRevealed,
  nextRevealedLen,
  type RevealConfig,
} from "./smoothReveal"

/**
 * CAPP-74 — the PURE pacing model for the streamed-text smoothing buffer. These
 * tests pin the constant-rate drain, the backlog-scaled catch-up cap, the
 * drain-to-target on a large frame, and the clamps — the seam the rAF hook
 * (useSmoothReveal) drives. DOM-free, deterministic.
 */

// A small explicit config so the arithmetic is easy to reason about: 100 cps,
// tolerate at most 0.1s of backlog (= 10 chars standing).
const CFG: RevealConfig = { baseRate: 100, maxLagSec: 0.1 }

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
