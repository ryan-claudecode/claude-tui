import { useState, useEffect, useCallback, useRef, type MutableRefObject } from "react"
import { toast } from "../lib/toast"

/**
 * One entry in the attention queue, mirrored from the main-process
 * `AttentionService` (AQ-1). The renderer is a thin view — the service owns the
 * queue, ordering, and policy; this is just the wire shape.
 */
export interface AttentionEntry {
  id: string
  tier: 1 | 2 | 3
  kind: "blocked" | "asked" | "error" | "finished"
  sessionId: string
  terminalId?: string
  reason: string
  since: number
}

// Normalize an unknown thrown value into a human-readable message for toasts.
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * How often the hook forces a re-render so the rows' wait-time labels stay fresh
 * without spamming. The queue itself updates reactively via `attention:updated`;
 * this tick only re-derives the relative "· 6m" text. (Spec: ~30s.)
 */
const WAIT_TICK_MS = 30_000

/**
 * The renderer half of the attention queue. Subscribes to `attention:updated`
 * (full snapshots) and `attention:jump` (OS-notification click), exposes
 * `{ entries, nowTick, dismiss, jumpTo }`, and owns the cleanup for exactly the
 * two listeners it registers plus its wait-time interval (P1-4 hook pattern).
 *
 * `focus(sessionId, terminalId?)` is supplied by App.tsx and drives the existing
 * select-session / select-terminal paths in `useSessions` — the hook doesn't own
 * that state, so jumping is delegated. It's passed as a ref so the mount-once
 * effect (which `attention:jump` lands in) always calls the latest closure.
 */
export function useAttention(
  focusRef: MutableRefObject<(sessionId: string, terminalId?: string) => void>,
) {
  const [entries, setEntries] = useState<AttentionEntry[]>([])
  // Bumped on the wait-time interval; consumers read it so wait labels re-derive.
  const [nowTick, setNowTick] = useState(() => Date.now())

  // Keep a live ref to entries so the mount-once `attention:jump` handler can
  // resolve an id → entry without re-registering its listener on every change.
  const entriesRef = useRef(entries)
  useEffect(() => {
    entriesRef.current = entries
  }, [entries])

  const jumpTo = useCallback(
    (entry: AttentionEntry) => {
      focusRef.current(entry.sessionId, entry.terminalId)
      // Focusing a terminal clears its tier-2/3 entries server-side; the snapshot
      // push reflects it. Tier-1 (blocked) persists until the form resolves.
      if (entry.terminalId) {
        Promise.resolve(window.api.attentionSeen(entry.terminalId)).catch((err) =>
          toast("error", `Couldn't clear the attention entry: ${errMsg(err)}`),
        )
      }
    },
    [focusRef],
  )

  const dismiss = useCallback((id: string) => {
    Promise.resolve(window.api.attentionDismiss(id)).catch((err) =>
      toast("error", `Couldn't dismiss the attention entry: ${errMsg(err)}`),
    )
  }, [])

  // Keep a live ref to jumpTo so the mount-once listener calls the latest closure.
  const jumpToRef = useRef(jumpTo)
  useEffect(() => {
    jumpToRef.current = jumpTo
  }, [jumpTo])

  useEffect(() => {
    window.api.onAttentionUpdated((next: AttentionEntry[]) => {
      setEntries(next ?? [])
      // Reset the clock whenever the queue changes so freshly-added entries
      // display an accurate wait time immediately rather than showing "0s" for
      // up to WAIT_TICK_MS (30s) while nowTick drifts behind entry.since.
      setNowTick(Date.now())
    })
    // OS-notification click: jump to that entry (focus + clear). If it's already
    // gone from the queue, ignore it.
    window.api.onAttentionJump((id: string) => {
      const entry = entriesRef.current.find((e) => e.id === id)
      if (entry) jumpToRef.current(entry)
    })
    const interval = setInterval(() => setNowTick(Date.now()), WAIT_TICK_MS)
    return () => {
      window.api.removeAllListeners("attention:updated")
      window.api.removeAllListeners("attention:jump")
      clearInterval(interval)
    }
  }, [])

  return { entries, nowTick, dismiss, jumpTo }
}
