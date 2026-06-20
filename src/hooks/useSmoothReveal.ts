import { useEffect, useRef, useState } from "react"
import {
  DEFAULT_REVEAL_CONFIG,
  isFullyRevealed,
  nextRevealedLen,
  type RevealConfig,
} from "../lib/smoothReveal"

/**
 * A tiny immediate head start (chars) revealed the instant the buffer activates,
 * so the live assistant block's FIRST paint already shows prose + the caret at its
 * edge — never a one-frame empty block between the working row hiding and the rAF
 * loop's first tick. Small enough that it doesn't read as a burst.
 */
const HEAD_START = 3

/**
 * CAPP-74 — the SMOOTHING-BUFFER hook: runs the requestAnimationFrame drain that
 * turns bursty streamed text into a steady typewriter, and hands AgentView the
 * REVEALED slice of the live assistant block.
 *
 * It owns ONLY the constant-rate drain (the pure pacing lives in
 * src/lib/smoothReveal.ts). The contract:
 *  - `active` is true ONLY for the live, current-turn TRAILING assistant block
 *    (AgentView passes `busy && this is the streaming-caret block` && !reduced-
 *    motion). While active, `text` is the full received ("target") text; the hook
 *    reveals chars toward it at the base rate (catch-up scaled), returning a
 *    GROWING prefix slice.
 *  - The instant `active` flips false — turn end (busy→idle), the block settling
 *    behind a tool/result, a terminal switch / re-mount, a HISTORICAL or BO-12-
 *    rehydrated block, or prefers-reduced-motion — the hook returns the FULL text
 *    immediately. So historical/restored transcripts are NEVER replayed as a
 *    typewriter, and a finishing turn drains promptly to its complete text.
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
  // The revealed length, carried as a FLOAT across frames so a sub-char-per-frame
  // base rate still accumulates. A ref (mutated by the rAF loop) is the source of
  // truth; `revealed` state mirrors it so the render reflects each frame's progress.
  const revealedRef = useRef(0)
  const [, setRevealed] = useState(0)
  const rafRef = useRef<number | null>(null)
  const lastTsRef = useRef<number | null>(null)
  // Tracks the previous `active` so we can detect the inactive→active edge and
  // seed the head start exactly once per activation.
  const wasActiveRef = useRef(false)

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
      lastTsRef.current = null
      wasActiveRef.current = false
      revealedRef.current = target
      setRevealed(target)
    }
  }, [active, target])

  useEffect(() => {
    if (!active) return
    // Inactive→active edge: seed a small head start so the first paint isn't empty.
    if (!wasActiveRef.current) {
      wasActiveRef.current = true
      revealedRef.current = Math.min(target, HEAD_START)
    }
    // Guard environments without rAF (SSR / tests rendering to static markup):
    // nothing to animate, so reveal everything.
    if (typeof requestAnimationFrame !== "function") {
      revealedRef.current = target
      setRevealed(target)
      return
    }
    // Already caught up to the current target — don't spin a loop until a new
    // delta grows it (the effect re-runs when `target` changes).
    if (isFullyRevealed(target, revealedRef.current)) {
      setRevealed(revealedRef.current)
      return
    }

    const tick = (ts: number) => {
      const last = lastTsRef.current
      lastTsRef.current = ts
      // First frame after (re)start: no dt yet, just schedule the next.
      const dt = last == null ? 0 : ts - last
      if (dt > 0) {
        revealedRef.current = nextRevealedLen(target, revealedRef.current, dt, config)
        setRevealed(revealedRef.current)
      }
      if (!isFullyRevealed(target, revealedRef.current)) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        rafRef.current = null
        lastTsRef.current = null
      }
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      // Drop the stale frame timestamp so a resumed loop computes dt fresh (a long
      // pause between deltas must not count as one giant frame on resume).
      lastTsRef.current = null
    }
  }, [active, target, config])

  if (!active) return text
  // No rAF (SSR / static-markup tests): effects never ran to seed/animate the
  // reveal, so render the FULL text rather than a stuck-empty slice.
  if (typeof requestAnimationFrame !== "function") return text
  const shown = Math.floor(Math.min(revealedRef.current, target))
  return text.slice(0, shown)
}
