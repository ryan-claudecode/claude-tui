interface TermRow { id: string; name: string; lastState: string; activity?: string }

export interface OverviewProps {
  id: string
  name: string
  status: string
  terminals: TermRow[]
  onReopenTerminal?: (terminalId: string) => void
}

/**
 * Session Overview — a bird's-eye view of a work session's terminals + their
 * effective activity, plus the session identity/status header. (The knowledge tiers
 * — summary / findings / ruled-out — were removed in R3a; this is now a pure
 * terminal roster.)
 */
export default function SessionOverviewPanel(props: OverviewProps) {
  const { name, terminals } = props

  return (
    <div className="overview-panel">
      <h2 className="overview-title">{name}</h2>

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
    </div>
  )
}
