import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import {
  deriveFindingRows,
  type WorkspaceMemoryRecord,
  type WorkspaceFinding,
} from "../../lib/workspaceMemoryView"

/**
 * CAPP-94 / U6 — the workspace-memory EDITOR: a companion-window panel to view and
 * edit one workspace's durable memory (standing instructions + promoted/authored
 * findings). Modeled on SessionOverviewPanel's sectioned read layout but EDITABLE,
 * and on WorktreeReviewPanel's pattern (it calls `companionApi` accessors, reflects
 * results inline, and live-refreshes on its own props).
 *
 * THE PINNED-TARGET WRITE PATH (the load-bearing correctness rule): the panel
 * captures the concrete `workspaceId` (a real id, or `null` for the untagged "All"
 * bucket) at OPEN time from its props (`pinnedId`, a ref) and passes it EXPLICITLY
 * on every mutation IPC. It NEVER re-derives the target from the active workspace at
 * save time — so if the user switches the active workspace while the editor is open,
 * edits still land on the pinned workspace.
 *
 * NO hover-reveal: every control (Save, per-row Edit/Delete, Add) is statically
 * visible (HARD project rule).
 */

// This panel runs in the COMPANION window and calls `window.companionApi` (NOT
// `window.api`). The authoritative `companionApi` type — including the workspace-
// memory accessors + the onWorkspaceMemoryChanged listener — is declared in
// CompanionApp.tsx (the companion renderer's global). Both files are part of the
// same companion build, so that declaration applies here.

interface Props {
  /** The PINNED target workspace: a real id, or `null`/undefined for the untagged
   *  ("All") bucket. Captured at open time; every mutation targets THIS, not the
   *  global active selection. */
  workspaceId?: string | null
  /** Optional friendly name for the header (the workspace's display name). */
  workspaceName?: string
  /** The initial record (shown until the first live re-fetch). The rest of the
   *  record fields (`instructions`, `findings`) ride in via the panel props spread. */
  instructions?: string
  findings?: WorkspaceFinding[]
}

export default function WorkspaceMemoryPanel(props: Props) {
  // Capture the pinned target ONCE. The ref guarantees every mutation uses the
  // open-time workspace even if a future prop re-push (live-refresh) re-renders us.
  const pinnedRef = useRef<string | null>(props.workspaceId ?? null)
  const pinnedId = pinnedRef.current
  const isUntagged = pinnedId == null

  // The live record. Seeded from props, then replaced by live re-fetches.
  const [record, setRecord] = useState<WorkspaceMemoryRecord | null>(() =>
    props.instructions !== undefined || props.findings !== undefined
      ? {
          workspaceId: pinnedId ?? "__untagged__",
          instructions: props.instructions ?? "",
          findings: props.findings ?? [],
          createdAt: 0,
          updatedAt: 0,
        }
      : null,
  )

  // Instructions editor (explicit save, NOT auto-save). `instrText` is the working
  // draft; `savedInstr` tracks the last-persisted value so we can show a dirty state.
  const [instrText, setInstrText] = useState(props.instructions ?? "")
  const [savedInstr, setSavedInstr] = useState(props.instructions ?? "")
  const [savingInstr, setSavingInstr] = useState(false)

  // Per-row inline edit + the add-finding draft.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState("")
  const [addText, setAddText] = useState("")

  // Pull the freshest record from the backend for the pinned workspace. Used on
  // mount AND on every matching live `onWorkspaceMemoryChanged`. We only re-seed the
  // instructions DRAFT from the backend when the user isn't mid-edit AND hasn't an
  // unsaved local edit (so a remote change never clobbers a draft they're typing).
  const refresh = useCallback(async () => {
    try {
      const rec = await window.companionApi.getWorkspaceMemory(pinnedId)
      setRecord(rec)
      setSavedInstr(rec.instructions)
      setInstrText((cur) => (cur === savedInstrRef.current ? rec.instructions : cur))
    } catch {
      /* leave the last-known record on a transient IPC failure */
    }
  }, [pinnedId])

  // A ref mirror of savedInstr so `refresh` can compare without depending on it (and
  // re-subscribing the live listener on every save).
  const savedInstrRef = useRef(savedInstr)
  useEffect(() => {
    savedInstrRef.current = savedInstr
  }, [savedInstr])

  // Mount: fetch the authoritative record, then live-refresh on matching changes.
  // The pinned untagged bucket carries the sentinel stem in its record.workspaceId,
  // and the push payload for the untagged bucket is that same stem — so an untagged
  // panel matches when the changed id equals the record's workspaceId, and a tagged
  // panel matches when it equals pinnedId.
  useEffect(() => {
    void refresh()
    const off = window.companionApi.onWorkspaceMemoryChanged((changedId) => {
      // Match the pinned target. Untagged matches the null-equivalent push (null OR the
      // sentinel stem) DIRECTLY — not via record state — so there is no mount-race window
      // where the first push could arrive before the record is populated.
      const matches = isUntagged
        ? changedId == null || changedId === "__untagged__"
        : changedId === pinnedId
      if (matches) void refresh()
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedId, isUntagged])

  const rows = useMemo(() => deriveFindingRows(record?.findings ?? []), [record])

  const instrDirty = instrText !== savedInstr

  const handleSaveInstructions = useCallback(async () => {
    if (savingInstr) return
    setSavingInstr(true)
    try {
      const rec = await window.companionApi.setWorkspaceInstructions(pinnedId, instrText)
      setRecord(rec)
      setSavedInstr(rec.instructions)
      setInstrText(rec.instructions)
    } catch {
      /* the push-driven refresh will reconcile; leave the draft intact on failure */
    } finally {
      setSavingInstr(false)
    }
  }, [pinnedId, instrText, savingInstr])

  const beginEdit = useCallback((f: WorkspaceFinding) => {
    setEditingId(f.id)
    setEditText(f.text)
  }, [])

  const commitEdit = useCallback(async () => {
    const id = editingId
    if (!id) return
    const text = editText.trim()
    setEditingId(null)
    if (!text) return // a blank edit is a no-op (use Delete to remove)
    try {
      await window.companionApi.editWorkspaceFinding(pinnedId, id, text)
      // The onWorkspaceMemoryChanged push re-fetches; do an optimistic local update too
      // so the row reflects instantly even if the push lags.
      setRecord((prev) =>
        prev
          ? { ...prev, findings: prev.findings.map((f) => (f.id === id ? { ...f, text } : f)) }
          : prev,
      )
    } catch {
      /* push-refresh reconciles */
    }
  }, [editingId, editText, pinnedId])

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await window.companionApi.deleteWorkspaceFinding(pinnedId, id)
        setRecord((prev) =>
          prev ? { ...prev, findings: prev.findings.filter((f) => f.id !== id) } : prev,
        )
      } catch {
        /* push-refresh reconciles */
      }
    },
    [pinnedId],
  )

  const handleAdd = useCallback(async () => {
    const text = addText.trim()
    if (!text) return
    setAddText("")
    try {
      const f = await window.companionApi.addWorkspaceFinding(pinnedId, text, "user")
      setRecord((prev) => (prev ? { ...prev, findings: [...prev.findings, f] } : prev))
    } catch {
      /* push-refresh reconciles */
    }
  }, [addText, pinnedId])

  const title = props.workspaceName?.trim()
    ? `Memory — ${props.workspaceName}`
    : isUntagged
      ? "Memory — All workspaces"
      : "Workspace memory"

  const isEmpty = (record?.findings.length ?? 0) === 0 && !record?.instructions.trim() && !instrText.trim()

  return (
    <div className="workspace-memory-panel">
      <h2 className="wmem-title">{title}</h2>
      {isUntagged && (
        <p className="wmem-scope-note">
          The “All workspaces” bucket is a global, cross-project memory shared by every workspace.
        </p>
      )}

      {isEmpty && record && (
        <div className="wmem-empty">No workspace memory yet. Add standing instructions or a finding below.</div>
      )}

      <section className="wmem-section">
        <h3>Instructions</h3>
        <textarea
          className="wmem-instructions"
          value={instrText}
          onChange={(e) => setInstrText(e.target.value)}
          placeholder="Durable standing context for this workspace — coding conventions, gotchas, the lay of the land…"
          rows={5}
          aria-label="Workspace instructions"
        />
        <div className="wmem-instructions-actions">
          <button
            type="button"
            className="wmem-save-btn"
            onClick={() => void handleSaveInstructions()}
            disabled={savingInstr || !instrDirty}
            title={instrDirty ? "Save instructions" : "No unsaved changes"}
          >
            {savingInstr ? "Saving…" : "Save"}
          </button>
          {instrDirty && <span className="wmem-dirty-hint">Unsaved changes</span>}
        </div>
      </section>

      <section className="wmem-section">
        <h3>Findings ({record?.findings.length ?? 0})</h3>
        {rows.length === 0 ? (
          <div className="wmem-empty">No findings yet.</div>
        ) : (
          <ul className="wmem-findings">
            {rows.map(({ finding, ruledOut, correction, freshness }) => (
              <li
                key={finding.id}
                className={`wmem-finding${ruledOut ? " ruled-out" : ""}`}
              >
                {editingId === finding.id ? (
                  <div className="wmem-finding-edit">
                    <input
                      className="wmem-finding-edit-input"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault()
                          void commitEdit()
                        } else if (e.key === "Escape") {
                          e.preventDefault()
                          setEditingId(null)
                        }
                      }}
                      autoFocus
                      onFocus={(e) => e.currentTarget.select()}
                      aria-label="Edit finding text"
                    />
                    <button type="button" className="wmem-mini" onClick={() => void commitEdit()}>
                      Save
                    </button>
                    <button type="button" className="wmem-mini" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="wmem-finding-row">
                    <div className="wmem-finding-text">
                      <span className={ruledOut ? "wmem-struck" : undefined}>{finding.text}</span>
                      {ruledOut && correction && (
                        <span className="wmem-correction"> → {correction}</span>
                      )}
                      {freshness && <div className="wmem-finding-meta">{freshness}</div>}
                    </div>
                    <div className="wmem-finding-controls">
                      <button
                        type="button"
                        className="wmem-mini"
                        onClick={() => beginEdit(finding)}
                        aria-label={`Edit finding: ${finding.text}`}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="wmem-mini wmem-delete"
                        onClick={() => void handleDelete(finding.id)}
                        aria-label={`Delete finding: ${finding.text}`}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="wmem-section">
        <h3>Add a finding</h3>
        <div className="wmem-add">
          <input
            className="wmem-add-input"
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                void handleAdd()
              }
            }}
            placeholder="A durable fact worth remembering for this workspace…"
            aria-label="New finding text"
          />
          <button
            type="button"
            className="wmem-add-btn"
            onClick={() => void handleAdd()}
            disabled={!addText.trim()}
          >
            Add
          </button>
        </div>
      </section>
    </div>
  )
}
