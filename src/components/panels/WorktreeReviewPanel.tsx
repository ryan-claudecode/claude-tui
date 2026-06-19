import { useState, useMemo, useCallback } from "react"
import DiffPanel from "./DiffPanel"
import { parseUnifiedDiff } from "../../lib/unifiedDiff"

/**
 * Result shape returned by the approve/reject IPC round-trip — the post-action
 * task state the panel reflects. `done`/`pending` close the review; `merge-conflict`
 * keeps the panel open showing the preserved-branch conflict.
 */
export interface ReviewActionResult {
  status?: string
  reviewReason?: string
}

interface Props {
  missionId?: string
  taskId?: string
  title?: string
  /** The captured unified-diff string (worker branch vs baseRef). */
  diff?: string
  /** Merge-conflict summary OR rejection reason, per task state. */
  reviewReason?: string
  /** Current task status: "awaiting-review" | "merge-conflict" (others close it). */
  status?: string
  /** Send a built review request to the active session (DiffPanel's hunk review). */
  onSend?: (text: string) => boolean
  /** Approve → merge. Resolves to the resulting task state (or null on failure). */
  onApprove?: (missionId: string, taskId: string) => Promise<ReviewActionResult | null>
  /** Reject → discard + back to pending. Resolves to the resulting state. */
  onReject?: (missionId: string, taskId: string, reason?: string) => Promise<ReviewActionResult | null>
}

export default function WorktreeReviewPanel({
  missionId, taskId, title, diff, reviewReason, status,
  onSend, onApprove, onReject,
}: Props) {
  // Local state overlays the props so the panel reflects an action's result
  // immediately (the mission event seam also repaints, but this is instant and
  // works even if the panel's props aren't re-pushed).
  const [localStatus, setLocalStatus] = useState<string | undefined>(status)
  const [localReason, setLocalReason] = useState<string | undefined>(reviewReason)
  const [busy, setBusy] = useState<null | "approve" | "reject">(null)
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState("")
  // Inline error when an action couldn't complete (null result = IPC failure or
  // the task wasn't in a reviewable state). P0-5: never fail silently.
  const [actionError, setActionError] = useState<string | null>(null)

  const effStatus = localStatus ?? status
  const effReason = localReason ?? reviewReason
  const isConflict = effStatus === "merge-conflict"
  const isResolved = effStatus === "done" || effStatus === "pending"

  const files = useMemo(() => parseUnifiedDiff(diff ?? ""), [diff])

  const handleApprove = useCallback(async () => {
    if (!missionId || !taskId || !onApprove || busy) return
    setBusy("approve")
    setActionError(null)
    try {
      const res = await onApprove(missionId, taskId)
      if (res) {
        setLocalStatus(res.status)
        setLocalReason(res.reviewReason)
      } else {
        setActionError("Approve failed — the task may no longer be awaiting review.")
      }
    } finally {
      setBusy(null)
    }
  }, [missionId, taskId, onApprove, busy])

  const handleReject = useCallback(async () => {
    if (!missionId || !taskId || !onReject || busy) return
    setBusy("reject")
    setActionError(null)
    try {
      const res = await onReject(missionId, taskId, rejectReason.trim() || undefined)
      if (res) {
        setLocalStatus(res.status)
        setLocalReason(res.reviewReason)
        setRejecting(false)
      } else {
        setActionError("Reject failed — the task may no longer be awaiting review.")
      }
    } finally {
      setBusy(null)
    }
  }, [missionId, taskId, onReject, rejectReason, busy])

  return (
    <div className="worktree-review-panel">
      <div className="wtr-header">
        <div className="wtr-title">{title ?? "Worktree review"}</div>
        <span className={`wtr-status wtr-status-${effStatus ?? "awaiting-review"}`}>
          {effStatus === "merge-conflict"
            ? "merge conflict"
            : effStatus === "done"
              ? "merged"
              : effStatus === "pending"
                ? "rejected"
                : "awaiting review"}
        </span>
      </div>

      {isConflict && (
        <div className="wtr-conflict">
          <div className="wtr-conflict-head">Merge conflict — branch preserved for manual resolution</div>
          {effReason && <pre className="wtr-conflict-detail">{effReason}</pre>}
          <div className="wtr-conflict-note">
            Resolve the conflict in the worktree branch by hand, or Reject to discard it (the task goes back to pending).
          </div>
        </div>
      )}

      <div className="wtr-diff">
        {files.length > 0 ? (
          <DiffPanel files={files} onSend={onSend} />
        ) : (
          <div className="panel-empty">No diff captured for this task.</div>
        )}
      </div>

      {actionError && <div className="wtr-error">{actionError}</div>}

      {!isResolved && (
        <div className="wtr-actions">
          {rejecting ? (
            <div className="wtr-reject-form">
              <input
                className="wtr-reject-reason"
                placeholder="Reason (optional) — sent back to pending…"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                autoFocus
              />
              <button
                className="wtr-btn wtr-btn-reject"
                onClick={handleReject}
                disabled={busy !== null}
              >
                {busy === "reject" ? "Rejecting…" : "Confirm reject"}
              </button>
              <button className="wtr-btn wtr-btn-cancel" onClick={() => setRejecting(false)} disabled={busy !== null}>
                Cancel
              </button>
            </div>
          ) : (
            <>
              {/* Approve only when awaiting review — re-merging a conflicted
                  branch would just conflict again (no resolution UI here). */}
              {!isConflict && (
                <button
                  className="wtr-btn wtr-btn-approve"
                  onClick={handleApprove}
                  disabled={busy !== null}
                >
                  {busy === "approve" ? "Merging…" : "Approve & merge"}
                </button>
              )}
              <button
                className="wtr-btn wtr-btn-reject"
                onClick={() => setRejecting(true)}
                disabled={busy !== null}
              >
                {isConflict ? "Discard (reject)" : "Reject"}
              </button>
            </>
          )}
        </div>
      )}

      {isResolved && (
        <div className="wtr-resolved">
          {effStatus === "done"
            ? "Merged into the mission branch — worktree removed."
            : `Rejected — task back to pending${effReason ? `: ${effReason}` : ""}.`}
        </div>
      )}
    </div>
  )
}
