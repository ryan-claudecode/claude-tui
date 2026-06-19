import { useState, useRef, useEffect, useCallback, useMemo } from "react"
import type { WorkspaceSummary } from "../hooks/useWorkspaces"
import { colorFor } from "../lib/workspaceColors"

interface Props {
  workspaces: WorkspaceSummary[]
  /** The active workspace, or null for "All" mode. */
  active: WorkspaceSummary | null
  onSelectAll: () => void
  onSelectWorkspace: (id: string) => void
  onNewWorkspace: () => void
  onRenameWorkspace: (id: string, name: string) => void
  onDeleteWorkspace: (id: string) => void
}

/**
 * WS-D — the workspace switcher: a compact PILL at the top of the sidebar (below
 * the brand, above NEEDS YOU) that shows the active workspace (colored dot + name
 * + ▾), and a warm, rounded, soft-shadowed DROPDOWN: an "All" row, each
 * workspace (✓ when active, hover-revealed rename + delete), a divider, and
 * "+ New workspace".
 *
 * Keyboard accessible: the pill is a button (Enter/Space opens). In the open
 * menu, ↑/↓ move the highlight, Enter activates, Esc closes (and returns focus to
 * the pill). Click-outside dismisses. The dropdown is `role=menu`; rows are
 * `role=menuitem`. Reduced-motion is honored via the CSS (.workspace-menu
 * animation is suppressed in the prefers-reduced-motion block).
 */

// The flat, navigable option list: "All" (index 0), then one per workspace,
// then "New" (last). Keyboard ↑/↓ walk this list; rename/delete are mouse-only
// hover affordances (not in the nav order) so the keyboard path stays simple.
type Option =
  | { kind: "all" }
  | { kind: "workspace"; ws: WorkspaceSummary; colorIndex: number }
  | { kind: "new" }

export default function WorkspaceSwitcher({
  workspaces,
  active,
  onSelectAll,
  onSelectWorkspace,
  onNewWorkspace,
  onRenameWorkspace,
  onDeleteWorkspace,
}: Props) {
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  // The id of the workspace whose name is being edited inline (or null).
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")
  const rootRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLButtonElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)

  const options = useMemo<Option[]>(
    () => [
      { kind: "all" },
      ...workspaces.map((ws, i) => ({ kind: "workspace" as const, ws, colorIndex: i })),
      { kind: "new" },
    ],
    [workspaces],
  )

  const close = useCallback(() => {
    setOpen(false)
    setEditingId(null)
    // Return focus to the pill so the keyboard path stays anchored.
    requestAnimationFrame(() => pillRef.current?.focus())
  }, [])

  // Open the menu with the active workspace (or "All") pre-highlighted.
  const openMenu = useCallback(() => {
    const activeIdx = active ? options.findIndex((o) => o.kind === "workspace" && o.ws.id === active.id) : 0
    setHighlight(activeIdx >= 0 ? activeIdx : 0)
    setOpen(true)
  }, [active, options])

  // Click-outside dismiss. Bound only while open.
  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close()
    }
    document.addEventListener("mousedown", onDocMouseDown, true)
    return () => document.removeEventListener("mousedown", onDocMouseDown, true)
  }, [open, close])

  // Focus the inline rename input when editing begins.
  useEffect(() => {
    if (editingId) requestAnimationFrame(() => editInputRef.current?.select())
  }, [editingId])

  const activateOption = useCallback(
    (opt: Option) => {
      if (opt.kind === "all") onSelectAll()
      else if (opt.kind === "workspace") onSelectWorkspace(opt.ws.id)
      else onNewWorkspace()
      close()
    },
    [onSelectAll, onSelectWorkspace, onNewWorkspace, close],
  )

  const commitRename = useCallback(() => {
    const id = editingId
    if (!id) return
    const trimmed = editValue.trim()
    const ws = workspaces.find((w) => w.id === id)
    // Only fire the IPC when the name actually changed and is non-empty.
    if (trimmed && ws && trimmed !== ws.name) onRenameWorkspace(id, trimmed)
    setEditingId(null)
  }, [editingId, editValue, workspaces, onRenameWorkspace])

  const onMenuKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // While inline-editing, let the input own its keys (handled there).
      if (editingId) return
      if (e.key === "Escape") {
        e.preventDefault()
        close()
      } else if (e.key === "ArrowDown") {
        e.preventDefault()
        setHighlight((h) => (h + 1) % options.length)
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setHighlight((h) => (h - 1 + options.length) % options.length)
      } else if (e.key === "Enter") {
        e.preventDefault()
        const opt = options[highlight]
        if (opt) activateOption(opt)
      }
    },
    [editingId, options, highlight, close, activateOption],
  )

  const onPillKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        openMenu()
      }
    },
    [openMenu],
  )

  const isAllActive = active == null

  return (
    <div className="workspace-switcher" ref={rootRef}>
      <button
        ref={pillRef}
        type="button"
        className={`workspace-pill${open ? " open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={isAllActive ? "All workspaces" : `Workspace: ${active!.name}`}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onPillKeyDown}
      >
        <span
          className={`workspace-dot${isAllActive ? " all" : ""}`}
          style={isAllActive ? undefined : { background: colorFor(active, workspaces.findIndex((w) => w.id === active!.id)) }}
        />
        <span className="workspace-pill-name">{isAllActive ? "All workspaces" : active!.name}</span>
        <span className="workspace-pill-chevron" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="workspace-menu" role="menu" aria-label="Switch workspace" onKeyDown={onMenuKeyDown}>
          {options.map((opt, i) => {
            const highlighted = i === highlight
            if (opt.kind === "all") {
              return (
                <button
                  key="all"
                  type="button"
                  role="menuitem"
                  className={`workspace-menu-item${highlighted ? " highlight" : ""}`}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => activateOption(opt)}
                >
                  <span className="workspace-dot all" />
                  <span className="workspace-menu-name">All workspaces</span>
                  {isAllActive && <span className="workspace-check" aria-hidden="true">✓</span>}
                </button>
              )
            }
            if (opt.kind === "new") {
              return (
                <div key="new-group">
                  <div className="workspace-menu-divider" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    className={`workspace-menu-item workspace-menu-new${highlighted ? " highlight" : ""}`}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => activateOption(opt)}
                  >
                    <span className="workspace-new-plus" aria-hidden="true">
                      +
                    </span>
                    <span className="workspace-menu-name">New workspace</span>
                  </button>
                </div>
              )
            }
            // A workspace row.
            const ws = opt.ws
            const selected = active?.id === ws.id
            const editing = editingId === ws.id
            return (
              <div
                key={ws.id}
                role="menuitem"
                className={`workspace-menu-item${highlighted ? " highlight" : ""}${selected ? " selected" : ""}`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => !editing && activateOption(opt)}
              >
                <span className="workspace-dot" style={{ background: colorFor(ws, opt.colorIndex) }} />
                {editing ? (
                  <input
                    ref={editInputRef}
                    className="workspace-rename-input"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        commitRename()
                      } else if (e.key === "Escape") {
                        e.preventDefault()
                        e.stopPropagation()
                        setEditingId(null)
                      }
                    }}
                    onBlur={commitRename}
                  />
                ) : (
                  <span className="workspace-menu-name">{ws.name}</span>
                )}
                {!editing && selected && <span className="workspace-check" aria-hidden="true">✓</span>}
                {!editing && (
                  <span className="workspace-row-actions">
                    <button
                      type="button"
                      className="workspace-row-btn"
                      title="Rename workspace"
                      aria-label={`Rename workspace ${ws.name}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditValue(ws.name)
                        setEditingId(ws.id)
                      }}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="workspace-row-btn workspace-row-delete"
                      title="Delete workspace"
                      aria-label={`Delete workspace ${ws.name}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (window.confirm(`Delete the workspace "${ws.name}"? Its sessions and missions are kept (they fall back to All).`)) {
                          onDeleteWorkspace(ws.id)
                        }
                      }}
                    >
                      ×
                    </button>
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
