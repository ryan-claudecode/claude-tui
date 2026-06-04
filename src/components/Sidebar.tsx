interface Props {
  sessions: Array<{ id: string; name: string; state: string }>
  activeId: string | null
  workspaces: Array<{ name: string }>
  onNewSession: () => void
  onKillSession: () => void
  onHandoff: () => void
  onSelectSession: (id: string) => void
  onSelectWorkspace?: (index: number) => void
}

export default function Sidebar({
  sessions, activeId, workspaces,
  onNewSession, onKillSession, onHandoff, onSelectSession, onSelectWorkspace,
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
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`sidebar-item session-item ${s.id === activeId ? "active" : ""}`}
            onClick={() => onSelectSession(s.id)}
          >
            <span className={`status-dot ${s.state}`}>●</span>
            <span>{s.name}</span>
          </div>
        ))}
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
        <div className="sidebar-hint handoff" onClick={onHandoff}>
          <span className="shortcut-key">Ctrl+H</span>
          <span className="shortcut-desc">Handoff</span>
        </div>
      </div>
    </div>
  )
}
