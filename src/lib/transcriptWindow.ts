/**
 * CAPP-103 — render-windowing math for the structured chat view (`AgentView`).
 *
 * A long restored conversation can carry thousands of transcript blocks; rendering them
 * all at once freezes the main thread (every assistant/user/result block parses markdown),
 * which is what made a big chat sit on "Restoring conversation…" indefinitely. So
 * `AgentView` renders only a TAIL window of blocks and reveals older ones on demand
 * ("Load earlier"). These helpers are the DOM-free, unit-tested seam for that windowing:
 * the reducer fold, the BO-12 cache, and live streaming are ALL untouched — only HOW MANY
 * blocks reach the DOM changes.
 *
 * The window is modeled as a `hiddenCount` — the number of OLDEST blocks not rendered. It
 * is seeded ONCE when a conversation loads (from the cache-hit initializer or the disk
 * restore), then the user controls it via "Load earlier"; live streamed blocks append at
 * the tail and never change it (they land AFTER the hidden prefix, so they're always
 * visible). A conversation the user watched grow live is never auto-hidden.
 */

/** How many of the most-recent blocks to render when a conversation first loads. */
export const INITIAL_WINDOW = 80
/** How many additional older blocks each "Load earlier" reveals. */
export const LOAD_EARLIER_PAGE = 80

/**
 * The number of OLDEST blocks to hide when a conversation of `total` blocks first loads —
 * everything beyond the most-recent `windowSize`. 0 when it already fits (or for a
 * degenerate/negative total).
 */
export function initialHiddenCount(total: number, windowSize: number = INITIAL_WINDOW): number {
  if (!Number.isFinite(total) || total <= windowSize) return 0
  return total - windowSize
}

/** Reveal one more page of older blocks — decrease `hidden` by `page`, never below 0. */
export function revealEarlier(hidden: number, page: number = LOAD_EARLIER_PAGE): number {
  return Math.max(0, hidden - page)
}

/**
 * The visible TAIL of `blocks` given `hidden` oldest blocks hidden. `hidden` is clamped to
 * `[0, blocks.length]`, so an out-of-range value can never throw or drop the tail entirely.
 * `hidden <= 0` returns the same array reference (no copy — keeps React reconciliation cheap).
 */
export function visibleBlocks<T>(blocks: T[], hidden: number): T[] {
  if (hidden <= 0) return blocks
  return blocks.slice(Math.min(hidden, blocks.length))
}
