import { useCallback, useEffect, useState } from "react"
import type { RailOutput } from "../../electron/services/streamProtocol"

/**
 * CAPP-132 — the Agent Rail OUTPUTS feed for ONE work session (the durable FIFO
 * history of that session's deliverables — links / files / notes). Mirrors the
 * useAgentQueue pattern: PULL the current snapshot on mount + whenever the active
 * `sessionId` changes (a session switch re-points the rail), and SUBSCRIBE to
 * `worksession:outputs-changed` via the per-instance disposer so a stale listener
 * never clobbers a sibling.
 *
 * SESSION-scoped (all of the session's terminals), unlike the rail's NOW/COST which
 * are active-terminal-scoped. Stable entry ids drive the row keys (no re-firing
 * arrival animation on remount, per the stream-reveal-flicker trap). `remove` /
 * `clear` optimistically update then let the authoritative push reconcile.
 */
export function useSessionOutputs(sessionId: string | null | undefined): {
  outputs: RailOutput[]
  remove: (outputId: string) => void
  clear: () => void
} {
  const [outputs, setOutputs] = useState<RailOutput[]>([])

  useEffect(() => {
    if (!sessionId) {
      setOutputs([])
      return
    }
    let disposed = false
    void window.api.getSessionOutputs(sessionId).then((o) => {
      if (!disposed) setOutputs(o ?? [])
    })
    const off = window.api.onSessionOutputsChanged((id, o) => {
      if (id === sessionId) setOutputs(o ?? [])
    })
    return () => {
      disposed = true
      off?.()
    }
  }, [sessionId])

  const remove = useCallback(
    (outputId: string) => {
      if (!sessionId) return
      // Optimistic drop so the row disappears immediately; the outputs-changed push reconciles.
      setOutputs((prev) => prev.filter((x) => x.id !== outputId))
      void window.api.removeSessionOutput(sessionId, outputId)
    },
    [sessionId],
  )

  const clear = useCallback(() => {
    if (!sessionId) return
    setOutputs([])
    void window.api.clearSessionOutputs(sessionId)
  }, [sessionId])

  return { outputs, remove, clear }
}
