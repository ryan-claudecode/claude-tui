import { useState, useRef, useEffect, useCallback, useMemo } from "react"
import type { WorkspaceSummary } from "../hooks/useWorkspaces"
import { colorFor } from "../lib/workspaceColors"
import { menuNav } from "../lib/menuNav"

interface Props {
  workspaces: WorkspaceSummary[]
  /** The active workspace, or null for "All" mode. */
  active: WorkspaceSummary | null
  onSelectAll: () => void
  onSelectWorkspace: (id: string) => void
  onNewWorkspace: () => void
  onRenameWorkspace: (id: string, name: string) => void
  onDeleteWorkspace: (id: string) => void
  /** WS-F — re-run on-disk discovery (the ⟳ refresh in the dropdown header). May
   *  be async so the control can spin until it settles. */
  onRescanWorkspaces: () => void | Promise<void>
  /** WS-G (G2) — add a folder to an EXISTING workspace. Opens the native picker
   *  and adds each chosen dir (scaffolds workspace.json + toasts, G3). */
  onAddDir: (id: string, dir: string) => void | Promise<unknown>
  /** WS-G (G2) — remove a folder from an EXISTING workspace. */
  onRemoveDir: (id: string, dir: string) => void | Promise<unknown>
}

// G2 — show just the last path segment as the chip label (the full path is the
// title) so long absolute paths don't blow out the dropdown width. Mirrors the
// create-modal's dirLabel.
function dirLabel(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || dir
}

/**
 * WS-D — the workspace switcher: a compact PILL at the top of the sidebar (below
 * the brand, above NEEDS YOU) that shows the active workspace (colored dot + name
 * + ▾), and a warm, rounded, soft-shadowed DROPDOWN: a header row (a "Workspaces"
 * label + the WS-F ⟳ refresh), an "All" row, each workspace (✓ when active,
 * hover-revealed rename + delete), a divider, and "+ New workspace".
 *
 * Keyboard accessible: the pill is a button (Enter/Space opens). In the open
 * menu, ↑/↓ move the highlight, Enter activates, Esc closes (and returns focus to
 * the pill). Click-outside dismisses. The dropdown is `role=menu`; rows are
 * `role=menuitem`. Reduced-motion is honored via the CSS (.workspace-menu
 * animation is suppressed in the prefers-reduced-motion block).
 *
 * WS-F — the dropdown header carries a ⟳ refresh that re-runs on-disk discovery
 * on demand (discovery is no longer boot-only). It spins (CSS, reduced-motion
 * safe) while the rescan is in flight; it is NOT part of the ↑/↓ nav order (a
 * standalone control, like the per-row rename/delete) so the keyboard path stays
 * simple. It deliberately does NOT close the menu, so the user sees the list
 * update in place.
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
  onRescanWorkspaces,
  onAddDir,
  onRemoveDir,
}: Props) {
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  // The id of the workspace whose name is being edited inline (or null).
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")
  // WS-G (G2) — the id of the workspace whose inline FOLDERS panel is expanded (or
  // null). Toggled by the per-row 📁 folders control; only one expands at a time.
  const [foldersId, setFoldersId] = useState<string | null>(null)
  // WS-F — true while a re-scan is in flight (drives the ⟳ spin + disables it so a
  // double-click can't fire two overlapping scans).
  const [scanning, setScanning] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)
  // WS-F — guard the post-await setScanning(false) against a same-frame unmount
  // (e.g. the menu closes / the component unmounts while the scan is in flight).
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

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
    setFoldersId(null)
    // Return focus to the pill so the keyboard path stays anchored.
    requestAnimationFrame(() => pillRef.current?.focus())
  }, [])

  // WS-G (G2) — open the native folder picker (multi-select) and add each chosen
  // dir to this workspace. Reuses the SAME WS-B `dialog:open-directory` IPC the
  // create modal uses. Errors are owned by the parent action (it toasts).
  const addFolderTo = useCallback(
    async (id: string) => {
      try {
        const chosen = await window.api.openDirectoryDialog()
        for (const dir of chosen) await onAddDir(id, dir)
      } catch {
        // openDirectoryDialog failures are rare (the create modal toasts on its own);
        // a swallow here keeps the dropdown from throwing on a cancelled/odd dialog.
      }
    },
    [onAddDir],
  )

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

  // MAJOR 3 fix — move focus INTO the menu when it opens. The key handler lives
  // on the menu div, which is a SIBLING of the pill; without this, focus stays on
  // the pill and onMenuKeyDown never fires (↑/↓/Enter/Esc were all dead from the
  // keyboard). It backs off while inline-editing so it never steals focus from
  // the rename input — and re-takes menu focus once editing ENDS (editingId →
  // null) while still open, so keyboard nav stays live after a rename.
  useEffect(() => {
    if (open && !editingId) requestAnimationFrame(() => menuRef.current?.focus())
  }, [open, editingId])

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

  // WS-F — fire an on-demand re-scan. Spins the ⟳ while in flight (and disables it
  // so an overlapping scan can't start). Does NOT close the menu — the list
  // updates in place so the user sees newly-discovered workspaces appear. Errors
  // are owned by the parent (the hook toasts on failure); we only manage the spin.
  const handleRescan = useCallback(async () => {
    if (scanning) return
    setScanning(true)
    try {
      await onRescanWorkspaces()
    } finally {
      if (mountedRef.current) setScanning(false)
    }
  }, [scanning, onRescanWorkspaces])

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
      const result = menuNav(e.key, highlight, options.length)
      if (result.type === "none") return
      e.preventDefault()
      if (result.type === "move") {
        setHighlight(result.highlight)
      } else if (result.type === "close") {
        close()
      } else if (result.type === "activate") {
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
        <div
          ref={menuRef}
          className="workspace-menu"
          role="menu"
          aria-label="Switch workspace"
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
        >
          {/* WS-F — dropdown header: a quiet label + the ⟳ refresh that re-runs
              on-disk discovery on demand. Not in the ↑/↓ nav order (standalone
              control). The spin is reduced-motion safe (CSS). */}
          <div className="workspace-menu-head">
            <span className="workspace-menu-head-label">Workspaces</span>
            <button
              type="button"
              className={`workspace-rescan-btn${scanning ? " scanning" : ""}`}
              title={scanning ? "Scanning…" : "Re-scan for workspaces"}
              aria-label={scanning ? "Scanning for workspaces" : "Re-scan for workspaces"}
              aria-busy={scanning}
              disabled={scanning}
              onClick={(e) => {
                e.stopPropagation()
                void handleRescan()
              }}
            >
              <span className="workspace-rescan-icon" aria-hidden="true">
                ⟳
              </span>
            </button>
          </div>
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
            const foldersOpen = foldersId === ws.id
            return (
              <div key={ws.id} className="workspace-menu-row-group">
                <div
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
                      {/* WS-G (G2) — toggle the inline folders editor for this
                          workspace. The dir count is shown as a quiet badge. */}
                      <button
                        type="button"
                        className={`workspace-row-btn${foldersOpen ? " active" : ""}`}
                        title="Manage folders"
                        aria-label={`Manage folders for ${ws.name}`}
                        aria-expanded={foldersOpen}
                        onClick={(e) => {
                          e.stopPropagation()
                          setFoldersId((cur) => (cur === ws.id ? null : ws.id))
                        }}
                      >
                        <span aria-hidden="true">📁</span>
                        {ws.dirs.length > 0 && (
                          <span className="workspace-folder-count">{ws.dirs.length}</span>
                        )}
                      </button>
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

                {/* WS-G (G2) — the inline FOLDERS editor: removable dir chips + an
                    "+ Add folder" that opens the native picker. Click-stop so
                    interacting with it never activates/closes the row. */}
                {foldersOpen && (
                  <div
                    className="workspace-folders-panel"
                    onClick={(e) => e.stopPropagation()}
                    onMouseEnter={() => setHighlight(i)}
                  >
                    {ws.dirs.length === 0 ? (
                      <span className="workspace-folders-empty">
                        No folders yet — add one so sessions open here.
                      </span>
                    ) : (
                      <div className="workspace-folders-chips">
                        {ws.dirs.map((dir) => (
                          <span key={dir} className="workspace-dir-chip" title={dir}>
                            <span className="workspace-dir-chip-label">{dirLabel(dir)}</span>
                            <button
                              type="button"
                              className="workspace-dir-chip-remove"
                              aria-label={`Remove folder ${dir}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                void onRemoveDir(ws.id, dir)
                              }}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      className="workspace-folders-add"
                      onClick={(e) => {
                        e.stopPropagation()
                        void addFolderTo(ws.id)
                      }}
                    >
                      + Add folder
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
