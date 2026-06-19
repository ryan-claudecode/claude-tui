interface Task { id: string; title: string; detail?: string; status: string; result?: string; reviewReason?: string }
interface Worker { sessionId: string; currentTaskId?: string }
interface Event { time: number; kind: string; text: string }
interface Props {
  id?: string; goal?: string; status?: string; autonomy?: string
  tasks?: Task[]; workers?: Worker[]; eventLog?: Event[]
  onStop?: (id: string) => void; onPause?: (id: string) => void
}

const STATUS_COLOR: Record<string, string> = {
  pending: "var(--text-2)", "in-progress": "var(--accent-bright)", assigned: "var(--accent-bright)",
  review: "var(--yellow, #d2a8ff)", done: "var(--green, #3fb950)", failed: "var(--red, #f85149)",
  // WW-2b — isolated-worker review states: amber for "needs review", red for conflict.
  "awaiting-review": "var(--attn-1)", "merge-conflict": "var(--red, #f85149)",
}

// WW-2b — short human label for the per-task status chip (the raw enum value is
// fine for most states; the two review states read better with a space).
function statusLabel(status: string): string {
  if (status === "awaiting-review") return "review"
  if (status === "merge-conflict") return "conflict"
  return status
}

export default function MissionPanel({ id, goal, status, autonomy, tasks = [], workers = [], eventLog = [], onStop, onPause }: Props) {
  const done = tasks.filter((t) => t.status === "done").length
  return (
    <div className="mission-panel">
      <div className="mission-header">
        <div className="mission-goal">{goal}</div>
        <div className="mission-meta">
          <span className={`mission-status mission-status-${status}`}>{status}</span>
          <span className="mission-autonomy">{autonomy}</span>
          <span className="mission-progress">{done}/{tasks.length} done</span>
        </div>
        <div className="mission-controls">
          <button onClick={() => id && onPause?.(id)}>Pause</button>
          <button onClick={() => id && onStop?.(id)}>Stop</button>
        </div>
      </div>
      <div className="mission-tasks">
        {tasks.map((t) => (
          <div key={t.id} className="mission-task">
            <span className="mission-task-dot" style={{ background: STATUS_COLOR[t.status] ?? "var(--text-2)" }} />
            <div className="mission-task-body">
              <div className="mission-task-title">{t.title}</div>
              {t.result && <div className="mission-task-result">{t.result}</div>}
              {t.status === "merge-conflict" && t.reviewReason && (
                <div className="mission-task-conflict">Conflict — branch preserved: {t.reviewReason}</div>
              )}
            </div>
            <span className={`mission-task-status mission-task-status-${t.status}`}>{statusLabel(t.status)}</span>
          </div>
        ))}
      </div>
      {workers.length > 0 && (
        <div className="mission-workers">Workers: {workers.map((w) => w.sessionId).join(", ")}</div>
      )}
      <div className="mission-log">
        {eventLog.slice(-30).map((e, i) => (
          <div key={i} className={`mission-log-line mission-log-${e.kind}`}>
            <span className="mission-log-time">{new Date(e.time).toLocaleTimeString()}</span> {e.text}
          </div>
        ))}
      </div>
    </div>
  )
}
