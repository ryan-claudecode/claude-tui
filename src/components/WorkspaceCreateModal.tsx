import { useState, useEffect, useRef, useCallback } from "react"
import { useFocusTrap } from "../hooks/useFocusTrap"
import { validateWorkspaceName, addFormDirs, removeFormDir } from "../lib/workspaceForm"
import { toast } from "../lib/toast"

interface Props {
  open: boolean
  onClose: () => void
  /** Create the workspace; resolves to the new workspace id (or null on failure)
   *  so the caller can set it active. */
  onCreate: (name: string, dirs: string[]) => Promise<{ id: string } | null>
}

// Show just the last path segment as the chip label (the full path is the
// title) so long absolute paths don't blow out the modal width.
function dirLabel(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || dir
}

/**
 * WS-D — the create-workspace modal in the MAIN window (not the companion).
 * Mirrors MissionPrompt's overlay/focus-trap pattern: a name input, a
 * "+ Add folder" button that opens the NATIVE folder dialog (multi-select), the
 * chosen dirs as removable chips, and Create/Cancel. Esc / click-outside cancel;
 * Create is disabled until the name is non-empty. Dirs are optional — a
 * workspace can start empty and gain dirs later.
 */
export default function WorkspaceCreateModal({ open, onClose, onCreate }: Props) {
  const [name, setName] = useState("")
  const [dirs, setDirs] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)

  useEffect(() => {
    if (open) {
      setName("")
      setDirs([])
      setBusy(false)
      requestAnimationFrame(() => nameRef.current?.focus())
    }
  }, [open])

  const addFolder = useCallback(async () => {
    try {
      const chosen = await window.api.openDirectoryDialog()
      if (chosen.length) setDirs((cur) => addFormDirs(cur, chosen))
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
    const ws = await onCreate(v.name, dirs)
    setBusy(false)
    // onCreate surfaces its own failure toast; only close on success.
    if (ws) onClose()
  }, [name, dirs, onCreate, onClose])

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

        <label className="workspace-create-label">Folders</label>
        <div className="workspace-create-dirs">
          {dirs.length === 0 && (
            <span className="workspace-create-dirs-empty">No folders yet — add one (optional).</span>
          )}
          {dirs.map((dir) => (
            <span key={dir} className="workspace-dir-chip" title={dir}>
              <span className="workspace-dir-chip-label">{dirLabel(dir)}</span>
              <button
                className="workspace-dir-chip-remove"
                aria-label={`Remove folder ${dir}`}
                onClick={() => setDirs((cur) => removeFormDir(cur, dir))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <button className="workspace-add-folder-btn" onClick={addFolder} type="button">
          + Add folder
        </button>

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
