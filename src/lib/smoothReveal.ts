/**
 * CAPP-74 — the PURE pacing model for the streamed-text SMOOTHING BUFFER.
 *
 * Problem: streamed Claude tokens arrive in irregular bursts; painting each
 * delta the instant it lands shows that burstiness (text lurches forward in
 * lumps). Fix (what claude.ai / ChatGPT do): don't paint on arrival — keep a
 * REVEALED length that advances at a CONSTANT rate via requestAnimationFrame
 * toward the full received ("target") text, reshaping the lumpy INPUT into a
 * steady typewriter OUTPUT.
 *
 * This module is the unit-test seam (cf. src/lib/scrollStick.ts → AgentView
 * scroll, src/lib/agentTranscript.ts → the reducer): a side-effect-free, DOM-
 * free function the rAF hook (src/hooks/useSmoothReveal.ts) drives each frame.
 * Zero React / Electron imports.
 *
 * The revealed length is tracked as a FLOAT (so a sub-character-per-frame base
 * rate still accumulates smoothly across frames); the hook floors it for the
 * actual slice length it renders.
 */

/** Tunables for the constant-rate drain. All times in ms, rates in chars/sec. */
export interface RevealConfig {
  /**
   * Steady typewriter speed, chars/sec. ~Few-hundred cps reads as a smooth,
   * readable type-out that comfortably keeps up with normal token streaming
   * (a delta burst is absorbed into the buffer and drained at this rate). Tuned
   * by eye: fast enough not to feel laggy on a brisk turn, slow enough that the
   * burstiness is visibly smoothed.
   */
  baseRate: number
  /**
   * The MAX standing backlog, expressed as seconds-of-text at the base rate.
   * If the target races ahead of the reveal by more than `baseRate * maxLagSec`
   * characters (a big burst, or a turn that dumped a lot at once), the effective
   * rate scales UP with the backlog so the visible lag stays bounded to roughly
   * this many seconds — we never fall arbitrarily behind the real output.
   */
  maxLagSec: number
}

/** Sensible defaults: a brisk-but-smooth ~320 cps, never lagging > ~0.35s. */
export const DEFAULT_REVEAL_CONFIG: RevealConfig = {
  baseRate: 320,
  maxLagSec: 0.35,
}

/**
 * Advance the revealed length toward the target by ONE frame's worth of reveal,
 * with backlog-scaled catch-up. PURE: given the same inputs it always returns
 * the same next revealed length.
 *
 * Rules:
 *  - Already caught up (revealed >= target) → return target (clamped; never
 *    over-reveal, and never go backwards even if target somehow shrank).
 *  - No time elapsed (dt <= 0) → no progress (a zero-length frame reveals nothing,
 *    even when behind — catch-up is a function of TIME, not of being merely called).
 *  - Base progress this frame = `baseRate * dt/1000` characters.
 *  - CATCH-UP: while the backlog exceeds the tolerated cap `baseRate * maxLagSec`,
 *    the effective rate scales UP IN PROPORTION to how far behind we are
 *    (`baseRate * backlog/maxBacklog`), so progress = `effectiveRate * dt/1000`.
 *    Bigger burst → faster drain → the visible lag is pulled back toward
 *    ~`maxLagSec` of text within a few frames (a smooth proportional catch-up, NOT
 *    a jarring instant snap). Below the cap the multiplier is 1, i.e. the steady
 *    base rate governs.
 *  - The result is clamped to `target` so we never overshoot the received text.
 *
 * @param targetLen   full received text length (grows as deltas arrive)
 * @param revealedLen currently-revealed length (a FLOAT carried by the caller)
 * @param dtMs        ms elapsed since the previous frame
 * @param config      pacing tunables (defaults to {@link DEFAULT_REVEAL_CONFIG})
 * @returns the next revealed length (float, in [revealedLen, targetLen])
 */
export function nextRevealedLen(
  targetLen: number,
  revealedLen: number,
  dtMs: number,
  config: RevealConfig = DEFAULT_REVEAL_CONFIG,
): number {
  // Already at (or past) the target — clamp and hold. `Math.min` also guards the
  // degenerate case where the target shrank under us (e.g. a transcript reset):
  // we snap to the new, smaller target rather than revealing a phantom slice.
  if (revealedLen >= targetLen) return targetLen
  // No time elapsed → no progress (and no divide-by-zero / NaN).
  if (dtMs <= 0) return revealedLen

  const backlog = targetLen - revealedLen
  // The standing backlog we tolerate before scaling the rate up (chars).
  const maxBacklog = config.baseRate * config.maxLagSec
  // Catch-up MULTIPLIER: 1 while within the cap; grows with the backlog beyond it,
  // so a big burst drains proportionally faster and the visible lag stays bounded.
  const speedup = maxBacklog > 0 ? Math.max(1, backlog / maxBacklog) : 1
  const effectiveRate = config.baseRate * speedup
  const progress = (effectiveRate * dtMs) / 1000

  const next = revealedLen + progress
  // Never overshoot the received text.
  return next > targetLen ? targetLen : next
}

/**
 * Whether the reveal has fully drained to the target (within a sub-character
 * epsilon, since revealed is a float). The rAF loop uses this to STOP itself once
 * it has caught up — there's nothing left to animate until the next delta grows
 * the target again.
 */
export function isFullyRevealed(targetLen: number, revealedLen: number): boolean {
  return revealedLen >= targetLen - 1e-6
}

/**
 * CAPP-74 — the PURE frame-clock the rAF hook (useSmoothReveal) drives. It owns the
 * dt-bookkeeping + reveal carry that the hook used to inline, factored out so the
 * STALL regression is unit-testable WITHOUT a DOM/jsdom (the repo's hook-test idiom,
 * cf. reconcileSplit in useSplitView). The single responsibility: across a stream
 * of frames, advance the revealed float toward whatever the CURRENT target is — and
 * crucially, KEEP the frame clock across target growth, because the bug that
 * defeated the feature was resetting the clock on every delta (→ dt always 0 →
 * stuck at the head start until the turn-end snap).
 *
 * Lifecycle contract (mirrors the hook):
 *  - `start(headStart, target)` — called on the inactive→active edge: seed the
 *    revealed float to the head start (clamped to target) and reset the clock so the
 *    NEXT frame establishes t0 (dt=0). Resetting the clock happens HERE (activation),
 *    NOT on every delta.
 *  - `frame(ts, target, config)` — one rAF tick at timestamp `ts` against the CURRENT
 *    target. dt is measured from the previous frame's ts (the clock persists across
 *    deltas that grew `target`); a target that grew since the last frame is just a
 *    bigger backlog this frame, never a clock reset. Returns the new revealed float.
 *  - `resetClock()` — drop the stale timestamp (teardown, or re-kicking a dormant
 *    loop) so a long gap isn't counted as one giant frame on resume; revealed is
 *    preserved.
 *  - `done(target)` — caught up to the current target (loop may self-stop).
 *
 * This is the seam: feeding it (ts, target) pairs at ~one delta per frame and
 * asserting `revealed` ADVANCES is exactly the test that fails against the old
 * "reset the clock every delta" wiring and passes against the ref-decoupled hook.
 */
export class RevealClock {
  /** The revealed length as a float (the hook floors it for the rendered slice). */
  revealed = 0
  /** The previous frame's timestamp, or null for a fresh clock (next frame = t0). */
  private last: number | null = null

  /** Activation edge: seed the head start and reset the clock. */
  start(headStart: number, target: number): void {
    this.revealed = Math.min(headStart, target)
    this.last = null
  }

  /**
   * One frame at timestamp `ts` against the CURRENT target. dt is measured from the
   * previous frame — the clock survives target growth, so brisk per-frame streaming
   * still produces a real dt and the reveal advances. Returns the new revealed float.
   */
  frame(ts: number, target: number, config: RevealConfig = DEFAULT_REVEAL_CONFIG): number {
    const prev = this.last
    this.last = ts
    const dt = prev == null ? 0 : ts - prev
    if (dt > 0) {
      this.revealed = nextRevealedLen(target, this.revealed, dt, config)
    }
    return this.revealed
  }

  /** Drop the stale timestamp (teardown / re-kick) without losing progress. */
  resetClock(): void {
    this.last = null
  }

  /** Whether the reveal has drained to the current target (loop can stop). */
  done(target: number): boolean {
    return isFullyRevealed(target, this.revealed)
  }
}
