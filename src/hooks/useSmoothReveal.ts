import { useCallback, useEffect, useRef, useState } from "react"
import {
  DEFAULT_REVEAL_CONFIG,
  RevealClock,
  revealedWordEnd,
  type RevealConfig,
} from "../lib/smoothReveal"

/**
 * A tiny immediate head start (chars) revealed the instant the buffer activates,
 * so the live assistant block's FIRST paint already shows prose + the caret at its
 * edge — never a one-frame empty block between the working row hiding and the rAF
 * loop's first tick. Small enough that it doesn't read as a burst.
 */
export const HEAD_START = 3

/**
 * CAPP-74 — the SMOOTHING-BUFFER hook: runs the requestAnimationFrame drain that
 * turns bursty streamed text into a steady typewriter, and hands AgentView the
 * REVEALED slice of the live assistant block.
 *
 * It owns ONLY the rAF drain (the pure pacing + the frame clock live in
 * src/lib/smoothReveal.ts — `nextRevealedLen` + `RevealClock`, the unit-test seam).
 * CAPP-77: the drain is ADAPTIVE — `RevealClock` tracks the live incoming throughput
 * and the per-frame rate is `max(floor, matchFactor×inRate, catch-up)`, so a fast
 * stream is matched (never lagged) and the reveal finishes ~with the stream; the hook
 * itself is unchanged (it just drives `clock.frame(ts, target, config)` each tick).
 * The contract:
 *  - `active` is true ONLY for the live, current-turn TRAILING assistant block
 *    (AgentView passes `busy && this is the streaming-caret block` && !reduced-
 *    motion). While active, `text` is the full received ("target") text; the hook
 *    reveals chars toward it at the adaptive rate (floor + throughput-match +
 *    catch-up), returning a GROWING prefix slice.
 *  - The instant `active` flips false — turn end (busy→idle), the block settling
 *    behind a tool/result, a terminal switch / re-mount, a HISTORICAL or BO-12-
 *    rehydrated block, or prefers-reduced-motion — the hook returns the FULL text
 *    immediately. So historical/restored transcripts are NEVER replayed as a
 *    typewriter, and a finishing turn drains promptly to its complete text.
 *
 * Frame-clock lifecycle (the fix for the per-frame STALL): the rAF loop's effect
 * depends ONLY on `[active]`, NOT on the growing `target`. The target and config are
 * carried in REFS updated by light effects, so a new delta does NOT restart the rAF
 * effect and does NOT reset the clock — the frame clock (owned by `RevealClock`)
 * SURVIVES every delta, so `dt` is real and the reveal keeps advancing under fast
 * per-frame streaming. (The old code reset the clock on every delta → dt always 0 →
 * stuck at HEAD_START until the turn-end snap.) The loop self-stops when caught up; a
 * separate delta-effect RE-KICKS it if a later delta grows the target while it's gone
 * dormant. The clock is reset ONLY on activation / teardown / re-kick.
 *
 * Returns the string to render (a prefix while draining, the full text once
 * caught up / inactive).
 */
export function useSmoothReveal(
  text: string,
  active: boolean,
  config: RevealConfig = DEFAULT_REVEAL_CONFIG,
): string {
  const target = text.length
  // The frame clock + revealed float (a FLOAT so a sub-char-per-frame base rate
  // still accumulates). The rAF loop mutates `clock.revealed`; `setRevealed` mirrors
  // it into state so the render reflects each frame's progress. Seed the head start at
  // FIRST-RENDER init (not in a post-paint effect) when already active, so the very
  // first paint shows the head-start prose + caret — never a one-frame empty block
  // (the head-start-first-paint fix; the comment's "never empty" claim is now true).
  const clockRef = useRef<RevealClock | null>(null)
  if (clockRef.current == null) {
    clockRef.current = new RevealClock()
    if (active) clockRef.current.revealed = Math.min(target, HEAD_START)
  }
  // CAPP-78 (monotonicity) — the previously-returned word-reveal END, fed back into
  // `revealedWordEnd` so the snapped reveal is MONOTONIC NON-DECREASING: a fresh trailing
  // partial that lands after a whole word was released can DELAY a not-yet-shown partial
  // but can NEVER re-hide already-shown chars (the catch-up→delta re-hide flicker fix).
  // Reset to 0 on the activation edge (new turn) and when inactive (the full text shows).
  const prevShownRef = useRef(0)
  const [, setRevealed] = useState(0)
  const rafRef = useRef<number | null>(null)
  // The current target length + config, kept in REFS so a delta growing the target
  // (or a config change) does NOT restart the rAF effect — which would reset the
  // frame clock. The rAF loop reads these each tick; light effects keep them fresh.
  const targetRef = useRef(target)
  const configRef = useRef(config)
  configRef.current = config

  // Keep the live target in a ref WITHOUT restarting the rAF loop. This is the
  // decoupling: the heavy animation effect no longer lists `target` in its deps, so
  // a delta can grow the target every frame without ever resetting the clock.
  useEffect(() => {
    targetRef.current = target
  }, [target])

  // One shared rAF tick: advance the float reveal by the elapsed dt (via the clock),
  // paint, and either schedule the next frame or self-stop when caught up.
  const tick = useCallback((ts: number) => {
    const clock = clockRef.current!
    clock.frame(ts, targetRef.current, configRef.current)
    setRevealed(clock.revealed)
    if (!clock.done(targetRef.current)) {
      rafRef.current = requestAnimationFrame(tick)
    } else {
      // Caught up: stop. The delta-effect re-kicks the loop if a later delta grows
      // the target while we're still active.
      rafRef.current = null
    }
  }, [])

  // When inactive, snap revealed to the full text synchronously (no animation):
  // historical / settled / rehydrated / reduced-motion all render INSTANTLY and
  // fully. Keeps the returned value full on the very next render after `active`
  // drops (the turn-end drain).
  useEffect(() => {
    if (!active) {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      const clock = clockRef.current!
      clock.resetClock()
      clock.revealed = target
      // The full text shows when inactive; reset the monotonic floor so the NEXT
      // activation (a new turn) starts its word-reveal from 0, not the prior turn's end.
      prevShownRef.current = target
      setRevealed(target)
    }
  }, [active, target])

  // The rAF drain loop. Depends ONLY on [active] — NEVER on the growing target — so
  // a per-frame delta can't tear down and restart it (the stall). The loop runs for
  // the whole active turn, reading the live `targetRef` each tick; it self-stops
  // when caught up and is re-kicked by the delta-effect below.
  useEffect(() => {
    if (!active) return
    const clock = clockRef.current!
    // Guard environments without rAF (SSR / tests rendering to static markup):
    // nothing to animate, so reveal everything.
    if (typeof requestAnimationFrame !== "function") {
      clock.revealed = targetRef.current
      setRevealed(clock.revealed)
      return
    }
    // Activation edge: seed a small head start and PAINT it now (setRevealed) so the
    // FIRST non-empty paint already shows the head-start prose + caret — no leading
    // empty block while we wait for the first rAF tick (whose dt=0 yields no paint).
    clock.start(HEAD_START, targetRef.current)
    // New turn → reset the monotonic word-reveal floor so it doesn't carry a stale end.
    prevShownRef.current = 0
    setRevealed(clock.revealed)
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      // Drop the stale frame timestamp so a re-activated loop computes dt fresh (a
      // long pause between turns must not count as one giant frame on resume).
      clock.resetClock()
    }
  }, [active, tick])

  // Delta-effect: when a new delta grows the target while we're active but the loop
  // has gone DORMANT (caught up and self-stopped), re-kick it so the fresh backlog
  // animates. Because the rAF effect doesn't depend on `target`, nothing else would
  // restart a dormant loop. A still-running loop (rafRef != null) is left untouched
  // so its clock keeps ticking; we only resume a stopped one, with a fresh clock so
  // the dormant gap isn't counted as a single frame.
  useEffect(() => {
    if (!active) return
    if (typeof requestAnimationFrame !== "function") return
    if (rafRef.current != null) return // loop already running — it reads targetRef
    const clock = clockRef.current!
    if (clock.done(targetRef.current)) return // nothing new to animate
    clock.resetClock()
    rafRef.current = requestAnimationFrame(tick)
  }, [target, active, tick])

  if (!active) return text
  // No rAF (SSR / static-markup tests): effects never ran to seed/animate the
  // reveal, so render the FULL text rather than a stuck-empty slice.
  if (typeof requestAnimationFrame !== "function") return text
  const shown = Math.floor(Math.min(clockRef.current.revealed, targetRef.current))
  // CAPP-78 — snap the char-granular reveal DOWN to the last whole word so the trailing
  // partial word stays hidden until complete: words pop in instead of letters streaming,
  // killing the constant-rate drain's mechanical staccato. `revealedWordEnd` makes that
  // MONOTONIC (never re-hides an already-shown word when a fresh partial lands — the
  // catch-up→delta flicker fix), streams long boundary-less runs (URLs / CJK) char-by-
  // char instead of stalling at 0, and reveals the first word promptly (head-start
  // reconcile). Released in full the instant the drain catches the target.
  const end = revealedWordEnd(text, shown, targetRef.current, prevShownRef.current)
  prevShownRef.current = end
  return text.slice(0, end)
}
