/**
 * CAPP-120 (STT-1, review finding 2 — MAJOR) — the renderer-local seam that lets
 * App.tsx's CAPTURE-phase Escape handler ask "is a dictation recording live? discard it"
 * BEFORE falling through to the BO-10 busy-terminal interrupt. A module-level registry
 * (like the `toast` CustomEvent seam) instead of prop-drilling a ref through
 * AgentSurface, and multi-instance-safe: each mounted composer registers its own
 * handler (split panes register two), and only the one actually recording returns true.
 */

const handlers = new Set<() => boolean>()

/**
 * Register a handler that discards THIS composer's active recording and returns true,
 * or returns false when it has nothing recording. Returns the unregister fn (call it
 * on unmount).
 */
export function registerDictationEscHandler(handler: () => boolean): () => void {
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
  }
}

/**
 * App.tsx's Escape arm calls this FIRST. Runs every registered handler (a throwing
 * handler never breaks the others); true when any of them discarded a live recording —
 * the recording owned Esc, so the interrupt must NOT fire.
 */
export function dispatchDictationEsc(): boolean {
  let discarded = false
  for (const h of handlers) {
    try {
      if (h()) discarded = true
    } catch {
      /* one broken handler must not shadow the others or crash the key handler */
    }
  }
  return discarded
}
