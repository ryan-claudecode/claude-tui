import { describe, it, expect } from "vitest"
import { HEAD_START } from "./useSmoothReveal"
import {
  RevealClock,
  isFullyRevealed,
  nextRevealedLen,
  type RevealConfig,
} from "../lib/smoothReveal"

/**
 * CAPP-74 — the rAF SMOOTHING-BUFFER hook (useSmoothReveal) drain, exercised via its
 * pure frame-clock seam `RevealClock`. The repo's hook-test idiom is "test the
 * extracted pure logic, no DOM/jsdom" (cf. reconcileSplit in useSplitView.test) — and
 * since the only available test env is `node` (no jsdom/RTL, no new deps), we drive
 * the SAME `RevealClock` the hook delegates its per-frame math + lifecycle to, with a
 * FAKE frame clock (an explicit timestamp per simulated rAF tick).
 *
 * THE REGRESSION THIS GUARDS: the pre-fix hook listed the growing `target` in its rAF
 * effect's deps; every assistant delta tore down + restarted the effect, and the
 * cleanup reset the frame clock — so under brisk per-frame streaming `dt` was ALWAYS
 * 0 and the reveal STALLED at the HEAD_START (then snapped to full at turn-end). The
 * fix decouples the loop's lifecycle from `target` (carried in a ref) so the clock
 * SURVIVES deltas. `driveFixed` below mirrors the fixed hook (one clock, survives
 * deltas); `driveBuggy` reproduces the OLD wiring (clock reset every delta) — the
 * "advances mid-stream" test PASSES for the fixed driver and demonstrably FAILS for
 * the buggy one, pinning exactly the bug that shipped.
 */

// Easy-to-reason config: 100 cps FLOOR, tolerate ≤0.1s (= 10 chars) of standing
// backlog, CAPP-77 adaptive match 1.2× the tracked incoming rate.
const CFG: RevealConfig = { baseRate: 100, maxLagSec: 0.1, matchFactor: 1.2 }

/** One streamed delta: at wall-clock `ts` (ms), the full received text is `target` chars. */
type Delta = { ts: number; target: number }

/**
 * Drive the FIXED hook's drain: a single `RevealClock` started once on activation,
 * then one `frame(ts, target)` per simulated rAF tick. The clock is NEVER reset
 * between frames (only on start) — exactly what the ref-decoupled effect does, so the
 * frame dt is real even as `target` grows every frame.
 */
function driveFixed(deltas: Delta[], cfg = CFG): number[] {
  const clock = new RevealClock()
  // Activation edge: seed the head start (clamped to the first target), reset clock.
  clock.start(HEAD_START, deltas[0]?.target ?? 0)
  const revealedPerFrame: number[] = []
  for (const { ts, target } of deltas) {
    clock.frame(ts, target, cfg)
    revealedPerFrame.push(clock.revealed)
  }
  return revealedPerFrame
}

/**
 * Reproduce the BUGGY pre-fix wiring: the rAF effect depended on `target`, so each
 * delta restarted it and the cleanup reset the frame clock. We model that as a fresh
 * clock (last=null) every time the target changes → the very next frame sees dt=0.
 * This is the negative control: it MUST stall at the head start under per-frame deltas.
 */
function driveBuggy(deltas: Delta[], cfg = CFG): number[] {
  let revealed = Math.min(HEAD_START, deltas[0]?.target ?? 0)
  let last: number | null = null
  let prevTarget = deltas[0]?.target ?? 0
  const revealedPerFrame: number[] = []
  for (const { ts, target } of deltas) {
    // Effect re-ran because target grew → cleanup reset the clock to null.
    if (target !== prevTarget) {
      last = null
      prevTarget = target
    }
    const dt = last == null ? 0 : ts - last
    last = ts
    if (dt > 0) revealed = nextRevealedLen(target, revealed, dt, cfg)
    revealedPerFrame.push(revealed)
  }
  return revealedPerFrame
}

describe("useSmoothReveal — RevealClock drain (rAF seam)", () => {
  it("advances the reveal MID-STREAM under ~one delta per frame (not stuck at HEAD_START)", () => {
    // Brisk streaming: a delta lands on (nearly) every 16ms frame, growing the target
    // by ~3 chars/frame — the exact case the pre-fix stall broke. Build 20 frames.
    const deltas: Delta[] = []
    for (let i = 0; i < 20; i++) {
      deltas.push({ ts: 16 * (i + 1), target: 5 + 3 * (i + 1) })
    }
    const fixed = driveFixed(deltas)
    // It must climb well past the 3-char head start by mid-stream — the feature works.
    const mid = fixed[10]
    expect(mid).toBeGreaterThan(HEAD_START + 5)
    // Strictly increasing across frames (a steady type-out, never frozen).
    for (let i = 1; i < fixed.length; i++) {
      expect(fixed[i]).toBeGreaterThanOrEqual(fixed[i - 1])
    }
    expect(fixed[fixed.length - 1]).toBeGreaterThan(fixed[0])
  })

  it("REGRESSION: the pre-fix per-delta clock reset STALLS at the head start", () => {
    // Same brisk per-frame stream through the buggy wiring: because the clock reset on
    // every delta, dt is always 0 → no progress → stuck at HEAD_START. This is the
    // negative control that proves the test would FAIL against the shipped bug.
    const deltas: Delta[] = []
    for (let i = 0; i < 20; i++) {
      deltas.push({ ts: 16 * (i + 1), target: 5 + 3 * (i + 1) })
    }
    const buggy = driveBuggy(deltas)
    // Frozen at the head start the entire stream — the defeated feature.
    expect(buggy.every((r) => r === HEAD_START)).toBe(true)
    // And the FIXED driver demonstrably does better on the identical input.
    const fixed = driveFixed(deltas)
    expect(fixed[fixed.length - 1]).toBeGreaterThan(buggy[buggy.length - 1])
  })

  it("keeps the standing backlog BOUNDED under sustained streaming (adaptive match, no runaway)", () => {
    // Stream at ~250 cps (4 chars/frame) — well above the 100cps FLOOR — for a long
    // turn. WITHOUT keeping pace the reveal would fall arbitrarily behind (backlog
    // growing every frame, the ≈3.7s blow-out the reviewer measured). CAPP-77: the
    // clock tracks the incoming rate (~250 cps) and paces at matchFactor 1.2× = 300 cps
    // > the input, so the standing backlog converges toward ZERO and never grows with
    // stream length. (Catch-up remains as the safety net for big lumps.)
    const deltas: Delta[] = []
    let target = 0
    const FRAMES = 120
    for (let i = 0; i < FRAMES; i++) {
      target += 4
      deltas.push({ ts: 16 * (i + 1), target })
    }
    const fixed = driveFixed(deltas)
    const backlogAt = (i: number) => deltas[i].target - fixed[i]
    // Equilibrium: the late-stream backlog is no worse than the mid-stream backlog —
    // it has STABILIZED, not run away (the defeated-feature failure mode).
    const mid = backlogAt(Math.floor(FRAMES / 2))
    const end = backlogAt(FRAMES - 1)
    expect(end).toBeLessThanOrEqual(mid + 1)
    // And the standing lag is small in absolute terms. With CAPP-77's adaptive match
    // pacing ABOVE the input rate, the visible lag is now well under a fifth of a
    // second of text — far tighter than the catch-up-only equilibrium.
    const lagSeconds = end / CFG.baseRate
    expect(lagSeconds).toBeLessThan(0.2)
  })

  it("CAPP-77: a FAST stream is MATCHED — reveal finishes ~when the stream stops (no backlog)", () => {
    // A brisk 500 cps stream (8 chars/frame) for a fixed number of frames, then the
    // input STOPS. The adaptive clock tracks ~500 cps and paces at 1.2× = 600 cps, so
    // it keeps pace throughout and is essentially caught up by the final delta — the
    // typewriter converges to done WITH the stream, not seconds behind it.
    const deltas: Delta[] = []
    let target = 0
    const FRAMES = 80
    for (let i = 0; i < FRAMES; i++) {
      target += 8
      deltas.push({ ts: 16 * (i + 1), target })
    }
    const fixed = driveFixed(deltas)
    const finalTarget = deltas[FRAMES - 1].target
    const finalRevealed = fixed[FRAMES - 1]
    // The backlog at the last streamed frame is at most one frame of input — the reveal
    // is keeping PACE (reveal velocity ≥ output velocity), not building a visible queue.
    expect(finalTarget - finalRevealed).toBeLessThanOrEqual(8 + 1e-6)
  })

  it("CAPP-77: a SLOW stream still types at the FLOOR (never crawls below the incoming rate)", () => {
    // A trickle stream of ~30 cps (~0.48 chars/frame) — under the 100 cps floor — but
    // the reveal trails a target that is already well ahead (a small initial dump the
    // trickle keeps topping up). The reveal must type out at the FLOOR (100 cps), NOT
    // slow to the 30 cps trickle (readability floor). Backlog stays under the cap so
    // catch-up never engages — proving the FLOOR, not catch-up, is what paces it.
    const clock = new RevealClock()
    let target = 9 // a small lead < the 10-char cap so catch-up stays inert
    clock.start(HEAD_START, target)
    clock.frame(0, target, CFG) // t0
    for (let i = 1; i <= 30; i++) {
      target += 0.48 // ~30 cps incoming, keeping a small lead each frame
      clock.frame(16 * i, target, CFG)
    }
    // ~30 frames * 16ms at the 100 cps floor ≈ 48 chars of reveal capacity — far more
    // than the ~14 chars the 30 cps trickle delivered, so the reveal is pinned to the
    // (small) target every frame, i.e. it kept FULL pace at the floor, never crawling.
    expect(clock.inRate()).toBeLessThan(CFG.baseRate) // confirms the input was sub-floor
    expect(isFullyRevealed(target, clock.revealed)).toBe(true) // floor outran the trickle
  })

  it("a delta AFTER a caught-up pause still animates (dormant loop re-kicks)", () => {
    // Phase 1: small target, drain to caught-up (loop would self-stop / go dormant).
    const clock = new RevealClock()
    clock.start(HEAD_START, 10)
    clock.frame(0, 10, CFG) // t0, dt=0
    clock.frame(1000, 10, CFG) // huge dt → drains to the small target
    expect(isFullyRevealed(10, clock.revealed)).toBe(true)
    const caughtUp = clock.revealed

    // Phase 2: a NEW delta grows the target while still active. The hook's delta-
    // effect re-kicks the loop and RESETS the clock (last=null) so the dormant gap
    // isn't billed as one giant frame; the next real frame then advances.
    clock.resetClock() // <- the re-kick reset
    clock.frame(5000, 60, CFG) // first frame after re-kick: dt=0, just sets t0
    expect(clock.revealed).toBe(caughtUp) // no phantom giant jump from the 4s gap
    clock.frame(5016, 60, CFG) // a real 16ms frame now makes progress
    expect(clock.revealed).toBeGreaterThan(caughtUp)
  })

  it("turn-end drains straight to FULL on the next (large) frame (active→false snap proxy)", () => {
    // The hook snaps revealed=target synchronously when active→false; the rAF path's
    // own large-dt frame likewise reaches the target. Both end at the full text.
    const clock = new RevealClock()
    clock.start(HEAD_START, 500)
    clock.frame(0, 500, CFG) // t0
    clock.frame(100_000, 500, CFG) // a long frame drains all the way
    expect(clock.revealed).toBe(500)
    expect(isFullyRevealed(500, clock.revealed)).toBe(true)
  })

  it("head start paints immediately on activation (first revealed = min(HEAD_START, target))", () => {
    const clock = new RevealClock()
    clock.start(HEAD_START, 100)
    // start() seeds the head start BEFORE any frame — the hook setRevealed()s this so
    // the first paint already shows prose + caret (the head-start-first-paint fix).
    expect(clock.revealed).toBe(HEAD_START)

    // A tiny target clamps the head start (never reveal more than exists).
    const tiny = new RevealClock()
    tiny.start(HEAD_START, 1)
    expect(tiny.revealed).toBe(1)
  })

  it("a fresh clock makes no progress on its first frame (dt=0), then advances", () => {
    // Mirrors the rAF contract: the first tick after (re)start only establishes t0.
    const clock = new RevealClock()
    clock.start(HEAD_START, 100)
    const r0 = clock.frame(0, 100, CFG)
    expect(r0).toBe(HEAD_START) // dt=0 → no progress on the first frame
    const r1 = clock.frame(16, 100, CFG)
    expect(r1).toBeGreaterThan(HEAD_START) // second frame has a real dt → advances
  })
})
