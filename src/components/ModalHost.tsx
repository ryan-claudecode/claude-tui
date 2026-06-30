import { useMemo, useRef } from "react"
import { useFocusTrap } from "../hooks/useFocusTrap"
import PanelContent, { tabLabel, type PanelLike } from "./panels/PanelContent"
import { useActivePanel } from "../lib/modalActivePanel"
import type { PanelApi } from "../lib/panelApi"

/**
 * CAPP-109 / S2 — the ModalHost: in-main-window modal panels (modal-by-default).
 *
 * One generic overlay (cloned from KillSessionModal's skeleton — focus-trap,
 * role="dialog" aria-modal, backdrop onMouseDown dismiss + panel stopPropagation,
 * Escape) that renders the SHARED `PanelContent` with a `PanelApi` built over
 * `window.api`. NO React portal (the codebase has none — stay consistent).
 *
 * THE HIGHEST-RISK CONTRACT — form-safety: EVERY close path (backdrop / Escape / × /
 * tab-close) routes through `onClose(id)` → `window.api.hidePanel(id)` →
 * `PanelService.hide`, which resolves a pending `show_form` as `{ cancelled:true }`.
 * The modal NEVER unmounts a form without going through `hidePanel` (that would hang
 * the MCP call forever). Form-exclusive active selection (`useActivePanel`) means a
 * later `show_panel` can't silently unmount a pending form — it gets a TAB and the
 * form stays active until resolved. The submit path is `FormPanel` →
 * `window.api.submitForm` (its main-window branch) — already present.
 */

export interface ModalPanel extends PanelLike {
  visible: boolean
}

export interface ModalHostProps {
  panels: ModalPanel[]
  /** The renderer-side tab selection (a panel id), or null for the form-exclusive
   *  default. Closing the active panel falls back to the default automatically. */
  activeId: string | null
  /** Set the renderer-side tab selection. */
  onActivate: (id: string) => void
  /**
   * Close a panel. MUST end at `window.api.hidePanel(id)` for EVERY path so a pending
   * form resolves `{ cancelled:true }`. `reason` is informational only.
   */
  onClose: (id: string, reason: "backdrop" | "escape" | "button" | "tab-close") => void
  /** Pop the panel out to the companion window (S3 wires this; the button is a
   *  disabled placeholder until then). */
  onPopOut?: (id: string) => void
}

/** Build the main-window `PanelApi` over `window.api`. `sendToSession` wraps the
 *  fire-and-forget `companion:send-to-session` accessor to return `true` (the PanelApi
 *  contract); `missionStop`/`missionPause` wrap the invoke-based `stopMission`/
 *  `pauseMission`. Every other member is a raw `window.api` accessor (parity-gated). */
export function buildMainPanelApi(): PanelApi {
  const a = window.api as any
  return {
    sendToSession: (text: string) => {
      a.sendToSession(text)
      return true
    },
    missionStop: (id: string) => {
      void a.stopMission(id)
    },
    missionPause: (id: string) => {
      void a.pauseMission(id)
    },
    approveWorktreeTask: (m, t) => a.approveWorktreeTask(m, t),
    rejectWorktreeTask: (m, t, reason) => a.rejectWorktreeTask(m, t, reason),
    recall: (query, scope, sessionId) => a.recall(query, scope, sessionId),
    openSessionOverview: (sessionId) => a.openSessionOverview(sessionId),
    promoteSessionToWorkspace: (sessionId) => a.promoteSessionToWorkspace(sessionId),
    getWorkspaceMemory: (workspaceId) => a.getWorkspaceMemory(workspaceId),
    setWorkspaceInstructions: (workspaceId, text) => a.setWorkspaceInstructions(workspaceId, text),
    addWorkspaceFinding: (workspaceId, text, source) => a.addWorkspaceFinding(workspaceId, text, source),
    editWorkspaceFinding: (workspaceId, findingId, text) => a.editWorkspaceFinding(workspaceId, findingId, text),
    deleteWorkspaceFinding: (workspaceId, findingId) => a.deleteWorkspaceFinding(workspaceId, findingId),
    setWorkspaceFindingPinned: (workspaceId, findingId, pinned) =>
      a.setWorkspaceFindingPinned(workspaceId, findingId, pinned),
    onWorkspaceMemoryChanged: (cb) => a.onWorkspaceMemoryChanged(cb),
    getExportState: (workspaceId) => a.getExportState(workspaceId),
    enableExport: (workspaceId, mode, customPath) => a.enableExport(workspaceId, mode, customPath),
    disableExport: (workspaceId) => a.disableExport(workspaceId),
    setUntaggedExportEnabled: (enabled) => a.setUntaggedExportEnabled(enabled),
    regenerateExport: (workspaceId) => a.regenerateExport(workspaceId),
    getAdoptionState: (workspaceId) => a.getAdoptionState(workspaceId),
    wireImportBlock: (workspaceId) => a.wireImportBlock(workspaceId),
    unwireImportBlock: (workspaceId) => a.unwireImportBlock(workspaceId),
    setExportSelfWired: (workspaceId, selfWired) => a.setExportSelfWired(workspaceId, selfWired),
    inspectWorkspaceContext: (workspaceId) => a.inspectWorkspaceContext(workspaceId),
  }
}

export default function ModalHost({
  panels,
  activeId,
  onActivate,
  onClose,
  onPopOut,
}: ModalHostProps) {
  const visible = panels.filter((p) => p.visible)
  // Form-exclusive active-panel selection (plan §A.6): a pending form WINS the slot.
  const active = useActivePanel(visible, activeId)
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, !!active)
  // Built ONCE — the raw window.api accessors are stable for the app's lifetime.
  const api = useMemo(buildMainPanelApi, [])

  if (!active) return null

  return (
    <div
      className="modal-host-overlay"
      onMouseDown={() => onClose(active.id, "backdrop")}
    >
      <div
        ref={panelRef}
        className="modal-host-panel"
        role="dialog"
        aria-modal="true"
        aria-label={tabLabel(active)}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault()
            onClose(active.id, "escape")
          }
        }}
      >
        {visible.length > 1 && (
          <div className="modal-host-tabs">
            {visible.map((p) => {
              // A pending form is exclusive (pickActivePanel ignores the tab selection
              // while a form is visible). Reflect that in the UI: non-form tabs are
              // visibly LOCKED rather than silently no-opping on click (CAPP-109 review).
              const locked = active.type === "form" && p.type !== "form"
              return (
                <span
                  key={p.id}
                  className={`modal-host-tab ${p.id === active.id ? "active" : ""} ${
                    locked ? "locked" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="modal-host-tab-label"
                    onClick={() => onActivate(p.id)}
                    disabled={locked}
                    title={locked ? "Resolve the form before switching panels" : undefined}
                  >
                    {tabLabel(p)}
                  </button>
                  <button
                    type="button"
                    className="modal-host-tab-close"
                    aria-label={`Close ${tabLabel(p)}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onClose(p.id, "tab-close")
                    }}
                  >
                    &times;
                  </button>
                </span>
              )
            })}
          </div>
        )}
        <div className="modal-host-bar">
          <span className="modal-host-title">{tabLabel(active)}</span>
          <button
            type="button"
            className="modal-host-popout"
            // S3 wires pop-out. Until then it's a statically-visible, DISABLED placeholder
            // (no hover-reveal) so the affordance is present but inert.
            onClick={onPopOut ? () => onPopOut(active.id) : undefined}
            disabled={!onPopOut}
            title={onPopOut ? "Pop out to a separate window" : "Pop out (coming soon)"}
            aria-label="Pop out to a separate window"
          >
            ⤢ Pop out
          </button>
          <button
            type="button"
            className="modal-host-close"
            onClick={() => onClose(active.id, "button")}
            aria-label="Close panel"
          >
            &times;
          </button>
        </div>
        <div className="modal-host-body">
          <PanelContent panel={active} api={api} />
        </div>
      </div>
    </div>
  )
}
