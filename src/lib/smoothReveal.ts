/**
 * CAPP-74 / CAPP-77 — the PURE pacing model for the streamed-text SMOOTHING BUFFER.
 *
 * Problem: streamed Claude tokens arrive in irregular bursts; painting each
 * delta the instant it lands shows that burstiness (text lurches forward in
 * lumps). Fix (what claude.ai / ChatGPT do): don't paint on arrival — keep a
 * REVEALED length that advances via requestAnimationFrame toward the full
 * received ("target") text, reshaping the lumpy INPUT into a steady typewriter
 * OUTPUT.
 *
 * CAPP-77 makes the drain rate ADAPTIVE so the reveal keeps PACE with generation:
 * the buffer tracks recent incoming throughput (chars/sec, EWMA) and drains at
 * `max(floor, matchFactor × inRate)` — a hair faster than the stream, so the
 * visible backlog stays small + bounded near zero and the typewriter finishes
 * ~when the stream finishes. The fixed base rate is now a FLOOR (slow streams
 * still type out at a readable speed); a fast stream is matched, never lagged.
 * The original backlog-scaled catch-up survives as a SAFETY NET for big lumps.
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

/** Tunables for the adaptive-rate drain. All times in ms, rates in chars/sec. */
export interface RevealConfig {
  /**
   * The FLOOR typewriter speed, chars/sec. On a slow / bursty stream the reveal
   * never crawls below this — it's the minimum readable type-out, and it absorbs
   * normal token bursts. CAPP-77: this is now a FLOOR, not the steady rate — a
   * fast stream pushes the effective rate ABOVE it (see the adaptive term in
   * {@link nextRevealedLen}) so a brisk turn is never lagged behind its own output.
   */
  baseRate: number
  /**
   * The MAX standing backlog, expressed as seconds-of-text at the base rate.
   * If the target races ahead of the reveal by more than `baseRate * maxLagSec`
   * characters (a big burst, or a turn that dumped a lot at once), the effective
   * rate scales UP with the backlog so the visible lag stays bounded to roughly
   * this many seconds — we never fall arbitrarily behind the real output. This is
   * the SAFETY NET that complements the adaptive throughput match.
   */
  maxLagSec: number
  /**
   * CAPP-77 — the adaptive match factor. The effective steady rate is at least
   * `matchFactor × recentInRate` (the tracked incoming chars/sec), so the reveal
   * paces slightly FASTER than generation and the visible backlog converges toward
   * zero instead of standing at `maxLagSec`. ~1.1 keeps a hair of lead (evens out
   * within-burst choppiness) while finishing ~when the stream finishes. Should be
   * ≥ 1 for the reveal to keep pace.
   */
  matchFactor: number
}

/**
 * Sensible defaults: floor ~320 cps, never lagging > ~0.35s, and pacing 1.12× the
 * live incoming throughput so a fast stream is matched (not lagged) and the reveal
 * converges to done as the stream ends. The floor governs slow streams; the
 * adaptive term governs fast ones; the backlog cap is the safety net for lumps.
 */
export const DEFAULT_REVEAL_CONFIG: RevealConfig = {
  baseRate: 320,
  maxLagSec: 0.35,
  matchFactor: 1.12,
}

/**
 * Advance the revealed length toward the target by ONE frame's worth of reveal.
 * PURE: given the same inputs it always returns the same next revealed length.
 *
 * CAPP-77 — the per-frame effective rate is the MAX of three terms, then capped by
 * the catch-up safety net, so the reveal both keeps pace with a fast stream AND
 * never crawls on a slow one:
 *  1. the FLOOR `config.baseRate` (readable minimum);
 *  2. the ADAPTIVE match `config.matchFactor × inRate` (pace a hair above the
 *     tracked incoming throughput → backlog converges toward zero, finishes with
 *     the stream);
 *  3. the backlog-scaled CATCH-UP `baseRate × backlog/maxBacklog` (SAFETY NET: if a
 *     big lump pushed the backlog past `baseRate × maxLagSec`, drain proportionally
 *     faster so the visible lag stays bounded — a smooth catch-up, not a snap).
 * The effective rate = max(1, 2, 3); progress this frame = effectiveRate × dt/1000.
 *
 * Rules / clamps:
 *  - Already caught up (revealed >= target) → return target (never over-reveal, and
 *    never go backwards even if the target shrank under us — a transcript reset).
 *  - No time elapsed (dt <= 0) → no progress (catch-up is a function of TIME, not of
 *    merely being called; also guards divide-by-zero / NaN).
 *  - The result is clamped to `target` so we never overshoot the received text.
 *
 * @param targetLen   full received text length (grows as deltas arrive)
 * @param revealedLen currently-revealed length (a FLOAT carried by the caller)
 * @param dtMs        ms elapsed since the previous frame
 * @param config      pacing tunables (defaults to {@link DEFAULT_REVEAL_CONFIG})
 * @param inRate      recent incoming throughput estimate (chars/sec); 0/omitted →
 *                    the adaptive term is inert and the floor + catch-up govern
 * @returns the next revealed length (float, in [revealedLen, targetLen])
 */
export function nextRevealedLen(
  targetLen: number,
  revealedLen: number,
  dtMs: number,
  config: RevealConfig = DEFAULT_REVEAL_CONFIG,
  inRate = 0,
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
  // (1) FLOOR — the readable minimum, also what governs a slow stream.
  const floorRate = config.baseRate
  // (2) ADAPTIVE — pace a hair above the tracked incoming throughput so the
  // backlog converges toward zero and the reveal finishes ~with the stream.
  const matchRate = inRate > 0 ? config.matchFactor * inRate : 0
  // (3) CATCH-UP SAFETY NET — only kicks in above the tolerated backlog cap; below
  // it the multiplier is 1, so it never drags the rate BELOW the floor/adaptive max.
  const speedup = maxBacklog > 0 ? Math.max(1, backlog / maxBacklog) : 1
  const catchUpRate = config.baseRate * speedup
  // Whichever term demands the most reveal this frame wins.
  const effectiveRate = Math.max(floorRate, matchRate, catchUpRate)
  const progress = (effectiveRate * dtMs) / 1000

  const next = revealedLen + progress
  // Never overshoot the received text.
  return next > targetLen ? targetLen : next
}

/**
 * CAPP-77 — a tiny PURE rolling estimator of the incoming throughput (chars/sec)
 * that the adaptive drain paces against. The buffer feeds it (Δchars, Δms) each
 * frame the target grew; it returns an EWMA-smoothed rate, so a single fat delta
 * doesn't spike the reveal and a quiet frame doesn't crater it — the estimate
 * tracks the SUSTAINED stream rate and decays back to ~0 once the stream stops
 * (so the reveal converges to done rather than racing ahead on a stale estimate).
 *
 * Kept as a class (not free fn) so the EWMA state is encapsulated + reusable by
 * RevealClock, and DOM-free so it's unit-testable on its own.
 */
export class ThroughputTracker {
  /** Smoothing factor in (0,1]: higher = more responsive, lower = steadier. */
  private readonly alpha: number
  /** The current EWMA rate estimate (chars/sec), or null until the first sample. */
  private ewma: number | null = null

  /** @param alpha EWMA weight on the newest sample (default 0.3 — steady but live). */
  constructor(alpha = 0.3) {
    this.alpha = alpha
  }

  /**
   * Record one frame's worth of incoming text and return the updated rate estimate.
   * `addedChars` is how much the target grew since the last sample (≥0; a quiet
   * frame is 0 chars, which decays the estimate toward 0); `dtMs` is the elapsed
   * time. A non-positive dt is ignored (no sample) so a zero-length frame can't
   * produce a divide-by-zero / infinite rate.
   */
  sample(addedChars: number, dtMs: number): number {
    if (dtMs <= 0) return this.rate()
    const instant = (Math.max(0, addedChars) * 1000) / dtMs
    this.ewma = this.ewma == null ? instant : this.alpha * instant + (1 - this.alpha) * this.ewma
    return this.ewma
  }

  /** The current rate estimate (chars/sec); 0 before the first sample. */
  rate(): number {
    return this.ewma ?? 0
  }

  /** Forget the estimate (activation / re-kick) so a new turn starts clean. */
  reset(): void {
    this.ewma = null
  }
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
  /** The target length at the previous frame, to measure per-frame incoming growth. */
  private prevTarget = 0
  /** CAPP-77 — the rolling incoming-throughput estimate the adaptive drain paces to. */
  private readonly throughput = new ThroughputTracker()

  /** Activation edge: seed the head start, reset the clock + throughput estimate. */
  start(headStart: number, target: number): void {
    this.revealed = Math.min(headStart, target)
    this.last = null
    this.prevTarget = target
    this.throughput.reset()
  }

  /**
   * One frame at timestamp `ts` against the CURRENT target. dt is measured from the
   * previous frame — the clock survives target growth, so brisk per-frame streaming
   * still produces a real dt and the reveal advances. CAPP-77: the per-frame target
   * growth feeds the throughput tracker, whose estimate is handed to the adaptive
   * drain so the reveal paces to the live stream rate. Returns the new revealed float.
   */
  frame(ts: number, target: number, config: RevealConfig = DEFAULT_REVEAL_CONFIG): number {
    const prev = this.last
    this.last = ts
    const dt = prev == null ? 0 : ts - prev
    if (dt > 0) {
      // Measure how much the received text grew this frame, smooth it into the
      // incoming-rate estimate, then drain at max(floor, matchFactor×inRate, catch-up).
      const added = Math.max(0, target - this.prevTarget)
      const inRate = this.throughput.sample(added, dt)
      this.revealed = nextRevealedLen(target, this.revealed, dt, config, inRate)
    }
    this.prevTarget = target
    return this.revealed
  }

  /**
   * Drop the stale timestamp (teardown / re-kick) without losing progress. The
   * throughput estimate is preserved so a re-kicked dormant loop keeps pacing to the
   * stream it was already tracking; `start()` is where a fresh turn clears it.
   */
  resetClock(): void {
    this.last = null
  }

  /** The current incoming-throughput estimate (chars/sec) — exposed for tests/diag. */
  inRate(): number {
    return this.throughput.rate()
  }

  /** Whether the reveal has drained to the current target (loop can stop). */
  done(target: number): boolean {
    return isFullyRevealed(target, this.revealed)
  }
}
