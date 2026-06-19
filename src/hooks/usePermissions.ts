import { useCallback, useEffect, useState } from "react"
import type {
  PermissionRequest,
  PermissionDecision,
} from "../../electron/services/streamProtocol"

/**
 * BO-11 (CAPP-50) — pure: keep only requests whose terminal still exists in the live
 * id set (dropping orphans from a missed `permission:resolved`, plus any with no
 * terminalId, which can't be attributed or rendered). Returns the SAME array
 * reference when nothing is orphaned, so the caller's setState is a no-op re-render.
 * Exported for a node-env unit test (the hook itself needs a DOM to exercise).
 */
export function pruneOrphanedRequests(
  requests: PermissionRequest[],
  liveTerminalIds: Set<string>,
): PermissionRequest[] {
  const next = requests.filter((r) => r.terminalId != null && liveTerminalIds.has(r.terminalId))
  return next.length === requests.length ? requests : next
}

/**
 * BO-3 — the renderer's view of pending tool-permission prompts. A thin queue:
 * `permission:request` pushes append, `permission:resolved` (user decided, or the
 * agent exited and the main process orphan-resolved) remove by id. The component
 * acts on the head; >1 means a backlog. Listeners use the per-instance
 * unsubscribe (like onStreamEvent) so this tears down cleanly.
 *
 * BO-11 (CAPP-50) — `liveTerminalIds` is the set of currently-existing terminal ids
 * (derived from the session list). The queue otherwise only drops an entry on a
 * matching `permission:resolved` IPC; if that race-loses to a Ctrl+K kill (the
 * terminal is gone before its deny resolves), a dead terminal's permission card would
 * linger over the new session's composer. Pruning against the live id set self-heals
 * such orphans even when the `resolved` push was missed.
 */
export function usePermissions(liveTerminalIds: Set<string>) {
  const [requests, setRequests] = useState<PermissionRequest[]>([])

  useEffect(() => {
    const offReq = window.api.onPermissionRequest((req) =>
      setRequests((prev) => (prev.some((r) => r.id === req.id) ? prev : [...prev, req])),
    )
    const offResolved = window.api.onPermissionResolved((id) =>
      setRequests((prev) => prev.filter((r) => r.id !== id)),
    )
    return () => {
      offReq?.()
      offResolved?.()
    }
  }, [])

  // Self-heal: drop any request whose terminal no longer exists. Runs only when the
  // live id set changes; pruneOrphanedRequests returns the prior array unchanged when
  // nothing is orphaned so it never triggers a needless re-render.
  useEffect(() => {
    setRequests((prev) => pruneOrphanedRequests(prev, liveTerminalIds))
  }, [liveTerminalIds])

  /**
   * Send a decision and optimistically drop the request locally (the main
   * process also pushes `permission:resolved`, which is idempotent here). Clearing
   * the lingering tier-2 "asked" attention entry is the caller's job (it owns the
   * terminalId) — see App.tsx.
   */
  const resolve = useCallback((id: string, decision: Omit<PermissionDecision, "id">) => {
    setRequests((prev) => prev.filter((r) => r.id !== id))
    try {
      window.api.resolvePermission(id, { ...decision, id })
    } catch {
      // best-effort; the request is already gone from the local queue.
    }
  }, [])

  return { requests, resolve }
}
