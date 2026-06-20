import { useState, useEffect, useRef, useCallback } from "react"
import { useFocusTrap } from "../hooks/useFocusTrap"
import { relativeTime } from "../lib/relativeTime"
import { toast } from "../lib/toast"

/** The public shape a folder's conversation discovery returns (mirrors the backend
 *  FolderConversation). */
export interface FolderConversationSummary {
  id: string
  updatedAt: number
  preview: string
}

interface Props {
  open: boolean
  onClose: () => void
  /** The active workspace's folder (absolute path), or null when none is set. The
   *  modal only opens for a folder; this is the cwd conversations are listed for. */
  folder: string | null
  /** Restore a conversation by id — resolves to the new { session, terminalId } (or
   *  null on failure) so the caller can point the active selection at it. */
  onRestore: (
    folder: string,
    conversationId: string,
  ) => Promise<{ session: { id: string }; terminalId: string } | null>
}

/**
 * CAPP-75 — the "Restore a conversation" picker (MAIN window). Lists every Claude
 * Code conversation discoverable for the active workspace's FOLDER — including
 * conversations started OUTSIDE the app (plain `claude` in a terminal) — newest
 * first, each row a one-line preview of the first user message + a relative time
 * ("2h ago"). Selecting a row restores it (`claude --resume <id>` in the folder as
 * a new work session) and closes.
 *
 * Mirrors WorkspaceCreateModal's overlay/focus-trap pattern. Esc / click-outside
 * cancel. NO HOVER-REVEAL: every row is a fully-visible, clickable button; nothing
 * appears on mouse-hover. Keyboard accessible (each row is a real <button>, Tab
 * walks them, Enter/Space activates).
 */
export default function RestoreConversationModal({ open, onClose, folder, onRestore }: Props) {
  const [convos, setConvos] = useState<FolderConversationSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)

  // Load the folder's conversations each time the modal opens (the on-disk store
  // can change between opens — e.g. a `claude` run in a terminal since last time).
  useEffect(() => {
    if (!open || !folder) return
    let cancelled = false
    setConvos([])
    setRestoringId(null)
    setLoading(true)
    Promise.resolve(window.api.listFolderConversations(folder))
      .then((list) => {
        if (!cancelled) setConvos((list as FolderConversationSummary[]) ?? [])
      })
      .catch((err) => {
        if (!cancelled) {
          toast("error", `Couldn't list conversations: ${err instanceof Error ? err.message : String(err)}`)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, folder])

  const restore = useCallback(
    async (id: string) => {
      if (!folder || restoringId) return
      setRestoringId(id)
      const result = await onRestore(folder, id)
      // onRestore surfaces its own failure toast; only close on success.
      if (result) onClose()
      else setRestoringId(null)
    },
    [folder, restoringId, onRestore, onClose],
  )

  if (!open) return null

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault()
      onClose()
    }
  }

  const now = Date.now()

  return (
    <div className="restore-convo-overlay" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className="restore-convo-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Restore a conversation"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={handleKey}
      >
        <div className="restore-convo-header">
          <span className="restore-convo-title">Restore a conversation</span>
          <button
            className="restore-convo-close"
            onClick={onClose}
            aria-label="Close restore-conversation dialog"
          >
            ×
          </button>
        </div>

        <div className="restore-convo-sub">
          Reopen any past conversation for this folder — including ones you started in a terminal.
        </div>

        <div className="restore-convo-list" role="list">
          {loading && <div className="restore-convo-empty">Loading conversations…</div>}
          {!loading && convos.length === 0 && (
            <div className="restore-convo-empty">No past conversations for this folder.</div>
          )}
          {!loading &&
            convos.map((c) => (
              <button
                key={c.id}
                type="button"
                role="listitem"
                className="restore-convo-item"
                disabled={restoringId != null}
                onClick={() => void restore(c.id)}
                title={c.preview || c.id}
              >
                <span className="restore-convo-preview">
                  {c.preview || <span className="restore-convo-preview-empty">(no preview)</span>}
                </span>
                <span className="restore-convo-time">
                  {restoringId === c.id ? "Restoring…" : relativeTime(c.updatedAt, now)}
                </span>
              </button>
            ))}
        </div>
      </div>
    </div>
  )
}
