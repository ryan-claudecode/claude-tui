import { useState, useCallback } from "react"

interface Props {
  sessions: Array<{ id: string; name: string }>
  activeId: string | null
  splitId: string | null
  onSelectSession: (id: string) => void
  onKillSession: (id: string) => void
  onRenameSession: (id: string, newName: string) => void
}

export default function TabBar({
  sessions,
  activeId,
  splitId,
  onSelectSession,
  onKillSession,
  onRenameSession,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")

  const commitRename = useCallback(() => {
    if (editingId && editValue.trim()) {
      onRenameSession(editingId, editValue.trim())
    }
    setEditingId(null)
  }, [editingId, editValue, onRenameSession])

  if (sessions.length === 0) return <div className="tab-bar" />

  return (
    <div className="tab-bar">
      {sessions.map((s) => (
        <div
          key={s.id}
          className={`tab ${s.id === activeId ? "active" : ""} ${s.id === splitId ? "split" : ""}`}
          onClick={() => onSelectSession(s.id)}
        >
          {editingId === s.id ? (
            <input
              className="tab-rename-input"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  commitRename()
                }
                if (e.key === "Escape") {
                  setEditingId(null)
                }
              }}
              onBlur={commitRename}
              autoFocus
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              onDoubleClick={() => {
                setEditingId(s.id)
                setEditValue(s.name)
              }}
            >
              {s.name}
            </span>
          )}
          <span
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation()
              onKillSession(s.id)
            }}
          >
            &times;
          </span>
        </div>
      ))}
    </div>
  )
}
