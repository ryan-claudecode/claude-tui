import ReactMarkdown from "react-markdown"

interface RuledOut { id: string; text: string; correction?: string }
interface Note { id: string; text: string }
interface TermRow { id: string; name: string; lastState: string; activity?: string }

export interface OverviewProps {
  id: string
  name: string
  status: string
  summary: string
  notes: Note[]
  ruledOut: RuledOut[]
  provisionalFindings: Note[]
  terminals: TermRow[]
  onReopenTerminal?: (terminalId: string) => void
}

export default function SessionOverviewPanel(props: OverviewProps) {
  const { name, summary, notes, ruledOut, provisionalFindings, terminals } = props
  return (
    <div className="overview-panel">
      <h2 className="overview-title">{name}</h2>

      <section className="overview-section">
        <h3>Summary</h3>
        {summary.trim() ? (
          <ReactMarkdown>{summary}</ReactMarkdown>
        ) : (
          <div className="overview-empty">No summary yet.</div>
        )}
      </section>

      <section className="overview-section">
        <h3>Findings</h3>
        {notes.length ? (
          <ul className="overview-notes">
            {notes.map((n) => <li key={n.id}>{n.text}</li>)}
          </ul>
        ) : (
          <div className="overview-empty">No findings recorded.</div>
        )}
      </section>

      {ruledOut.length > 0 && (
        <details className="overview-section">
          <summary>Ruled out / corrected ({ruledOut.length})</summary>
          <ul className="overview-ruledout">
            {ruledOut.map((r) => (
              <li key={r.id}>
                <span className="struck">{r.text}</span>
                {r.correction && <span className="correction"> → {r.correction}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {provisionalFindings.length > 0 && (
        <section className="overview-section">
          <h3>Provisional (needs validation)</h3>
          <ul className="overview-notes">
            {provisionalFindings.map((n) => (
              <li key={n.id}>
                {n.text}
                <button className="overview-mini" disabled>Promote</button>
                <button className="overview-mini" disabled>Dismiss</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="overview-section">
        <h3>Terminals</h3>
        <ul className="overview-terminals">
          {terminals.map((t) => (
            <li key={t.id}>
              <span className={`status-dot ${t.lastState}`} />
              <span className="overview-term-name">{t.name}</span>
              <span className="overview-term-activity">
                {t.lastState === "dead" ? "Stopped" : t.activity ?? "Idle"}
              </span>
              {t.lastState === "dead" && props.onReopenTerminal && (
                <button className="overview-mini" onClick={() => props.onReopenTerminal!(t.id)}>
                  Reopen
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <button className="overview-push" disabled title="Available once workspaces exist">
        Push context to workspace
      </button>
    </div>
  )
}
