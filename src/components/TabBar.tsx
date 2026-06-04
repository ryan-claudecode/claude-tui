import { useState, useCallback } from "react"

interface Props {
  terminals: Array<{ id: string; name: string; lastState: string }>
  activeTerminalId: string | null
  splitId: string | null
  onSelectTerminal: (id: string) => void
  onCloseTerminal: (id: string) => void
  onRenameTerminal: (id: string, newName: string) => void
}

export default function TabBar({
  terminals,
  activeTerminalId,
  splitId,
  onSelectTerminal,
  onCloseTerminal,
  onRenameTerminal,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")

  const commitRename = useCallback(() => {
    if (editingId && editValue.trim()) {
      onRenameTerminal(editingId, editValue.trim())
    }
    setEditingId(null)
  }, [editingId, editValue, onRenameTerminal])

  if (terminals.length === 0) return <div className="tab-bar" />

  return (
    <div className="tab-bar">
      {terminals.map((t) => (
        <div
          key={t.id}
          className={`tab ${t.id === activeTerminalId ? "active" : ""} ${t.id === splitId ? "split" : ""}`}
          onClick={() => onSelectTerminal(t.id)}
        >
          {editingId === t.id ? (
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
                setEditingId(t.id)
                setEditValue(t.name)
              }}
            >
              {t.name}
            </span>
          )}
          <span
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation()
              onCloseTerminal(t.id)
            }}
          >
            &times;
          </span>
        </div>
      ))}
    </div>
  )
}
