interface Props {
  sessions: Array<{ id: string; name: string }>
  activeId: string | null
  onSelectSession: (id: string) => void
}

export default function TabBar({ sessions, activeId, onSelectSession }: Props) {
  if (sessions.length === 0) return <div className="tab-bar" />

  return (
    <div className="tab-bar">
      {sessions.map((s) => (
        <div
          key={s.id}
          className={`tab ${s.id === activeId ? "active" : ""}`}
          onClick={() => onSelectSession(s.id)}
        >
          {s.name}
        </div>
      ))}
    </div>
  )
}
