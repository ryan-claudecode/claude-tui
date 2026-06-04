type Level = "info" | "warn" | "error" | "debug" | "success"

interface LineObj {
  text: string
  /** Severity — drives the badge + line coloring. Defaults to "info". */
  level?: Level
  /** Optional timestamp label shown at the start of the line. */
  time?: string
}

interface Props {
  title?: string
  /** Lines may be plain strings or objects with a level/time. */
  lines?: (string | LineObj)[]
  /** Render with a leading severity badge per line. Default true. */
  showLevel?: boolean
}

const LEVELS: Record<Level, true> = {
  info: true,
  warn: true,
  error: true,
  debug: true,
  success: true,
}

function normalize(line: string | LineObj): LineObj {
  if (typeof line === "string") return { text: line, level: "info" }
  const level = line.level && LEVELS[line.level] ? line.level : "info"
  return { text: line.text, level, time: line.time }
}

// A scrollable, monospace log viewer with per-line severity coloring. The
// counterpart to ChartPanel/StatPanel for raw output: command logs, test runner
// streams, server output. Distinct from MarkdownPanel (prose) and TablePanel
// (structured rows).
export default function LogPanel({ title, lines = [], showLevel = true }: Props) {
  if (lines.length === 0) {
    return <div className="panel-empty">No log lines provided.</div>
  }

  const rows = lines.map(normalize)

  return (
    <div className="log-panel">
      {title && <h2 className="log-title">{title}</h2>}
      <div className="log-body">
        {rows.map((row, i) => (
          <div className={`log-line level-${row.level}`} key={i}>
            {row.time && <span className="log-time">{row.time}</span>}
            {showLevel && <span className="log-badge">{(row.level ?? "info").toUpperCase()}</span>}
            <span className="log-text">{row.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
