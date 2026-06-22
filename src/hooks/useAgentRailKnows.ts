import { useEffect, useState } from "react"
import { deriveKnows, type RailKnows } from "../lib/agentRail"

/**
 * Agent Rail KNOWS (Phase 3 / CAPP-84 × CAPP-86 v1.5) — fetches the TWO context
 * digests the rail's KNOWS section renders, from EXISTING accessors (no new backend):
 *   • This session   ← window.api.getSessionOverview(activeSessionId) — the SAME
 *     accessor the ⊕ Session Overview panel uses.
 *   • Across sessions ← window.api.recallSummary("workspace", activeSessionId) — the
 *     v1 RecallService cross-session digest, scoped to the ACTIVE session's workspace
 *     (the IPC default 'workspace' → no cross-workspace leak).
 *
 * LIVE without a second listener: the KNOWS-relevant signals (notes / summary) ride
 * along the existing `worksession:updated` push, which useSessions already owns (it
 * replaces `activeSession` on every push). Rather than register a duplicate
 * `worksession:updated` listener here (the footgun usePanels documents), the caller
 * passes a `refreshKey` derived from the live session's note/summary signature; this
 * hook refetches whenever it — or the active session/workspace — changes. So a fresh
 * finding or summary refresh repaints the digest with no polling.
 *
 * The shaping (counts / one-liners / empty-vs-present) lives in the PURE, tested
 * {@link deriveKnows}; this hook is the thin React shell that feeds it.
 */
export function useAgentRailKnows(input: {
  /** The active work-session id (null when nothing is selected). */
  sessionId: string | null
  /** The active session's workspace id, for the recall scope (undefined = "All"). */
  workspaceId?: string
  /** A signature that changes whenever the active session's KNOWS-relevant state
   *  (notes / summary) changes — derived in App.tsx off the live `worksession:updated`
   *  snapshot, so this hook refetches LIVE without owning a duplicate listener. */
  refreshKey: string
}): RailKnows {
  const { sessionId, workspaceId, refreshKey } = input
  const [knows, setKnows] = useState<RailKnows>(() => deriveKnows(null, null))

  useEffect(() => {
    if (!sessionId) {
      setKnows(deriveKnows(null, null))
      return
    }
    let cancelled = false
    void (async () => {
      // Both are pure reads; either failing degrades to its empty digest rather than
      // throwing (a glance surface must never break the rail).
      const [overview, recall] = await Promise.all([
        window.api.getSessionOverview(sessionId).catch(() => null),
        window.api.recallSummary("workspace", sessionId).catch(() => null),
      ])
      if (cancelled) return
      setKnows(deriveKnows(overview, recall))
    })()
    return () => {
      cancelled = true
    }
    // workspaceId is part of the dep set so a workspace re-stamp re-scopes recall even
    // if the session id is unchanged; refreshKey carries the live note/summary updates.
  }, [sessionId, workspaceId, refreshKey])

  return knows
}
