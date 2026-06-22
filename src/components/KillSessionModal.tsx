import { useState, useEffect, useRef, useCallback } from "react"
import { useFocusTrap } from "../hooks/useFocusTrap"
import { toast } from "../lib/toast"
import {
  snapshotPromoteRows,
  rowsToPromoteEntries,
  type PromoteRow,
} from "../lib/killSessionPromote"

interface Props {
  /** The session being killed. `null` = closed (the modal does not render). */
  sessionId: string | null
  /** Display name of the session (for honest copy). Falls back to "this session". */
  sessionName?: string
  /** Clear `pendingKillId` (Cancel, completion, or race auto-close). Owned by App. */
  onClose: () => void
}

/**
 * CAPP-93 / U5 — the delete-time Keep/trim/edit gate. A MAIN-window BLOCKING modal
 * (clones the mission-prompt full-screen overlay: dimmed backdrop, centered card,
 * role="dialog" aria-modal, Esc = Cancel, focus-trapped) raised when the user kills a
 * session (Ctrl+K / sidebar ✕ / palette). It replaces the old `window.confirm`.
 *
 * On open it fetches the dying session's promotable findings and SNAPSHOTS them into
 * local state once (so in-session mutations don't disturb the review). Every row is
 * pre-checked (default = promote ALL — active AND ruled-out, since ruled-out findings
 * are the highest-value rescue), inline-editable, and individually removable. NO
 * hover-reveal: every control (checkbox, edit input, per-row Remove, the three footer
 * buttons) is statically visible.
 *
 * Footer:
 *  - Keep & delete   → promote the checked/edited findings into the OWNING session's
 *                      workspace memory, THEN kill (atomic, handler-side).
 *  - Delete everything → kill only (today's killSession semantics — record + PTYs;
 *                      NOT the Claude transcript on disk, worded honestly).
 *  - Cancel          → close, no kill.
 */
export default function KillSessionModal({ sessionId, sessionName, onClose }: Props) {
  const [rows, setRows] = useState<PromoteRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  // Synchronous re-entrancy guard. `busy` (state) only blocks a second submit AFTER the
  // re-render commits the buttons' `disabled` — a same-tick double-click would slip through
  // and promote TWICE (duplicating findings in the persistent workspace-memory store). The
  // ref flips immediately, so the second invocation is rejected before any IPC fires.
  const submittingRef = useRef(false)
  const open = sessionId !== null
  useFocusTrap(panelRef, open)

  // On open: snapshot the dying session's promotable findings ONCE into local state.
  // A new sessionId (re-open) re-fetches; closing resets so a stale list never flashes.
  useEffect(() => {
    if (!sessionId) {
      setRows([])
      setLoaded(false)
      setBusy(false)
      submittingRef.current = false
      return
    }
    let cancelled = false
    setLoaded(false)
    setBusy(false)
    submittingRef.current = false
    Promise.resolve(window.api.getPromotableFindings(sessionId))
      .then((entries) => {
        if (cancelled) return
        setRows(snapshotPromoteRows(entries ?? []))
        setLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        // A failed fetch shouldn't trap the user — treat as "no findings" so Keep ≡
        // Delete and the modal stays actionable.
        setRows([])
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const setRow = useCallback((rowId: string, patch: Partial<PromoteRow>) => {
    setRows((prev) => prev.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)))
  }, [])

  const removeRow = useCallback((rowId: string) => {
    setRows((prev) => prev.filter((r) => r.rowId !== rowId))
  }, [])

  const handleKeep = useCallback(async () => {
    if (!sessionId || submittingRef.current) return
    submittingRef.current = true
    setBusy(true)
    try {
      const entries = rowsToPromoteEntries(rows)
      await window.api.killWorkSessionWithPromote(sessionId, entries)
      onClose()
    } catch (err) {
      toast(
        "error",
        `Couldn't keep findings + delete the session: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      submittingRef.current = false
      setBusy(false)
    }
  }, [sessionId, rows, onClose])

  const handleDeleteAll = useCallback(async () => {
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
  const hasFindings = rows.length > 0
  const keepCount = rowsToPromoteEntries(rows).length

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
          {hasFindings
            ? "Keep this session's findings in workspace memory before deleting, or delete everything. Workspace memory itself is never touched — only this session."
            : "This session has no saved findings to keep. Deleting removes its record and terminals."}
        </p>

        {loaded && hasFindings && (
          <>
            <div className="kill-modal-list-label">
              Findings to keep ({keepCount} of {rows.length})
            </div>
            <ul className="kill-modal-findings">
              {rows.map((r) => (
                <li
                  key={r.rowId}
                  className={`kill-modal-finding${r.checked ? "" : " unchecked"}${
                    r.origin.status === "superseded" ? " ruled-out" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    className="kill-modal-check"
                    checked={r.checked}
                    onChange={(e) => setRow(r.rowId, { checked: e.target.checked })}
                    aria-label={`Keep finding: ${r.text}`}
                    disabled={busy}
                  />
                  <input
                    type="text"
                    className="kill-modal-finding-input"
                    value={r.text}
                    onChange={(e) => setRow(r.rowId, { text: e.target.value })}
                    aria-label="Edit finding text"
                    disabled={busy}
                  />
                  {r.origin.status === "superseded" && (
                    <span className="kill-modal-ruled-out-tag" title="Ruled out — superseded">
                      ruled out
                    </span>
                  )}
                  <button
                    type="button"
                    className="kill-modal-remove"
                    onClick={() => removeRow(r.rowId)}
                    aria-label="Remove this finding from the keep list"
                    title="Remove from the keep list"
                    disabled={busy}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {loaded && !hasFindings && <div className="kill-modal-empty">No findings to keep.</div>}

        <p className="kill-modal-note">
          “Delete everything” deletes this session's saved findings and record. It does
          not delete the Claude transcript on disk.
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
          {hasFindings && (
            <button
              type="button"
              className="kill-modal-btn kill-modal-keep"
              onClick={handleKeep}
              // Disabled when nothing is actually kept (all rows unchecked / blanked) so the
              // affirmative "Keep" button never silently degrades to a plain delete — the
              // user must choose "Delete everything" explicitly in that case.
              disabled={busy || !loaded || keepCount === 0}
            >
              Keep &amp; delete
            </button>
          )}
          <button
            type="button"
            className="kill-modal-btn kill-modal-delete"
            onClick={handleDeleteAll}
            disabled={busy || !loaded}
          >
            Delete everything
          </button>
        </div>
      </div>
    </div>
  )
}
