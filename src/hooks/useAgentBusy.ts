import { useEffect, useState } from "react"

/**
 * Pure transition for the generating set: add/remove a terminal id, returning the
 * SAME reference when nothing changes so React skips a needless re-render. Both an
 * `idle` state event and a `terminal:exit` map to `active: false` (remove). Exported
 * for hermetic unit testing (CAPP-49).
 */
export function applyGenerating(prev: Set<string>, id: string, active: boolean): Set<string> {
  if (active === prev.has(id)) return prev // no change → keep the same ref
  const next = new Set(prev)
  if (active) next.add(id)
  else next.delete(id)
  return next
}

/**
 * BO-10 — tracks which terminals are actively GENERATING a turn, derived from the
 * `terminal:state` active/idle stream (active → add, idle/dead → remove). The
 * composer's Stop/Send gating treats a terminal as "busy" when it is generating OR
 * has a pending permission; this hook owns only the generating half (the caller ORs
 * in the pending-permission requests).
 *
 * IMPORTANT: a permission block emits `idle` on `terminal:state` (the turn parks on
 * the synchronous approve_tool call), so permission-pending is deliberately NOT
 * surfaced here — it is covered by the permission-request queue instead.
 *
 * Subscribes via the per-instance disposer (`onTerminalState`), so it coexists with
 * usePanels' overview-refresh subscriber on the same channel without either's
 * cleanup clobbering the other.
 *
 * CAPP-49 — also prune on `terminal:exit`: a killed/respawned terminal (Stop, model-
 * switch, handoff, close, kill) does not always emit a trailing `idle` before its proc
 * dies, so its id could linger in the generating Set as a phantom-busy entry. Deleting
 * it on exit keeps the busy state honest (a respawn mints a fresh id anyway).
 */
export function useGeneratingTerminals(): Set<string> {
  const [generating, setGenerating] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    const offState = window.api.onTerminalState((id, state) =>
      setGenerating((prev) => applyGenerating(prev, id, state === "active")),
    )
    const offExit = window.api.onSessionExit((id) =>
      setGenerating((prev) => applyGenerating(prev, id, false)),
    )
    return () => {
      offState?.()
      offExit?.()
    }
  }, [])

  return generating
}
