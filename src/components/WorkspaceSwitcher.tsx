import { useState, useRef, useEffect, useCallback, useMemo } from "react"
import type { WorkspaceSummary } from "../hooks/useWorkspaces"
import { colorFor } from "../lib/workspaceColors"
import { dirBasename } from "../lib/workspaceForm"
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
  /** WS-H — set (or clear, with null) the active workspace's single folder. The
   *  dir-row click opens the native picker and calls this with the chosen path. */
  onSetWorkspaceDir: (id: string, dir: string | null) => void | Promise<unknown>
  /** CAPP-75 — open the "Restore a conversation" picker for the active workspace's
   *  folder. Only relevant when the active workspace HAS a folder (the button is
   *  hidden otherwise). */
  onRestoreConversation: () => void
  /** CAPP-94 — open the workspace-memory editor (companion panel) for the active
   *  workspace, or the untagged "All" bucket when none is selected. Always-visible. */
  onOpenWorkspaceMemory: () => void
  /** CAPP-98 / I1 — open the READ-ONLY Context Inspector (companion panel) for the active
   *  workspace, or the untagged "All" bucket when none is selected. Always-visible. */
  onOpenContextInspector: () => void
}

/**
 * WS-H — the workspace area (redesigned). A "WORKSPACE" section header (singular),
 * a SELECT-ONLY pill dropdown, and — only when a SPECIFIC workspace is active — an
 * explicitly-visible folder row + rename + delete controls beneath the pill.
 *
 * THE DROPDOWN ONLY SELECTS. It is a top "All" row, the workspace list (color dot +
 * name — NO per-row rename/delete/folder affordances, NO hover-reveal), a divider,
 * and "+ New workspace". Selecting → setActiveWorkspace. Keyboard accessible: the
 * pill is a button (Enter/Space opens); in the open menu ↑/↓ move the highlight,
 * Enter activates, Esc closes (and returns focus to the pill). Click-outside
 * dismisses. Reduced-motion is honored via CSS.
 *
 * BELOW THE PILL — a single COMPACT control row (CAPP-123, replacing CAPP-122's
 * icon-only row): small, muted-at-rest TEXT buttons (words over icons — no hover
 * needed to know what each does), wrapping to two lines on a narrow sidebar. Each is
 * a distinct focusable <button> whose visible label carries the meaning (aria-label +
 * title are SUPPLEMENTS, never the sole identification):
 *  - "Memory" + "Context" in BOTH modes (the untagged "All" bucket has its own
 *    durable memory + launch context — the untagged entry point).
 *  - "Rename" + "Delete" only for a SPECIFIC active workspace (rename toggles the
 *    inline input below; delete keeps the danger tint + the existing window.confirm).
 *
 * FOR A SPECIFIC ACTIVE WORKSPACE, below that row (ALWAYS VISIBLE, NO hover-reveal):
 *  - the inline rename input (shown while renaming; Enter commits, Esc cancels).
 *  - the folder row — shows the folder's PARENT FOLDER NAME (basename of `dir`) or
 *    "No folder selected"; clicking it opens the native single-folder picker and
 *    sets/changes the folder (the ONLY place to set the folder).
 *  - the "Restore a conversation" button (only when a folder is set).
 */

// The flat, navigable option list: "All" (index 0), then one per workspace,
// then "New" (last). Keyboard ↑/↓ walk this list.
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
  onSetWorkspaceDir,
  onRestoreConversation,
  onOpenWorkspaceMemory,
  onOpenContextInspector,
}: Props) {
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  // True while the active workspace's name is being renamed inline (below the pill).
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState("")
  const rootRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
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

  // Move focus INTO the menu when it opens so its key handler (↑/↓/Enter/Esc) fires.
  useEffect(() => {
    if (open) requestAnimationFrame(() => menuRef.current?.focus())
  }, [open])

  // Focus the inline rename input when editing begins.
  useEffect(() => {
    if (editing) requestAnimationFrame(() => editInputRef.current?.select())
  }, [editing])

  // Cancel any in-flight rename when the active workspace changes out from under us.
  useEffect(() => {
    setEditing(false)
  }, [active?.id])

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
    if (!active) return
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== active.name) onRenameWorkspace(active.id, trimmed)
    setEditing(false)
  }, [active, editValue, onRenameWorkspace])

  // WS-H — open the native (single-select) folder picker and set/change the active
  // workspace's folder. The ONLY place the folder is set.
  const pickFolder = useCallback(async () => {
    if (!active) return
    try {
      const chosen = await window.api.openDirectoryDialog()
      if (chosen.length) await onSetWorkspaceDir(active.id, chosen[0])
    } catch {
      // openDirectoryDialog failures are rare; the parent action toasts on its own.
    }
  }, [active, onSetWorkspaceDir])

  const onMenuKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
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
    [options, highlight, close, activateOption],
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
  const activeColorIndex = active ? workspaces.findIndex((w) => w.id === active.id) : -1

  return (
    <div className="workspace-switcher" ref={rootRef}>
      <div className="workspace-section-header">WORKSPACE</div>

      {/* The selector: pill + its dropdown, in a relative wrapper so the menu
          anchors below the PILL (not the whole workspace area). */}
      <div className="workspace-selector">
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
          style={isAllActive ? undefined : { background: colorFor(active, activeColorIndex) }}
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
            // A workspace row — SELECT-ONLY: color dot + name + (✓ when active). No
            // per-row rename/delete/folder controls, no hover-reveal.
            const ws = opt.ws
            const selected = active?.id === ws.id
            return (
              <button
                key={ws.id}
                type="button"
                role="menuitem"
                className={`workspace-menu-item${highlighted ? " highlight" : ""}${selected ? " selected" : ""}`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => activateOption(opt)}
              >
                <span className="workspace-dot" style={{ background: colorFor(ws, opt.colorIndex) }} />
                <span className="workspace-menu-name">{ws.name}</span>
                {selected && <span className="workspace-check" aria-hidden="true">✓</span>}
              </button>
            )
          })}
        </div>
      )}
      </div>

      {/* CAPP-123 — ONE compact control row under the selector pill. Replaces the
          CAPP-122 icon-only row (🧠/📄/✏/🗑) — which had no hover state to identify it and
          relied on title tooltips — with small, muted-at-rest TEXT buttons (words over
          icons). Still far denser than the pre-CAPP-122 full-width stacked buttons: one
          wrapping row of snug pills, muted at rest, hover DEEPENS (never a hover-REVEAL).
          Each is a distinct focusable <button> whose VISIBLE LABEL carries the meaning;
          aria-label + title are supplements.
            - "Memory" + "Context" render in BOTH modes (the untagged "All" bucket has
              its own durable memory + launch context — this is the untagged entry point,
              preserved; the handlers capture the workspaceId at click time).
            - "Rename" + "Delete" render only for a SPECIFIC active workspace. */}
      <div className="workspace-controls">
        <button
          type="button"
          className="workspace-ctl-btn wsctl-memory"
          title={
            isAllActive
              ? "Edit the shared (All workspaces) memory"
              : `Edit ${active!.name} memory`
          }
          aria-label="Open workspace memory"
          onClick={onOpenWorkspaceMemory}
        >
          Memory
        </button>
        <button
          type="button"
          className="workspace-ctl-btn wsctl-context"
          title={
            isAllActive
              ? "Inspect the launch-time context for the All bucket (read-only)"
              : `Inspect ${active!.name}'s launch-time context (read-only)`
          }
          aria-label="Open context inspector"
          onClick={onOpenContextInspector}
        >
          Context
        </button>
        {!isAllActive && (
          <>
            <button
              type="button"
              className={`workspace-ctl-btn wsctl-rename${editing ? " is-active" : ""}`}
              title="Rename workspace"
              aria-label={`Rename workspace ${active!.name}`}
              // Enters inline-rename mode; Esc or clicking away (onBlur=commitRename)
              // exits. Open-only by design, NOT a close toggle: the input blurs before
              // this click fires, so `editing` is already false here — clicking Rename
              // while editing just re-opens the (already-committed) name. The !editing
              // guard is defensive.
              onClick={() => {
                if (!editing) {
                  setEditValue(active!.name)
                  setEditing(true)
                }
              }}
            >
              Rename
            </button>
            <button
              type="button"
              className="workspace-ctl-btn wsctl-delete danger"
              title="Delete workspace"
              aria-label={`Delete workspace ${active!.name}`}
              onClick={() => {
                if (
                  window.confirm(
                    `Delete the workspace "${active!.name}"? Its sessions and missions are kept (they fall back to All).`,
                  )
                ) {
                  onDeleteWorkspace(active!.id)
                }
              }}
            >
              Delete
            </button>
          </>
        )}
      </div>

      {/* WS-H — the active-workspace folder controls, ALWAYS VISIBLE (no hover-reveal).
          Only shown for a SPECIFIC active workspace (nothing to set under "All"). */}
      {!isAllActive && (
        <div className="workspace-active-controls">
          {/* The inline rename input — appears while renaming (triggered by ✏ above).
              Enter commits, Esc cancels, blur commits. */}
          {editing && (
            <input
              ref={editInputRef}
              className="workspace-rename-input"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  commitRename()
                } else if (e.key === "Escape") {
                  e.preventDefault()
                  setEditing(false)
                }
              }}
              onBlur={commitRename}
              aria-label="Workspace name"
            />
          )}

          {/* The folder row: basename of `dir` or "No folder selected" — clicking
              opens the native single-folder picker (the only place to set it). */}
          <button
            type="button"
            className={`workspace-dir-row${active!.dir ? "" : " empty"}`}
            title={active!.dir ?? "Choose a folder for this workspace"}
            aria-label={
              active!.dir
                ? `Workspace folder: ${dirBasename(active!.dir)} — click to change`
                : "No folder selected — click to choose a folder"
            }
            onClick={() => void pickFolder()}
          >
            <span className="workspace-dir-icon" aria-hidden="true">
              📁
            </span>
            <span className="workspace-dir-name">
              {active!.dir ? dirBasename(active!.dir) : "No folder selected"}
            </span>
          </button>

          {/* CAPP-75 — restore a past conversation for this folder. ALWAYS VISIBLE
              (no hover-reveal) and tied to the active workspace's folder: only shown
              when a folder is set (nothing to list otherwise). */}
          {active!.dir && (
            <button
              type="button"
              className="workspace-restore-btn"
              title="Reopen a past conversation for this folder (including ones started in a terminal)"
              aria-label="Restore a conversation for this workspace's folder"
              onClick={onRestoreConversation}
            >
              <span className="workspace-restore-icon" aria-hidden="true">
                ↻
              </span>
              <span>Restore a conversation</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
