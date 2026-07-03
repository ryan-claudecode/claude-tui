import { useEffect, useState } from "react"
import type { StreamEvent } from "../../electron/services/streamProtocol"
import {
  extractCost,
  lastCumulativeCostUsd,
  toPerTurnCost,
  type ResultBlock,
} from "../lib/agentTranscript"

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
      setByTerminal((prev) => {
        const existing = prev.get(payload.terminalId) ?? []
        // CAPP-125 — `total_cost_usd` is cumulative per process, so fold this turn's
        // PER-TURN delta off the terminal's prior result blocks (each carries its raw
        // cumulative). sumCost then sums per-turn deltas → the true spawn total, not a
        // triangular overcount of the running cumulatives.
        const cost = toPerTurnCost(extractCost(event.raw), lastCumulativeCostUsd(existing))
        const block: ResultBlock = {
          kind: "result",
          id: `cost-${payload.terminalId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          isError: event.isError,
          subtype: event.subtype,
          cost,
        }
        const next = new Map(prev)
        next.set(payload.terminalId, [...existing, block])
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
