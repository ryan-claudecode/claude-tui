import { useState, useCallback } from "react"
import { commitRenameValue } from "../lib/renameValue"

interface Props {
  terminals: Array<{ id: string; name: string; lastState: string; activity?: string }>
  activeTerminalId: string | null
  splitId: string | null
  onSelectTerminal: (id: string) => void
  onCloseTerminal: (id: string) => void
  onRenameTerminal: (id: string, newName: string) => void
  onNewTerminal: () => void
  // PP: companion panel presence indicator
  panelCount?: number
  panelsRecentlyChanged?: boolean
  onFocusCompanion?: () => void
}

export default function TabBar({
  terminals,
  activeTerminalId,
  splitId,
  onSelectTerminal,
  onCloseTerminal,
  onRenameTerminal,
  onNewTerminal,
  panelCount = 0,
  panelsRecentlyChanged = false,
  onFocusCompanion,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")

  // CAPP-82 — share the trim + blank-revert + changed-flag policy with the session
  // row editor via commitRenameValue, so the two inline editors can't drift. Skip
  // the IPC call when the name didn't actually change (no-op rename).
  const commitRename = useCallback(() => {
    if (editingId) {
      const prev = terminals.find((t) => t.id === editingId)?.name ?? ""
      const { name, changed } = commitRenameValue(editValue, prev)
      if (changed) onRenameTerminal(editingId, name)
    }
    setEditingId(null)
  }, [editingId, editValue, terminals, onRenameTerminal])

  return (
    <div className="tab-bar">
      {terminals.map((t) => (
        <div
          key={t.id}
          className={`tab ${t.id === activeTerminalId ? "active" : ""} ${t.id === splitId ? "split" : ""}`}
          onClick={() => onSelectTerminal(t.id)}
          title={t.activity ? `${t.name} — ${t.activity}` : t.name}
        >
          <span className={`status-dot ${t.lastState}`} />
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
              onFocus={(e) => e.currentTarget.select()}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              className="tab-name"
              onDoubleClick={() => {
                setEditingId(t.id)
                setEditValue(t.name)
              }}
            >
              {t.name}
            </span>
          )}
          <button
            className="tab-close"
            aria-label={`Close terminal ${t.name}`}
            onClick={(e) => {
              e.stopPropagation()
              onCloseTerminal(t.id)
            }}
          >
            &times;
          </button>
        </div>
      ))}
      <button className="tab-new" title="New terminal in this session" aria-label="New terminal in this session" onClick={onNewTerminal}>
        +
      </button>
      {panelCount > 0 && (
        <button
          className={`panel-presence${panelsRecentlyChanged ? " panel-presence--pulse" : ""}`}
          title={`${panelCount} panel${panelCount === 1 ? "" : "s"} open — click to raise`}
          aria-label={`${panelCount} panel${panelCount === 1 ? "" : "s"} open`}
          onClick={onFocusCompanion}
        >
          <span className="panel-presence-icon">⬡</span>
          <span className="panel-presence-count">{panelCount}</span>
        </button>
      )}
    </div>
  )
}
