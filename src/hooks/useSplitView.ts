import { useState, useEffect, useCallback, useRef } from "react"
import type { Terminal } from "./useSessions"

/** The minimal shape reconcileSplit needs from a terminal (kept structural so the
 *  pure function is trivially unit-testable without the full Terminal type). */
export interface SplitTerminal {
  id: string
  lastState?: string
  ccConversationId?: string
}

/** The captured slot ids plus the conversation id last seen in each slot. The cc is
 *  the durable identity a respawn preserves (BO-12), so we remember it to re-point a
 *  slot when its terminal id is swapped out from under us. */
export interface SplitState {
  left: string | null
  right: string | null
  leftCc: string | null
  rightCc: string | null
}

/**
 * CAPP-42 — reconcile the split-pane slot ids against the LIVE terminal list.
 *
 * A respawn (Stop/interrupt, model-switch, handoff) mints a NEW terminal id. The
 * single-pane path re-points the active selection via onSwitched/setActiveTerminalId,
 * but the captured splitLeft/splitRight still point at the OLD (now dead/removed) id,
 * so the pane falls through to a blank surface. This re-points each slot generically:
 *
 *  1. Healthy slot (its id is still a live terminal) → keep it, refreshing the
 *     remembered conversation id (a terminal only gets its cc after the first turn).
 *  2. Broken slot, match by conversation id → the in-place respawn (interrupt /
 *     model-switch, via respawnHeadlessRef) mutates the ref in place and PRESERVES
 *     ccConversationId, so the replacement is the live terminal carrying the same cc.
 *  3. Broken slot, fall back to the active terminal → handoff (and any cc-less
 *     respawn) re-points the ACTIVE terminal id at its replacement, so adopt it when
 *     it is a live terminal not already occupying the other slot.
 *  4. Otherwise leave the slot unchanged (the pane shows its own restoring/empty
 *     state rather than jumping to an unrelated terminal).
 */
export function reconcileSplit(
  state: SplitState,
  terminals: SplitTerminal[],
  activeTerminalId: string | null,
): SplitState {
  const isLive = (id: string | null): id is string =>
    !!id && terminals.some((t) => t.id === id && t.lastState !== "dead")
  const ccOf = (id: string | null): string | null =>
    (id ? terminals.find((t) => t.id === id)?.ccConversationId : null) ?? null
  // cc -> the first LIVE terminal carrying it (a --resume respawn keeps the cc).
  const liveByCc = new Map<string, string>()
  for (const t of terminals) {
    if (t.lastState !== "dead" && t.ccConversationId && !liveByCc.has(t.ccConversationId)) {
      liveByCc.set(t.ccConversationId, t.id)
    }
  }

  const resolve = (
    id: string | null,
    cc: string | null,
    otherId: string | null,
  ): { id: string | null; cc: string | null } => {
    if (isLive(id)) return { id, cc: ccOf(id) ?? cc } // (1) healthy — refresh cc memory
    if (!id) return { id, cc }
    if (cc) {
      const successor = liveByCc.get(cc) // (2) re-point by conversation id
      if (successor && successor !== otherId) return { id: successor, cc }
    }
    if (isLive(activeTerminalId) && activeTerminalId !== otherId && activeTerminalId !== id) {
      return { id: activeTerminalId, cc: ccOf(activeTerminalId) ?? cc } // (3) handoff fallback
    }
    return { id, cc } // (4) no successor — leave as-is
  }

  const left = resolve(state.left, state.leftCc, state.right)
  const right = resolve(state.right, state.rightCc, left.id)
  return { left: left.id, right: right.id, leftCc: left.cc, rightCc: right.cc }
}

// Owns the split-pane terminal ids and the toggle, plus the split:set / split:close
// IPC listeners (MCP-driven). Owns the cleanup for exactly those two listeners.
// Depends on the active session's terminals — passed in from useSessions so this
// hook stays decoupled from session state ownership.
export function useSplitView(
  activeTerminals: Terminal[],
  activeTerminalId: string | null,
) {
  const [splitLeft, setSplitLeft] = useState<string | null>(null)
  const [splitRight, setSplitRight] = useState<string | null>(null)
  // The conversation id last seen in each slot — the key reconcileSplit re-points by
  // when a respawn swaps a slot's terminal id. A ref (not state) so updating it never
  // triggers a render; it is read+written only inside the reconcile effect below.
  const slotCc = useRef<{ left: string | null; right: string | null }>({ left: null, right: null })

  // Split pane events from main process (triggered by MCP tools).
  useEffect(() => {
    window.api.onSplitSet((leftId, rightId) => {
      setSplitLeft(leftId)
      setSplitRight(rightId)
    })

    window.api.onSplitClose(() => {
      setSplitLeft(null)
      setSplitRight(null)
      slotCc.current = { left: null, right: null }
    })

    return () => {
      window.api.removeAllListeners("split:set")
      window.api.removeAllListeners("split:close")
    }
  }, [])

  // CAPP-42 — reconcile the captured slot ids whenever the live terminal list (or the
  // active selection) changes. A respawn mints a new terminal id; without this the
  // slot keeps pointing at the dead/removed id and the pane blanks. Idempotent: a
  // healthy split resolves to the same ids (no setState), so this never loops.
  useEffect(() => {
    if (!splitLeft && !splitRight) return
    const next = reconcileSplit(
      { left: splitLeft, right: splitRight, leftCc: slotCc.current.left, rightCc: slotCc.current.right },
      activeTerminals,
      activeTerminalId,
    )
    slotCc.current = { left: next.leftCc, right: next.rightCc }
    if (next.left !== splitLeft) setSplitLeft(next.left)
    if (next.right !== splitRight) setSplitRight(next.right)
  }, [activeTerminals, activeTerminalId, splitLeft, splitRight])

  const toggleSplit = useCallback(() => {
    if (splitLeft) {
      setSplitLeft(null)
      setSplitRight(null)
      slotCc.current = { left: null, right: null }
    } else if (activeTerminals.length >= 2 && activeTerminalId) {
      const other = activeTerminals.find((t) => t.id !== activeTerminalId)
      if (other) {
        setSplitLeft(activeTerminalId)
        setSplitRight(other.id)
      }
    }
  }, [splitLeft, activeTerminals, activeTerminalId])

  return { splitLeft, splitRight, toggleSplit }
}
