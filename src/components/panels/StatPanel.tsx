interface Stat {
  label: string
  value: string | number
  /** Optional unit shown after the value, e.g. "%", "ms", "MB". */
  unit?: string
  /** Optional change indicator, e.g. "+12" or "-3.2%". */
  delta?: string
  /** Direction of the delta — drives the arrow + color. */
  trend?: "up" | "down" | "flat"
  /** Optional accent color for the value + top border. */
  color?: string
  /** Optional sub-label / context line under the value. */
  hint?: string
}

interface Props {
  title?: string
  stats?: Stat[]
}

const TREND_ARROW: Record<string, string> = { up: "▲", down: "▼", flat: "→" }

// A dashboard of big-number stat cards (label, value, optional delta/trend).
// Distinct from ChartPanel (series viz) — this is the at-a-glance KPI grid:
// test counts, coverage %, build time, bundle size, request latency, etc.
export default function StatPanel({ title, stats = [] }: Props) {
  if (stats.length === 0) {
    return <div className="panel-empty">No stats provided.</div>
  }

  return (
    <div className="stat-panel">
      {title && <h2 className="stat-title">{title}</h2>}
      <div className="stat-grid">
        {stats.map((stat, i) => (
          <div
            className="stat-card"
            key={i}
            style={stat.color ? { borderTopColor: stat.color } : undefined}
          >
            <div className="stat-card-label">{stat.label}</div>
            <div className="stat-card-value" style={stat.color ? { color: stat.color } : undefined}>
              {stat.value}
              {stat.unit && <span className="stat-card-unit">{stat.unit}</span>}
            </div>
            <div className="stat-card-foot">
              {stat.delta && (
                <span className={`stat-card-delta trend-${stat.trend ?? "flat"}`}>
                  {TREND_ARROW[stat.trend ?? "flat"]} {stat.delta}
                </span>
              )}
              {stat.hint && <span className="stat-card-hint">{stat.hint}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
