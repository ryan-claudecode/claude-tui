import { useState, useEffect } from "react"
import type { Recurrence } from "../../../electron/services/scheduleMath"
import { recurrenceSummary, nextRunText, runStatusTone } from "../../lib/scheduleRow"
import { scheduleAction, type ScheduleActionEvent } from "../../lib/scheduleActions"

/**
 * CAPP-115 (SCHED-2) — the `schedule` detail panel. Rendered by the shared
 * PanelContent switch, so it appears in the main-window ModalHost by default and can
 * be popped out to the companion window like every other panel. Static props (the
 * ScheduleSummary snapshot) drive it; usePanels live-refreshes an open panel off the
 * `schedule:updated` push keyed on props.id.
 *
 * Shows the recurrence in words, the next-run countdown, the enabled state, and the
 * FULL run history (newest first, per-status tinting). Every control is a
 * statically-visible TEXT button (no hover-reveal, words over icons): Edit,
 * Enable/Disable, Run now, Delete (two-step inline confirm). Delete/Edit/etc. route
 * through the `api` bridge so they work identically on either surface.
 */

interface RunView {
  at: string
  status: string
  durationMs?: number
  sessionId?: string
  terminalId?: string
  note?: string
}

export interface SchedulePanelProps {
  id: string
  name?: string
  prompt?: string
  recurrence?: Recurrence
  enabled?: boolean
  nextRunAt?: string | null
  model?: string
  effort?: string
  cwd?: string
  catchUp?: boolean
  keepTerminal?: boolean
  runHistory?: RunView[]
  onRunNow?: (id: string) => void
  onSetEnabled?: (id: string, enabled: boolean) => void
  onDelete?: (id: string) => void
  onEdit?: (id: string) => void
  /** Close THIS panel (a confirmed delete closes it — never leave a zombie panel
   *  with a dead schedule's stale data). Wired by PanelContent over api.hidePanel. */
  onClosePanel?: () => void
}

/** Prettier per-status labels for a run-history row (the raw enum otherwise). */
const STATUS_LABEL: Record<string, string> = {
  ok: "ok",
  error: "error",
  timeout: "timeout",
  killed: "killed",
  "skipped-overlap": "skipped · overlap",
  "skipped-missed": "skipped · missed",
}

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status
}

function formatDuration(ms?: number): string | null {
  if (ms == null || !Number.isFinite(ms)) return null
  if (ms < 1000) return `${ms}ms`
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return s ? `${m}m ${s}s` : `${m}m`
}

function formatWhen(at: string): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString()
}

export default function SchedulePanel({
  id,
  name,
  prompt,
  recurrence,
  enabled = true,
  nextRunAt = null,
  model,
  cwd,
  catchUp,
  runHistory = [],
  onRunNow,
  onSetEnabled,
  onDelete,
  onEdit,
  onClosePanel,
}: SchedulePanelProps) {
  // Re-derive the countdown every 30s (the design cadence). SSR renders the initial
  // value (effects don't run under renderToStaticMarkup) — fine for a static render.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  // Two-step inline confirm for Delete (no native window.confirm). The DECISIONS live
  // in the pure `scheduleAction` machine (src/lib/scheduleActions.ts, exhaustively
  // tested); this component only applies the outcome.
  const [confirmDelete, setConfirmDelete] = useState(false)

  // CAPP-115 review (MAJOR 1) — defensive reset: if this instance is ever re-targeted
  // at a DIFFERENT schedule (the hosts key PanelContent by panel id, so this should
  // not happen — belt + braces), the armed confirm must NOT carry over to the new
  // target. Mirrors the machine's `panel-target-changed` transition.
  useEffect(() => {
    setConfirmDelete(false)
  }, [id])

  const dispatch = (event: ScheduleActionEvent) => {
    const out = scheduleAction({ confirmArmed: confirmDelete, enabled }, event)
    setConfirmDelete(out.confirmArmed)
    const call = out.call
    if (call?.kind === "edit") onEdit?.(id)
    else if (call?.kind === "setEnabled") onSetEnabled?.(id, call.enabled)
    else if (call?.kind === "runNow") onRunNow?.(id)
    else if (call?.kind === "delete") onDelete?.(id)
    // A confirmed delete also closes this panel — never a zombie over dead data.
    if (out.closePanel) onClosePanel?.()
  }

  const view = { enabled, nextRunAt }

  return (
    <div className="schedule-panel">
      <div className="schedule-panel-head">
        <span className="schedule-panel-name">{name ?? "Schedule"}</span>
        <span className={`schedule-panel-chip ${enabled ? "chip-enabled" : "chip-paused"}`}>
          {enabled ? "on" : "paused"}
        </span>
      </div>

      <div className="schedule-panel-meta">
        {recurrence && <div className="schedule-panel-recur">{recurrenceSummary(recurrence)}</div>}
        <div className="schedule-panel-next">
          Next run: <span className="schedule-panel-next-val">{nextRunText(view, now)}</span>
          {enabled && nextRunAt && !Number.isNaN(new Date(nextRunAt).getTime()) && (
            <span className="schedule-panel-next-abs"> · {new Date(nextRunAt).toLocaleString()}</span>
          )}
        </div>
        {(model || cwd || catchUp) && (
          <div className="schedule-panel-opts">
            {model && <span className="schedule-panel-opt">model: {model}</span>}
            {cwd && <span className="schedule-panel-opt">cwd: {cwd}</span>}
            {catchUp && <span className="schedule-panel-opt">catch-up</span>}
          </div>
        )}
      </div>

      {prompt && <div className="schedule-panel-prompt">{prompt}</div>}

      <div className="schedule-panel-actions">
        <button type="button" className="schedule-panel-btn" onClick={() => dispatch({ type: "edit" })}>
          Edit
        </button>
        <button
          type="button"
          className="schedule-panel-btn"
          onClick={() => dispatch({ type: "toggle-enabled" })}
        >
          {enabled ? "Disable" : "Enable"}
        </button>
        <button type="button" className="schedule-panel-btn" onClick={() => dispatch({ type: "run-now" })}>
          Run now
        </button>
        <span className="schedule-panel-actions-spacer" />
        {confirmDelete ? (
          <>
            <button
              type="button"
              className="schedule-panel-btn schedule-panel-btn-danger"
              onClick={() => dispatch({ type: "delete-confirm" })}
            >
              Confirm delete
            </button>
            <button
              type="button"
              className="schedule-panel-btn"
              onClick={() => dispatch({ type: "delete-cancel" })}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="schedule-panel-btn schedule-panel-btn-danger"
            onClick={() => dispatch({ type: "delete-press" })}
          >
            Delete
          </button>
        )}
      </div>

      <div className="schedule-panel-history">
        <div className="schedule-panel-history-head">Run history ({runHistory.length})</div>
        {runHistory.length === 0 ? (
          <div className="schedule-panel-history-empty">No runs yet</div>
        ) : (
          runHistory.map((r, i) => {
            const dur = formatDuration(r.durationMs)
            return (
              <div key={`${r.at}-${i}`} className={`sched-run tone-${runStatusTone(r.status)}`}>
                <div className="sched-run-line1">
                  <span className="sched-run-status">{statusLabel(r.status)}</span>
                  <span className="sched-run-when">{formatWhen(r.at)}</span>
                  {dur && <span className="sched-run-dur">{dur}</span>}
                </div>
                {r.note && <div className="sched-run-note">{r.note}</div>}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
