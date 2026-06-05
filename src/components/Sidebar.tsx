import { deriveSessionRow } from "../lib/sessionRow"

interface TerminalRow { id: string; name: string; lastState: string; activity?: string }
interface SessionRow { id: string; name: string; status: string; terminals: TerminalRow[] }

interface Props {
  sessions: SessionRow[]
  activeSessionId: string | null
  workspaces: Array<{ name: string }>
  onNewSession: () => void
  onKillSession: () => void
  onSelectSession: (id: string) => void
  onSelectWorkspace?: (index: number) => void
  onShowOverview?: (sessionId: string) => void
}

export default function Sidebar({
  sessions, activeSessionId, workspaces,
  onNewSession, onKillSession, onSelectSession, onSelectWorkspace, onShowOverview,
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
          <div key={i} className="sidebar-item" onClick={() => onSelectWorkspace?.(i)}>
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
          const { dot, count, activity } = deriveSessionRow(s)
          const selected = activeSessionId === s.id
          return (
            <div
              key={s.id}
              className={`session-item ${selected ? "active" : ""}`}
              onClick={() => onSelectSession(s.id)}
            >
              <div className="session-item-line1">
                <span className={`status-dot ${dot}`} />
                <span className="session-name">{s.name}</span>
                <span className="session-count">{count} ▣</span>
                <button
                  className="session-overview-btn"
                  title="Session overview"
                  onClick={(e) => { e.stopPropagation(); onShowOverview?.(s.id) }}
                >
                  ⊕
                </button>
              </div>
              <div className="session-item-line2">{activity}</div>
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
