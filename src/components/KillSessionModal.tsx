import { useState, useEffect, useRef, useCallback } from "react"
import { useFocusTrap } from "../hooks/useFocusTrap"
import { toast } from "../lib/toast"

interface Props {
  /** The session being killed. `null` = closed (the modal does not render). */
  sessionId: string | null
  /** Display name of the session (for honest copy). Falls back to "this session". */
  sessionName?: string
  /** Clear `pendingKillId` (Cancel, completion, or race auto-close). Owned by App. */
  onClose: () => void
}

/**
 * The delete-session confirm modal. A MAIN-window BLOCKING modal (full-screen
 * overlay: dimmed backdrop, centered card, role="dialog" aria-modal, Esc = Cancel,
 * focus-trapped) raised when the user kills a session (Ctrl+K / sidebar ✕ / palette).
 * It replaces the old `window.confirm`.
 *
 * A plain confirm: Delete (removes the session record + its terminals — NOT the Claude
 * transcript on disk) or Cancel. Every action is a statically-visible control (no
 * hover-reveal).
 */
export default function KillSessionModal({ sessionId, sessionName, onClose }: Props) {
  const [busy, setBusy] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  // Synchronous re-entrancy guard so a same-tick double-click can't fire two kills
  // before the `disabled` state commits.
  const submittingRef = useRef(false)
  const open = sessionId !== null
  useFocusTrap(panelRef, open)

  // Reset transient state whenever the target changes / the modal closes.
  useEffect(() => {
    setBusy(false)
    submittingRef.current = false
  }, [sessionId])

  const handleDelete = useCallback(async () => {
    if (!sessionId || submittingRef.current) return
    submittingRef.current = true
    setBusy(true)
    try {
      await window.api.killWorkSession(sessionId)
      onClose()
    } catch (err) {
      toast(
        "error",
        `Couldn't delete the session: ${err instanceof Error ? err.message : String(err)}`,
      )
      submittingRef.current = false
      setBusy(false)
    }
  }, [sessionId, onClose])

  const handleKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        if (!busy) onClose()
      }
    },
    [busy, onClose],
  )

  if (!open) return null

  const name = sessionName?.trim() || "this session"

  return (
    <div className="kill-modal-overlay" onMouseDown={() => (busy ? undefined : onClose())}>
      <div
        ref={panelRef}
        className="kill-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Delete session"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={handleKey}
      >
        <div className="kill-modal-header">
          <span className="kill-modal-title">Delete “{name}”?</span>
        </div>

        <p className="kill-modal-explain">
          Deleting removes this session's record and terminals.
        </p>

        <p className="kill-modal-note">
          This deletes the session's record. It does not delete the Claude transcript on disk.
        </p>

        <div className="kill-modal-actions">
          <button
            type="button"
            className="kill-modal-btn kill-modal-cancel"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="kill-modal-btn kill-modal-delete"
            onClick={handleDelete}
            disabled={busy}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
