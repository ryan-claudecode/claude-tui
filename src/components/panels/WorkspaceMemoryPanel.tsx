import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import {
  deriveFindingRows,
  type WorkspaceMemoryRecord,
  type WorkspaceFinding,
} from "../../lib/workspaceMemoryView"
import type { ExportStateView, AdoptionStateView } from "../../lib/exportView"
import type { PanelApi } from "../../lib/panelApi"

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

// CAPP-106 / S1 — this panel no longer reaches for `window.companionApi` directly. It
// receives a `PanelApi` (`api` prop) so it works identically in EITHER the companion
// window (api over companionApi) OR the main-window modal (api over window.api). The
// memory/export/adoption accessors + the onWorkspaceMemoryChanged listener all flow
// through `api`.

/** The slice of `PanelApi` this panel uses (memory mutators + export + adoption). */
type WorkspaceMemoryApi = Pick<
  PanelApi,
  | "getWorkspaceMemory"
  | "setWorkspaceInstructions"
  | "addWorkspaceFinding"
  | "editWorkspaceFinding"
  | "deleteWorkspaceFinding"
  | "setWorkspaceFindingPinned"
  | "onWorkspaceMemoryChanged"
  | "getExportState"
  | "enableExport"
  | "disableExport"
  | "setUntaggedExportEnabled"
  | "regenerateExport"
  | "getAdoptionState"
  | "wireImportBlock"
  | "unwireImportBlock"
  | "setExportSelfWired"
>

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
  /** CAPP-106 / S1 — the bridge (companion OR main window). The panel calls every
   *  mutator through this; absent → it degrades (no live data, mutations are no-ops). */
  api?: WorkspaceMemoryApi
}

export default function WorkspaceMemoryPanel(props: Props) {
  const api = props.api
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
    if (!api) return
    try {
      const rec = await api.getWorkspaceMemory(pinnedId)
      setRecord(rec)
      setSavedInstr(rec.instructions)
      setInstrText((cur) => (cur === savedInstrRef.current ? rec.instructions : cur))
    } catch {
      /* leave the last-known record on a transient IPC failure */
    }
  }, [pinnedId, api])

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
    if (!api) return
    const off = api.onWorkspaceMemoryChanged((changedId) => {
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
  }, [pinnedId, isUntagged, api])

  const rows = useMemo(() => deriveFindingRows(record?.findings ?? []), [record])

  const instrDirty = instrText !== savedInstr

  const handleSaveInstructions = useCallback(async () => {
    if (savingInstr || !api) return
    setSavingInstr(true)
    try {
      const rec = await api.setWorkspaceInstructions(pinnedId, instrText)
      setRecord(rec)
      setSavedInstr(rec.instructions)
      setInstrText(rec.instructions)
    } catch {
      /* the push-driven refresh will reconcile; leave the draft intact on failure */
    } finally {
      setSavingInstr(false)
    }
  }, [pinnedId, instrText, savingInstr, api])

  const beginEdit = useCallback((f: WorkspaceFinding) => {
    setEditingId(f.id)
    setEditText(f.text)
  }, [])

  const commitEdit = useCallback(async () => {
    const id = editingId
    if (!id) return
    const text = editText.trim()
    setEditingId(null)
    if (!text || !api) return // a blank edit is a no-op (use Delete to remove)
    try {
      await api.editWorkspaceFinding(pinnedId, id, text)
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
  }, [editingId, editText, pinnedId, api])

  const handleDelete = useCallback(
    async (id: string) => {
      if (!api) return
      try {
        await api.deleteWorkspaceFinding(pinnedId, id)
        setRecord((prev) =>
          prev ? { ...prev, findings: prev.findings.filter((f) => f.id !== id) } : prev,
        )
      } catch {
        /* push-refresh reconciles */
      }
    },
    [pinnedId, api],
  )

  // CAPP-97 — pin/unpin a finding. A pinned finding is the only thing never evicted
  // from the curated context that auto-loads into a fresh session (the byte cap). The
  // toggle is statically visible per row (HARD no-hover-reveal rule). Optimistic local
  // update; the onWorkspaceMemoryChanged push re-fetches to reconcile.
  const handleTogglePin = useCallback(
    async (f: WorkspaceFinding) => {
      if (!api) return
      const next = !f.pinned
      try {
        await api.setWorkspaceFindingPinned(pinnedId, f.id, next)
        setRecord((prev) =>
          prev
            ? { ...prev, findings: prev.findings.map((x) => (x.id === f.id ? { ...x, pinned: next } : x)) }
            : prev,
        )
      } catch {
        /* push-refresh reconciles */
      }
    },
    [pinnedId, api],
  )

  const handleAdd = useCallback(async () => {
    const text = addText.trim()
    if (!text || !api) return
    setAddText("")
    try {
      const f = await api.addWorkspaceFinding(pinnedId, text, "user")
      setRecord((prev) => (prev ? { ...prev, findings: [...prev.findings, f] } : prev))
    } catch {
      /* push-refresh reconciles */
    }
  }, [addText, pinnedId, api])

  // ── CAPP-99 / E1 — Export (workspace-tier portability) ──────────────────────────
  const [exportState, setExportState] = useState<ExportStateView | null>(null)
  const [exportMode, setExportMode] = useState<"A" | "C">(isUntagged ? "C" : "A")
  const [customPath, setCustomPath] = useState("")
  const [exportBusy, setExportBusy] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const refreshExport = useCallback(async () => {
    if (!api) return
    try {
      const st = await api.getExportState(pinnedId)
      setExportState(st)
      // A folderless/untagged workspace can only use Mode C — pin the selector there.
      if (st.folderless) setExportMode("C")
    } catch {
      /* leave the last-known export state on a transient IPC failure */
    }
  }, [pinnedId, api])

  useEffect(() => {
    void refreshExport()
  }, [refreshExport])

  const handleEnableExport = useCallback(async () => {
    if (exportBusy || !api) return
    setExportBusy(true)
    setExportError(null)
    try {
      const res = await api.enableExport(
        pinnedId,
        exportMode,
        exportMode === "C" ? customPath.trim() || undefined : undefined,
      )
      if (!res.ok) {
        setExportError(res.error ?? "Could not enable export.")
      } else if (res.state) {
        // Untagged registers DEFAULT-OFF (the machine-wide blast radius). Since the user
        // clicked "Enable export" PAST the warning, honor that as the deliberate gesture and
        // flip it ON immediately (the explicit second confirmation lives in the warning copy).
        if (isUntagged && !res.state.enabled) {
          const on = await api.setUntaggedExportEnabled(true)
          setExportState(on)
        } else {
          setExportState(res.state)
        }
      }
    } catch (err) {
      setExportError(String(err))
    } finally {
      setExportBusy(false)
    }
  }, [exportBusy, pinnedId, exportMode, customPath, isUntagged, api])

  const handleDisableExport = useCallback(async () => {
    if (exportBusy || !api) return
    setExportBusy(true)
    setExportError(null)
    try {
      const st = await api.disableExport(pinnedId)
      setExportState(st)
    } catch (err) {
      setExportError(String(err))
    } finally {
      setExportBusy(false)
    }
  }, [exportBusy, pinnedId, api])

  const handleToggleUntagged = useCallback(
    async (enabled: boolean) => {
      if (exportBusy || !api) return
      setExportBusy(true)
      setExportError(null)
      try {
        const st = await api.setUntaggedExportEnabled(enabled)
        setExportState(st)
      } catch (err) {
        setExportError(String(err))
      } finally {
        setExportBusy(false)
      }
    },
    [exportBusy, api],
  )

  const handleCopyImportLine = useCallback(async () => {
    const line = exportState?.importLine
    if (!line) return
    try {
      await navigator.clipboard.writeText(line)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard denied — the line is still visible to select manually */
    }
  }, [exportState])

  const exportEnabled = exportState?.enabled ?? false

  // ── CAPP-100 / E2 — adoption: the reversible CLAUDE.local.md "Wire it in for me" / "Unwire" ──
  const [adoption, setAdoption] = useState<AdoptionStateView | null>(null)
  const [wireBusy, setWireBusy] = useState(false)
  const [wireMsg, setWireMsg] = useState<string | null>(null)

  const refreshAdoption = useCallback(async () => {
    if (!api) return
    try {
      const st = await api.getAdoptionState(pinnedId)
      setAdoption(st)
    } catch {
      /* leave the last-known adoption state on a transient IPC failure */
    }
  }, [pinnedId, api])

  useEffect(() => {
    void refreshAdoption()
  }, [refreshAdoption, exportState])

  const handleWire = useCallback(async () => {
    if (wireBusy || !api) return
    setWireBusy(true)
    setWireMsg(null)
    try {
      const res = await api.wireImportBlock(pinnedId)
      if (!res.ok) setWireMsg(res.error ?? "Could not wire the import.")
      else if (res.status === "already") setWireMsg("Already wired — no change.")
      else setWireMsg("Wired into CLAUDE.local.md.")
      await refreshAdoption()
    } catch (err) {
      setWireMsg(String(err))
    } finally {
      setWireBusy(false)
    }
  }, [wireBusy, pinnedId, refreshAdoption, api])

  const handleUnwire = useCallback(async () => {
    if (wireBusy || !api) return
    setWireBusy(true)
    setWireMsg(null)
    try {
      const res = await api.unwireImportBlock(pinnedId)
      if (!res.ok) setWireMsg(res.error ?? "Could not unwire the import.")
      else if (res.status === "absent") setWireMsg("No Mission Control import block found.")
      else setWireMsg("Removed our import block from CLAUDE.local.md.")
      await refreshAdoption()
    } catch (err) {
      setWireMsg(String(err))
    } finally {
      setWireBusy(false)
    }
  }, [wireBusy, pinnedId, refreshAdoption, api])

  const handleToggleSelfWired = useCallback(
    async (selfWired: boolean) => {
      if (wireBusy || !api) return
      setWireBusy(true)
      setWireMsg(null)
      try {
        await api.setExportSelfWired(pinnedId, selfWired)
        await refreshAdoption()
      } catch (err) {
        setWireMsg(String(err))
      } finally {
        setWireBusy(false)
      }
    },
    [wireBusy, pinnedId, refreshAdoption, api],
  )

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
                className={`wmem-finding${ruledOut ? " ruled-out" : ""}${finding.pinned ? " pinned" : ""}`}
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
                      <span className={ruledOut ? "wmem-struck" : undefined}>
                        {finding.pinned && (
                          <span className="wmem-pin-marker" aria-hidden="true">
                            📌{" "}
                          </span>
                        )}
                        {finding.text}
                      </span>
                      {ruledOut && correction && (
                        <span className="wmem-correction"> → {correction}</span>
                      )}
                      {freshness && <div className="wmem-finding-meta">{freshness}</div>}
                    </div>
                    <div className="wmem-finding-controls">
                      <button
                        type="button"
                        className={`wmem-mini wmem-pin${finding.pinned ? " is-pinned" : ""}`}
                        onClick={() => void handleTogglePin(finding)}
                        aria-pressed={!!finding.pinned}
                        aria-label={
                          finding.pinned
                            ? `Unpin finding (currently pinned — never dropped from auto-loaded context): ${finding.text}`
                            : `Pin finding (keep it in auto-loaded context): ${finding.text}`
                        }
                        title={
                          finding.pinned
                            ? "Pinned — never dropped from the auto-loaded context. Click to unpin."
                            : "Pin — keep this in the auto-loaded context (never evicted)."
                        }
                      >
                        {finding.pinned ? "📌 Pinned" : "Pin"}
                      </button>
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

      {/* CAPP-99 / E1 — Export: materialize this workspace's tier into a user-owned file a
          raw `claude` can @import. Every control statically visible (no hover-reveal). */}
      <section className="wmem-section wmem-export">
        <h3>Export (portability)</h3>
        <p className="wmem-export-blurb">
          Write this workspace’s memory to a file a plain <code>claude</code> can{" "}
          <code>@import</code> — so the brain travels outside Mission Control. One-way
          (the app overwrites the file; edits there are never read back).
        </p>

        {exportState?.untaggedWarning && (
          <p className="wmem-export-warning" role="alert">
            ⚠ {exportState.untaggedWarning}
          </p>
        )}

        {exportEnabled ? (
          <div className="wmem-export-on">
            <div className="wmem-export-status">
              Export is <strong>ON</strong> ({exportState?.mode === "A" ? "in-folder, gitignored" : "custom path"}).
            </div>
            {exportState?.path && (
              <div className="wmem-export-path" title={exportState.path}>
                File: <code>{exportState.path}</code>
              </div>
            )}
            {exportState?.importLine && (
              <div className="wmem-export-import">
                <span className="wmem-export-import-label">Paste into your CLAUDE.md / CLAUDE.local.md:</span>
                <code className="wmem-export-import-line">{exportState.importLine}</code>
                <button
                  type="button"
                  className="wmem-mini"
                  onClick={() => void handleCopyImportLine()}
                  aria-label="Copy the @import line"
                >
                  {copied ? "Copied!" : "Copy line"}
                </button>
              </div>
            )}
            {/* CAPP-100 / E2 — adoption: wire/unwire the @import for me (NON-MCP, user-driven).
                Every control statically visible (no hover-reveal). */}
            <div className="wmem-adoption">
              <div className="wmem-adoption-status">
                {adoption?.adopted ? (
                  <span className="wmem-adoption-on">
                    ✓ Adopted — your CLAUDE-family files <code>@import</code> this primer, so Mission
                    Control injects only the per-session tier (loaded exactly once).
                  </span>
                ) : (
                  <span className="wmem-adoption-off">
                    Not adopted yet — Mission Control still injects the workspace tier directly.
                  </span>
                )}
              </div>
              {adoption?.canWire ? (
                <div className="wmem-adoption-actions">
                  <button
                    type="button"
                    className="wmem-mini"
                    onClick={() => void handleWire()}
                    disabled={wireBusy}
                    title="Append a delimited @import block to this folder's CLAUDE.local.md"
                  >
                    Wire it in for me
                  </button>
                  <button
                    type="button"
                    className="wmem-mini"
                    onClick={() => void handleUnwire()}
                    disabled={wireBusy}
                    title="Remove our @import block (refuses if you edited inside it)"
                  >
                    Unwire
                  </button>
                </div>
              ) : (
                <label className="wmem-adoption-selfwired">
                  <input
                    type="checkbox"
                    checked={adoption?.selfWired ?? false}
                    onChange={(e) => void handleToggleSelfWired(e.target.checked)}
                    disabled={wireBusy}
                  />
                  I’ve wired this export into a CLAUDE-family file myself (custom path)
                </label>
              )}
              {wireMsg && (
                <p className="wmem-adoption-msg" role="status">
                  {wireMsg}
                </p>
              )}
            </div>

            <button
              type="button"
              className="wmem-mini wmem-export-disable"
              onClick={() => void handleDisableExport()}
              disabled={exportBusy}
            >
              Turn export off
            </button>
            {isUntagged && (
              <button
                type="button"
                className="wmem-mini"
                onClick={() => void handleToggleUntagged(false)}
                disabled={exportBusy}
                title="Disable the untagged (global) export"
              >
                Disable
              </button>
            )}
          </div>
        ) : (
          <div className="wmem-export-off">
            <div className="wmem-export-mode">
              {!exportState?.folderless && (
                <label className="wmem-export-radio">
                  <input
                    type="radio"
                    name="export-mode"
                    checked={exportMode === "A"}
                    onChange={() => setExportMode("A")}
                  />
                  In-folder, gitignored (default) — writes <code>.claude-tui/workspace-memory.md</code>{" "}
                  and adds <code>/.claude-tui/</code> to <code>.gitignore</code> first.
                </label>
              )}
              <label className="wmem-export-radio">
                <input
                  type="radio"
                  name="export-mode"
                  checked={exportMode === "C"}
                  onChange={() => setExportMode("C")}
                />
                Custom path — pick any file (defaults outside any repo).
              </label>
            </div>

            {exportState?.modeANote && (
              <p className="wmem-export-note">{exportState.modeANote}</p>
            )}

            {exportMode === "C" && (
              <input
                className="wmem-export-custom"
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                placeholder="Optional: a custom file or folder (leave blank for the default)…"
                aria-label="Custom export path"
              />
            )}

            <button
              type="button"
              className="wmem-export-enable"
              onClick={() => void handleEnableExport()}
              disabled={exportBusy}
            >
              {exportBusy ? "Working…" : "Enable export"}
            </button>
          </div>
        )}

        {exportError && (
          <p className="wmem-export-error" role="alert">
            {exportError}
          </p>
        )}
      </section>
    </div>
  )
}
