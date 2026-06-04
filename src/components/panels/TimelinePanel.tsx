interface Step {
  label: string
  status?: "done" | "active" | "pending" | "error"
  detail?: string
  /** Optional timestamp or duration shown on the right. */
  meta?: string
}

interface Props {
  title?: string
  steps?: Step[]
}

const ICON: Record<string, string> = {
  done: "✓",
  active: "●",
  pending: "○",
  error: "✕",
}

export default function TimelinePanel({ title, steps = [] }: Props) {
  if (steps.length === 0) {
    return <div className="panel-empty">No timeline steps provided.</div>
  }

  const doneCount = steps.filter((s) => s.status === "done").length
  const pct = Math.round((doneCount / steps.length) * 100)

  return (
    <div className="timeline-panel">
      {title && (
        <div className="timeline-head">
          <h2 className="timeline-title">{title}</h2>
          <span className="timeline-progress-label">
            {doneCount}/{steps.length} · {pct}%
          </span>
        </div>
      )}
      <div className="timeline-progress-bar">
        <div className="timeline-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <ol className="timeline-list">
        {steps.map((step, i) => {
          const status = step.status ?? "pending"
          const isLast = i === steps.length - 1
          return (
            <li key={i} className={`timeline-step timeline-${status}`}>
              <div className="timeline-marker">
                <span className="timeline-dot">{ICON[status]}</span>
                {!isLast && <span className="timeline-connector" />}
              </div>
              <div className="timeline-content">
                <div className="timeline-step-head">
                  <span className="timeline-label">{step.label}</span>
                  {step.meta && <span className="timeline-meta">{step.meta}</span>}
                </div>
                {step.detail && <div className="timeline-detail">{step.detail}</div>}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
