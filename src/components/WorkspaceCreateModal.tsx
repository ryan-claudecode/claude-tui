import { useState, useEffect, useRef, useCallback } from "react"
import { useFocusTrap } from "../hooks/useFocusTrap"
import { validateWorkspaceName, dirBasename } from "../lib/workspaceForm"
import { toast } from "../lib/toast"

interface Props {
  open: boolean
  onClose: () => void
  /** Create the workspace; resolves to the new workspace (or null on failure) so
   *  the caller can set it active. WS-H: a single optional folder. */
  onCreate: (name: string, dir?: string) => Promise<{ id: string } | null>
  /** Existing workspace names — used ONLY for a soft, non-blocking duplicate-name
   *  hint. Workspaces are id-addressed, so dups are allowed; we just warn. */
  existingNames?: string[]
}

/**
 * WS-D/H — the create-workspace modal in the MAIN window (not the companion).
 * A focus-trapped overlay: a name input, a single
 * "Choose folder" picker that opens the NATIVE folder dialog (single-select), the
 * chosen folder shown as its parent-folder NAME (clearable), and Create/Cancel.
 * Esc / click-outside cancel; Create is disabled until the name is non-empty. The
 * folder is OPTIONAL — a workspace can start folderless and bind one later.
 *
 * NO HOVER-REVEAL: the "Choose folder" / "Change folder" + the clear (×) controls
 * are always visible while relevant; nothing appears on mouse-hover.
 */
export default function WorkspaceCreateModal({ open, onClose, onCreate, existingNames = [] }: Props) {
  const [name, setName] = useState("")
  const [dir, setDir] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)

  useEffect(() => {
    if (open) {
      setName("")
      setDir(null)
      setBusy(false)
      requestAnimationFrame(() => nameRef.current?.focus())
    }
  }, [open])

  // WS-H — single-select native folder picker; take the first chosen path.
  const chooseFolder = useCallback(async () => {
    try {
      const chosen = await window.api.openDirectoryDialog()
      if (chosen.length) setDir(chosen[0])
    } catch (err) {
      toast("error", `Couldn't open the folder picker: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  const submit = useCallback(async () => {
    const v = validateWorkspaceName(name)
    if (!v.ok) {
      nameRef.current?.focus()
      return
    }
    setBusy(true)
    const ws = await onCreate(v.name, dir ?? undefined)
    setBusy(false)
    // onCreate surfaces its own failure toast; only close on success.
    if (ws) onClose()
  }, [name, dir, onCreate, onClose])

  if (!open) return null

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault()
      onClose()
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void submit()
    }
  }

  const nameValid = validateWorkspaceName(name).ok
  // Soft, NON-blocking duplicate-name hint: workspaces are id-addressed so dups
  // are allowed — we just warn (case-insensitive, trimmed) so the user isn't
  // surprised by two identically-named rows. Create stays enabled.
  const trimmedName = name.trim().toLowerCase()
  const isDuplicateName =
    trimmedName.length > 0 && existingNames.some((n) => n.trim().toLowerCase() === trimmedName)

  return (
    <div className="workspace-create-overlay" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className="workspace-create-panel"
        role="dialog"
        aria-modal="true"
        aria-label="New workspace"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={handleKey}
      >
        <div className="workspace-create-header">
          <span className="workspace-create-title">New workspace</span>
          <button className="workspace-create-close" onClick={onClose} aria-label="Close new workspace dialog">
            ×
          </button>
        </div>

        <label className="workspace-create-label" htmlFor="workspace-name-input">
          Name
        </label>
        <input
          id="workspace-name-input"
          ref={nameRef}
          className="workspace-create-input"
          placeholder="e.g. Billing service"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {isDuplicateName && (
          <span className="workspace-create-hint" role="note">
            A workspace named “{name.trim()}” already exists — that's fine, names don't have to be unique.
          </span>
        )}

        <label className="workspace-create-label">Folder</label>
        {dir ? (
          // The chosen folder, shown as its parent-folder NAME with a clear (×).
          // Always-visible controls — no hover reveal.
          <div className="workspace-create-folder">
            <span className="workspace-create-folder-name" title={dir}>
              {dirBasename(dir)}
            </span>
            <button
              type="button"
              className="workspace-create-folder-change"
              onClick={chooseFolder}
            >
              Change
            </button>
            <button
              type="button"
              className="workspace-create-folder-clear"
              aria-label="Clear chosen folder"
              onClick={() => setDir(null)}
            >
              ×
            </button>
          </div>
        ) : (
          <button className="workspace-add-folder-btn" onClick={chooseFolder} type="button">
            Choose folder
          </button>
        )}

        <div className="workspace-create-actions">
          <button className="workspace-create-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="workspace-create-submit" onClick={submit} disabled={!nameValid || busy}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  )
}
