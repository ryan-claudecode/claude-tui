import { useRef } from "react"
import { useFocusTrap } from "../hooks/useFocusTrap"
import { modKeyLabel } from "../lib/platform"

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
// The mod key label ("Ctrl" or "Cmd") is injected at render time from platform.
function buildGroups(mod: string): Group[] {
  return [
    {
      title: "Sessions",
      items: [
        { keys: [mod, "N"], desc: "New session" },
        { keys: [mod, "K"], desc: "Kill active session" },
        { keys: [mod, "Shift", "H"], desc: "Retire & continue (handoff)" },
        { keys: [mod, "1–9"], desc: "Switch to session by index" },
        { keys: [mod, "T"], desc: "New terminal" },
        { keys: [mod, "W"], desc: "Close terminal" },
        { keys: ["Alt", "1–9"], desc: "Switch terminal by index" },
      ],
    },
    {
      title: "Layout",
      items: [
        { keys: [mod, "\\"], desc: "Toggle split panes" },
        { keys: [mod, "Shift", "Z"], desc: "Focus mode (hide chrome)" },
        { keys: ["Esc"], desc: "Close overlay" },
      ],
    },
    {
      title: "General",
      items: [
        { keys: [mod, "Shift", "P"], desc: "Command palette" },
        { keys: [mod, "Shift", "F"], desc: "Search session history" },
        { keys: [mod, "J"], desc: "Jump to top of attention queue" },
        { keys: [mod, "/"], desc: "Keyboard shortcuts (this menu)" },
      ],
    },
  ]
}

interface Props {
  open: boolean
  onClose: () => void
}

export default function ShortcutsHelp({ open, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)

  if (!open) return null

  const mod = modKeyLabel(window.api.platform)
  const groups = buildGroups(mod)

  return (
    <div className="shortcuts-overlay" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className="shortcuts-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="shortcuts-header">
          <span className="shortcuts-title">Keyboard Shortcuts</span>
          <button className="shortcuts-close" onClick={onClose} aria-label="Close keyboard shortcuts">
            ×
          </button>
        </div>
        <div className="shortcuts-grid">
          {groups.map((group) => (
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
