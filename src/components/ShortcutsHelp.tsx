interface Shortcut {
  keys: string[]
  desc: string
}

interface Group {
  title: string
  items: Shortcut[]
}

// Single source of truth for the app's keyboard shortcuts, mirrored from the
// handlers in App.tsx. Update here when adding a new binding.
const GROUPS: Group[] = [
  {
    title: "Sessions",
    items: [
      { keys: ["Ctrl", "N"], desc: "New session" },
      { keys: ["Ctrl", "K"], desc: "Kill active session" },
      { keys: ["Ctrl", "H"], desc: "Trigger handoff" },
      { keys: ["Ctrl", "1–9"], desc: "Switch to session by index" },
    ],
  },
  {
    title: "Layout",
    items: [
      { keys: ["Ctrl", "\\"], desc: "Toggle split panes" },
      { keys: ["Ctrl", "P"], desc: "Toggle panel drawer" },
      { keys: ["Ctrl", "Shift", "Z"], desc: "Focus mode (hide chrome)" },
      { keys: ["Esc"], desc: "Close most recent panel" },
    ],
  },
  {
    title: "General",
    items: [
      { keys: ["Ctrl", "Shift", "P"], desc: "Command palette" },
      { keys: ["Ctrl", "Shift", "F"], desc: "Search session history" },
      { keys: ["Ctrl", "/"], desc: "Keyboard shortcuts (this menu)" },
    ],
  },
]

interface Props {
  open: boolean
  onClose: () => void
}

export default function ShortcutsHelp({ open, onClose }: Props) {
  if (!open) return null

  return (
    <div className="shortcuts-overlay" onMouseDown={onClose}>
      <div className="shortcuts-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="shortcuts-header">
          <span className="shortcuts-title">Keyboard Shortcuts</span>
          <button className="shortcuts-close" onClick={onClose} title="Close">
            ×
          </button>
        </div>
        <div className="shortcuts-grid">
          {GROUPS.map((group) => (
            <div key={group.title} className="shortcuts-group">
              <div className="shortcuts-group-title">{group.title}</div>
              {group.items.map((s) => (
                <div key={s.desc} className="shortcuts-row">
                  <span className="shortcuts-desc">{s.desc}</span>
                  <span className="shortcuts-keys">
                    {s.keys.map((k, i) => (
                      <kbd key={i} className="shortcuts-kbd">
                        {k}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
