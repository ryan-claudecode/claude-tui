interface TerminalRow { id: string; name: string; lastState: string; activity?: string }
interface SessionRow { id: string; name: string; status: string; terminals: TerminalRow[] }

interface Props {
  sessions: SessionRow[]
  activeSessionId: string | null
  activeTerminalId: string | null
  workspaces: Array<{ name: string }>
  onNewSession: () => void
  onKillSession: () => void
  onSelectSession: (id: string) => void
  onSelectTerminal: (sessionId: string, terminalId: string) => void
  onSelectWorkspace?: (index: number) => void
  onShowOverview?: (sessionId: string) => void
}

export default function Sidebar({
  sessions, activeSessionId, activeTerminalId, workspaces,
  onNewSession, onKillSession, onSelectSession, onSelectTerminal, onSelectWorkspace, onShowOverview,
}: Props) {
  return (
    <div className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-icon">◈</span>
        <span>ClaudeTUI</span>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-header">WORKSPACES</div>
        {workspaces.length === 0 && (
          <div className="sidebar-empty">(no workspaces)</div>
        )}
        {workspaces.map((ws, i) => (
          <div
            key={i}
            className="sidebar-item"
            onClick={() => onSelectWorkspace?.(i)}
          >
            {ws.name}
          </div>
        ))}
      </div>

      <div className="sidebar-section sessions-section">
        <div className="sidebar-header">SESSIONS</div>
        {sessions.length === 0 && (
          <div className="sidebar-empty">(no sessions)</div>
        )}
        {sessions.map((s) => {
          const working = s.terminals.filter((t) => t.lastState === "active").length
          const dot = s.status === "stopped" ? "dead" : working > 0 ? "active" : "idle"
          const label =
            s.terminals.length === 0 ? "Empty"
            : s.status === "stopped" ? "Stopped"
            : working > 0 ? `${working} Terminal${working === 1 ? "" : "s"} Working`
            : "Idle"
          const selected = activeSessionId === s.id
          const [busy] = [...s.terminals].sort(
            (a, b) => (b.lastState === "active" ? 1 : 0) - (a.lastState === "active" ? 1 : 0),
          )
          return (
            <div key={s.id} className="session-group">
              <div
                className={`session-item ${selected ? "active" : ""}`}
                onClick={() => onSelectSession(s.id)}
              >
                <span className={`status-dot ${dot}`} />
                <span className="session-name">{s.name}</span>
                <span className="session-label">{label}</span>
                <button
                  className="session-overview-btn"
                  title="Session overview"
                  onClick={(e) => { e.stopPropagation(); onShowOverview?.(s.id) }}
                >
                  ⊕
                </button>
              </div>
              {!selected && busy?.activity && s.status !== "stopped" && (
                <div className="activity-line">{busy.activity}</div>
              )}
              {selected && s.terminals.map((t) => (
                <div
                  key={t.id}
                  className={`terminal-item ${activeTerminalId === t.id ? "active" : ""}`}
                  onClick={(e) => { e.stopPropagation(); onSelectTerminal(s.id, t.id) }}
                >
                  <span className={`status-dot ${t.lastState}`} />
                  <span className="terminal-name">{t.name}</span>
                  <span className="activity-inline">
                    {t.lastState === "dead" ? "Stopped" : t.lastState === "active" ? (t.activity ?? "") : "Idle"}
                  </span>
                </div>
              ))}
            </div>
          )
        })}
      </div>

      <div className="sidebar-actions">
        <div className="sidebar-hint new" onClick={onNewSession}>
          <span className="shortcut-key">Ctrl+N</span>
          <span className="shortcut-desc">New session</span>
        </div>
        <div className="sidebar-hint kill" onClick={onKillSession}>
          <span className="shortcut-key">Ctrl+K</span>
          <span className="shortcut-desc">Kill session</span>
        </div>
      </div>
    </div>
  )
}
