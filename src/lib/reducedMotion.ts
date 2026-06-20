/**
 * Shared `prefers-reduced-motion` probe. Centralizes the `matchMedia` guard
 * (SSR / test envs have no `window.matchMedia`) so the streaming smoothing buffer
 * (CAPP-74) and any other motion-gated UI read it the same, safe way.
 *
 * Returns true when the user has asked the OS to reduce motion — callers must then
 * paint instantly (no typewriter buffering, no animated follow, no fade).
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}
