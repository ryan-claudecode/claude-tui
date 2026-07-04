/**
 * WS-D — the auto-assign workspace color scheme. A workspace gets a colored dot
 * in the switcher pill + dropdown; since WS-A/B exposes no `setColor` mutator
 * (recolor is a deferred follow-up), we cycle a small WARM palette on CREATE so
 * the dots are colorful without the user choosing.
 *
 * Kept a pure, React-free helper (mirrors `sessionRow.ts`) so
 * the cycle is unit-testable in vitest's node env.
 *
 * PALETTE NOTE: these are the ONLY hardcoded colors WS-D introduces (the prompt
 * sanctions a small auto-assign palette). They are a warm Sand & Stone family —
 * amber, terracotta, sage, gold, plum, teal-stone, rust, dusty blue — chosen to
 * read on ALL three theme backgrounds (light cream, warm charcoal, cold navy).
 * They are intentionally THEME-INDEPENDENT category colors: a dot identifies a
 * workspace consistently no matter which theme is active, so they deliberately do
 * NOT track the theme `--accent` (which is amber in light/dark but BLUE in
 * cold-dark). Deliberately mid-saturation so a small 8px dot stays legible
 * without shouting. A persisted workspace may already carry a `color` (e.g. a
 * future recolor or a manifest import); `colorFor` prefers that and only
 * auto-assigns a fallback. The dot is a solid swatch — no token dependency — so it
 * renders identically in the main + companion windows and survives a theme switch.
 */

/** The warm auto-assign palette, in cycle order. Index 0 is amber — the app's
 *  primary hue in the light/dark themes (NOT in cold-dark, whose accent is blue);
 *  the dots are intentionally theme-independent category colors, so amber here is
 *  just the first warm swatch, not a live mirror of `--accent`. */
export const WORKSPACE_COLORS: readonly string[] = [
  "#c47a28", // amber (warm family — matches the light/dark accent, not cold-dark)
  "#b5532e", // terracotta
  "#7a8a5a", // sage
  "#b8902e", // gold
  "#9c6b9c", // muted plum
  "#4a8a8a", // teal-stone
  "#a8542e", // rust
  "#6a7fa8", // dusty blue
]

/**
 * The auto-assign color for the Nth created workspace — cycles the warm palette
 * by position so a fresh registry produces a colorful, stable spread (and wraps
 * past the palette length without crashing). `index` is the workspace's position
 * among existing workspaces at create time.
 */
export function autoColor(index: number): string {
  const n = WORKSPACE_COLORS.length
  // Guard against negative / NaN indices → fall back to the first color.
  const i = Number.isFinite(index) && index >= 0 ? Math.floor(index) % n : 0
  return WORKSPACE_COLORS[i]
}

/**
 * The dot color to render for a workspace: its persisted `color` when present,
 * otherwise a deterministic auto-color derived from its position. Stable for a
 * given (color, index) so the same workspace always shows the same dot.
 */
export function colorFor(
  ws: { color?: string } | null | undefined,
  index: number,
): string {
  return ws?.color || autoColor(index)
}
