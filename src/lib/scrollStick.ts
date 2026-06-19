/**
 * BO-2 — pure helpers for sticky-to-bottom auto-scroll, the unit-test seam for
 * AgentView's scroll behavior. A live transcript should follow new content while
 * the user is pinned at the bottom, but must NOT yank the viewport if the user
 * has scrolled up to read history. Kept DOM-free so it tests deterministically.
 */

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/**
 * Whether the viewport is (within `threshold` px of) the bottom. Content that
 * fits without scrolling counts as "at bottom" so the very first events follow.
 */
export function isAtBottom(m: ScrollMetrics, threshold = 24): boolean {
  return m.scrollHeight - (m.scrollTop + m.clientHeight) <= threshold
}

/**
 * Given the scroll metrics captured BEFORE content grew and the new content
 * height, return the scrollTop to apply to stay pinned to the bottom — or `null`
 * to leave the viewport untouched because the user had scrolled up.
 */
export function nextScrollTop(
  before: ScrollMetrics,
  afterScrollHeight: number,
  clientHeight: number,
  threshold = 24,
): number | null {
  if (!isAtBottom(before, threshold)) return null
  return Math.max(0, afterScrollHeight - clientHeight)
}

/**
 * WS5 — pure instant-vs-smooth decision for the sticky-to-bottom follow, extracted
 * so the BO-12 cold-restore regression is unit-testable without a DOM (the env is
 * node-only). Returns the `scrollTo` behavior to use AND whether this settle should
 * be counted as the "first scroll" (i.e. flip the one-shot ref).
 *
 * The first NON-EMPTY settle after mount snaps INSTANT (`auto`) so a long restored
 * BO-12 transcript (cache-cold disk seed, which commits asynchronously AFTER an empty
 * initial mount) doesn't animate a full top→bottom SLIDE — base behavior was an
 * instant jump. Reduced-motion ALWAYS snaps instant. Every subsequent same-session
 * settle is SMOOTH so the viewport glides with arriving stream deltas.
 *
 * Crucially, an EMPTY settle (`blockCount === 0` — the always-mounted outer div's
 * effect firing on the initial empty mount, before the async disk seed commits) must
 * NOT consume the one-shot: it neither snaps as "the first scroll" nor flips
 * `didFirstScroll`. So `firstScrollDone` stays false until real content arrives, and
 * the disk-seed commit (the first run WITH blocks) is the one that snaps instant.
 */
export function scrollFollowBehavior(
  firstScrollDone: boolean,
  blockCount: number,
  reduceMotion: boolean,
): { behavior: ScrollBehavior; markFirstDone: boolean } {
  // Nothing to scroll to yet — don't burn the one-shot against an empty mount.
  // Behavior is irrelevant (there's no content), but report it inert.
  if (blockCount === 0) return { behavior: "auto", markFirstDone: false }
  // First non-empty settle (BO-12 rehydrate/restore seed, or the first turn) snaps
  // instantly; reduced-motion always snaps. `behavior:'auto'` cancels any in-flight
  // smooth scroll cleanly.
  if (!firstScrollDone || reduceMotion) return { behavior: "auto", markFirstDone: true }
  // Smooth follow for subsequent streaming deltas.
  return { behavior: "smooth", markFirstDone: false }
}
