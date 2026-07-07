import { useCallback, useEffect, useState } from "react"
import type { QueuedAgentInput } from "../../electron/services/streamProtocol"

/**
 * CAPP-130 — the composer's queued-message list for ONE structured terminal.
 * Messages typed while the agent is busy are ENQUEUED per terminal (the service
 * decides queue-vs-send) and auto-flush FIFO, one per turn, when the foreground
 * goes idle. This hook mirrors the useSlashPicker/useAgentBusy patterns: PULL the
 * current snapshot on mount + whenever `terminalId` changes (the composer remounts
 * or re-points on a terminal switch / respawn), and SUBSCRIBE to
 * `terminal:agent-queue-changed` via the per-instance disposer so a split-pane's
 * two composers each track their own terminal without clobbering each other.
 *
 * Returns the FIFO snapshot (stable ids drive the chip keys — no re-firing arrival
 * animation on remount, per the stream-reveal-flicker trap) and a `remove(queuedId)`
 * that drops one item (a no-op if it already flushed).
 */
export function useAgentQueue(terminalId: string): {
  queue: QueuedAgentInput[]
  remove: (queuedId: string) => void
} {
  const [queue, setQueue] = useState<QueuedAgentInput[]>([])

  useEffect(() => {
    let disposed = false
    // Pull the current queue for THIS terminal (survives a composer remount / switch).
    void window.api.getAgentQueue(terminalId).then((q) => {
      if (!disposed) setQueue(q ?? [])
    })
    const off = window.api.onAgentQueueChanged((id, q) => {
      if (id === terminalId) setQueue(q ?? [])
    })
    return () => {
      disposed = true
      off?.()
    }
  }, [terminalId])

  const remove = useCallback(
    (queuedId: string) => {
      // Optimistic drop so the chip disappears immediately; the authoritative
      // queue-changed push reconciles (a no-op if it already flushed).
      setQueue((prev) => prev.filter((x) => x.id !== queuedId))
      void window.api.removeQueuedInput(terminalId, queuedId)
    },
    [terminalId],
  )

  return { queue, remove }
}
