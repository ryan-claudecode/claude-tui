import { useEffect, useState } from "react"
import type { StreamEvent } from "../../electron/services/streamProtocol"
import { extractCost, type ResultBlock } from "../lib/agentTranscript"

/**
 * Agent Rail (v1) — a lightweight, per-terminal accumulator of turn-complete `result`
 * blocks (carrying their ResultCost), so the rail's COST footer can sum a
 * session-cumulative total for ANY active terminal.
 *
 * Why not just read the shared transcript cache (keyed by ccConversationId)? In
 * production that works once the first turn captures a convo id — but it is empty for
 * a terminal with no convo id yet (a fresh first turn, or the hermetic fakeStream
 * which never writes an on-disk transcript). Folding the `result` events here, keyed
 * by terminal id, makes the cost robust from the very first turn and needs no convo
 * id. The values are the SAME `result` events AgentView folds, and {@link extractCost}
 * is the SAME extractor the transcript reducer uses — so the two never diverge.
 *
 * The map holds only `result` blocks (the only kind {@link sumCost} reads), so it
 * stays tiny. Entries are pruned on `terminal:exit` (a killed/respawned terminal mints
 * a fresh id anyway — the accepted v1 reset on respawn, per the design doc's COST
 * limitation). Returns the result-block list for `terminalId` (empty when none/unset).
 */
export function useAgentCost(terminalId: string | null): ResultBlock[] {
  const [byTerminal, setByTerminal] = useState<Map<string, ResultBlock[]>>(() => new Map())

  useEffect(() => {
    const offStream = window.api.onStreamEvent((payload) => {
      const event = payload.event as StreamEvent
      if (event.kind !== "result") return
      const block: ResultBlock = {
        kind: "result",
        id: `cost-${payload.terminalId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        isError: event.isError,
        subtype: event.subtype,
        cost: extractCost(event.raw),
      }
      setByTerminal((prev) => {
        const next = new Map(prev)
        next.set(payload.terminalId, [...(prev.get(payload.terminalId) ?? []), block])
        return next
      })
    })
    const offExit = window.api.onSessionExit((id) =>
      setByTerminal((prev) => {
        if (!prev.has(id)) return prev
        const next = new Map(prev)
        next.delete(id)
        return next
      }),
    )
    return () => {
      offStream?.()
      offExit?.()
    }
  }, [])

  return (terminalId && byTerminal.get(terminalId)) || []
}
