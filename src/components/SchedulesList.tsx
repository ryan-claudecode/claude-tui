import { useState, useEffect, type CSSProperties } from "react"
import type { ScheduleSummary } from "../hooks/useSchedules"
import { recurrenceSummary, nextRunText, lastRun, runStatusTone } from "../lib/scheduleRow"

interface Props {
  schedules: ScheduleSummary[]
  onNew: () => void
  onOpen: (s: ScheduleSummary) => void
  onToggle: (id: string, enabled: boolean) => void
  onRunNow: (id: string) => void
  /** When a specific workspace is active, an empty section shows a scoped hint. */
  workspaceScoped: boolean
}

/**
 * CAPP-114 (SCHED-1) — the SCHEDULED sidebar section. Clones the MISSIONS MS-2 row
 * pattern: two-line rows (name + enabled/paused chip; `next in 14m · last ok`) with
 * STATICALLY-VISIBLE per-row controls (no hover-reveal): pause/resume + run-now.
 * The countdown re-derives on a 30s interval from `nextRunAt`.
 */
export default function SchedulesList({ schedules, onNew, onOpen, onToggle, onRunNow, workspaceScoped }: Props) {
  // Re-derive countdown text every 30s (the design cadence) off a ticking `now`.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="sidebar-section schedules-section">
      <div className="sidebar-header schedules-header">
        <span>{schedules.length > 0 ? `SCHEDULED (${schedules.length})` : "SCHEDULED"}</span>
        <button
          className="schedules-new-btn"
          title="New scheduled run"
          aria-label="New scheduled run"
          onClick={(e) => { e.stopPropagation(); onNew() }}
        >
          +
        </button>
      </div>

      {schedules.length === 0 && (
        workspaceScoped ? (
          <div className="sidebar-scoped-empty">Nothing in this workspace</div>
        ) : (
          <div className="schedule-empty-row" onClick={onNew}>
            No schedules — add one
          </div>
        )
      )}

      {schedules.map((s, i) => {
        const last = lastRun(s.runHistory)
        const tone = last ? runStatusTone(last.status) : null
        return (
          <div
            key={s.id}
            className="schedule-item"
            style={{ "--i": i } as CSSProperties}
            onClick={() => onOpen(s)}
            title="Open schedule details"
          >
            <div className="schedule-item-line1">
              <span className={`schedule-status-chip ${s.enabled ? "chip-enabled" : "chip-paused"}`}>
                {s.enabled ? "on" : "paused"}
              </span>
              <span className="schedule-name">{s.name}</span>
              <button
                className="schedule-toggle-btn"
                title={s.enabled ? "Pause schedule" : "Resume schedule"}
                aria-label={s.enabled ? "Pause schedule" : "Resume schedule"}
                onClick={(e) => { e.stopPropagation(); onToggle(s.id, !s.enabled) }}
              >
                {s.enabled ? "⏸" : "▶"}
              </button>
              <button
                className="schedule-run-btn"
                title="Run now"
                aria-label="Run now"
                onClick={(e) => { e.stopPropagation(); onRunNow(s.id) }}
              >
                ▶▶
              </button>
            </div>
            <div className="schedule-item-line2">
              <span className="schedule-recur" title={recurrenceSummary(s.recurrence)}>
                {recurrenceSummary(s.recurrence)}
              </span>
              <span className="schedule-next">· {nextRunText(s, now)}</span>
              {last && (
                <span className={`schedule-last tone-${tone}`}>
                  <span className="schedule-last-dot" /> last {last.status}
                </span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
