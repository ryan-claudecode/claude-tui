interface TestFields {
  command?: string
  cwd?: string
  success?: boolean
  exitCode?: number | null
  status?: "running" | "passed" | "failed" | "error"
  passed?: number | null
  failed?: number | null
  skipped?: number | null
  total?: number | null
  durationMs?: number
  output?: string
}

// Accepts either a nested { result } payload or flat fields directly, so the
// panel renders regardless of which producer fills it (one-shot or streaming).
interface Props extends TestFields {
  result?: TestFields
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`
}

export default function TestPanel(props: Props) {
  const data: TestFields = props.result ?? props
  const hasData = data.command !== undefined || data.output !== undefined

  if (!hasData) {
    return <div className="panel-empty">No test result provided.</div>
  }

  const {
    command = "",
    exitCode,
    status,
    passed,
    failed,
    skipped,
    total,
    durationMs = 0,
    output = "",
  } = data

  // Derive a verdict: explicit status wins, else fall back to success/exitCode.
  const verdict: "running" | "pass" | "fail" =
    status === "running"
      ? "running"
      : status === "passed" || data.success === true || (status === undefined && exitCode === 0)
        ? "pass"
        : "fail"

  const statusLabel =
    verdict === "running" ? "Running…" : verdict === "pass" ? "Passed" : "Failed"
  const icon = verdict === "running" ? "●" : verdict === "pass" ? "✓" : "✕"

  return (
    <div className="test-panel">
      <div className={`test-status test-status-${verdict}`}>
        <span className="test-status-icon">{icon}</span>
        <span className="test-status-label">{statusLabel}</span>
        <span className="test-status-meta">
          {exitCode !== null && exitCode !== undefined ? `exit ${exitCode} · ` : ""}
          {formatDuration(durationMs)}
        </span>
      </div>

      <div className="test-stats">
        {passed !== null && passed !== undefined && (
          <div className="test-stat test-stat-pass">
            <span className="test-stat-value">{passed}</span>
            <span className="test-stat-label">passed</span>
          </div>
        )}
        {failed !== null && failed !== undefined && (
          <div className="test-stat test-stat-fail">
            <span className="test-stat-value">{failed}</span>
            <span className="test-stat-label">failed</span>
          </div>
        )}
        {skipped !== null && skipped !== undefined && skipped > 0 && (
          <div className="test-stat test-stat-skip">
            <span className="test-stat-value">{skipped}</span>
            <span className="test-stat-label">skipped</span>
          </div>
        )}
        {total !== null && total !== undefined && (
          <div className="test-stat test-stat-total">
            <span className="test-stat-value">{total}</span>
            <span className="test-stat-label">total</span>
          </div>
        )}
      </div>

      <div className="test-command">
        <span className="test-command-prompt">$</span>
        <code>{command}</code>
      </div>

      <pre className="test-output">{output || "(no output)"}</pre>
    </div>
  )
}
