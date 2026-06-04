type StepStatus = "pending" | "active" | "done" | "error" | "skipped"

interface Step {
  label: string
  /** Drives the connector + icon styling. Defaults to "pending". */
  status?: StepStatus
  /** Optional sub-line under the label (e.g. elapsed time, error message). */
  detail?: string
}

interface Props {
  title?: string
  steps?: Step[]
  /** Optional overall completion 0–100. When omitted it's derived from step states. */
  percent?: number
}

const STATUS_ICON: Record<StepStatus, string> = {
  pending: "○",
  active: "◐",
  done: "✓",
  error: "✕",
  skipped: "⊘",
}

// A vertical stepper for a task pipeline: each step shows a status dot, label,
// and optional detail line, connected by a rail that fills as steps complete.
// Tops it with an overall progress bar. Distinct from TimelinePanel (chronological
// events) and KanbanPanel (grouped cards) — this is sequential task progress,
// ideal for narrating long-running autonomous work.
export default function ProgressPanel({ title, steps = [], percent }: Props) {
  if (steps.length === 0) {
    return <div className="panel-empty">No steps provided.</div>
  }

  const doneCount = steps.filter((s) => s.status === "done" || s.status === "skipped").length
  const pct =
    percent != null
      ? Math.max(0, Math.min(100, percent))
      : Math.round((doneCount / steps.length) * 100)
  const hasError = steps.some((s) => s.status === "error")

  return (
    <div className="progress-panel">
      {title && <h2 className="progress-title">{title}</h2>}
      <div className="progress-bar-wrap">
        <div className="progress-bar-track">
          <div
            className={`progress-bar-fill${hasError ? " has-error" : ""}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="progress-bar-pct">{pct}%</span>
      </div>
      <ol className="progress-steps">
        {steps.map((step, i) => {
          const status = step.status ?? "pending"
          return (
            <li className={`progress-step status-${status}`} key={i}>
              <span className="progress-step-marker">
                <span className="progress-step-icon">{STATUS_ICON[status]}</span>
              </span>
              <div className="progress-step-content">
                <div className="progress-step-label">{step.label}</div>
                {step.detail && <div className="progress-step-detail">{step.detail}</div>}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
