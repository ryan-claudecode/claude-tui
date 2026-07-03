import { useState, useEffect, useRef, useMemo } from "react"
import PanelContent, { tabLabel } from "../components/panels/PanelContent"
import { type ReviewActionResult } from "../components/panels/WorktreeReviewPanel"
import { type InspectResultView } from "../components/panels/ContextInspectorPanel"
import type { PanelApi } from "../lib/panelApi"
import type {
  WorkspaceMemoryRecord,
  WorkspaceFinding,
} from "../lib/workspaceMemoryView"
import type { ExportStateView, EnableResultView, AdoptionStateView, WireResultView } from "../lib/exportView"

interface PanelState {
  id: string
  type: string
  position: "right" | "bottom"
  props: Record<string, any>
  visible: boolean
}

declare global {
  interface Window {
    companionApi: {
      onPanelShow: (cb: (panel: PanelState) => void) => void
      onPanelUpdate: (cb: (payload: { id: string; props: any }) => void) => void
      onPanelHide: (cb: (id: string) => void) => void
      onPanelHideAll: (cb: () => void) => void
      submitForm: (id: string, data: Record<string, any>) => void
      sendToSession: (text: string) => void
      missionStop: (id: string) => void
      missionPause: (id: string) => void
      // CAPP-115 (SCHED-2) — schedule detail-panel controls from a popped-out companion.
      scheduleRunNow: (id: string) => Promise<boolean>
      scheduleSetEnabled: (id: string, enabled: boolean) => Promise<any>
      scheduleDelete: (id: string) => Promise<boolean>
      requestScheduleEdit: (id: string) => Promise<void>
      hidePanel: (panelId: string) => Promise<boolean>
      approveWorktreeTask: (missionId: string, taskId: string) => Promise<ReviewActionResult | null>
      rejectWorktreeTask: (missionId: string, taskId: string, reason?: string) => Promise<ReviewActionResult | null>
      // CAPP-86 — read-only cross-session recall + click-to-open SessionOverview.
      recall: (query: string, scope?: "session" | "workspace" | "all", sessionId?: string) => Promise<any[]>
      recallSummary: (scope?: "session" | "workspace" | "all", sessionId?: string) => Promise<any>
      openSessionOverview: (sessionId: string) => Promise<any>
      // CAPP-94 / U6 — workspace-memory editor accessors. A `null` workspaceId
      // addresses the untagged "All" bucket. The WorkspaceMemoryPanel (which runs in
      // THIS companion window) calls these directly (NOT window.api). Live-refresh via
      // onWorkspaceMemoryChanged (per-instance unsubscribe).
      getWorkspaceMemory: (workspaceId: string | null) => Promise<WorkspaceMemoryRecord>
      setWorkspaceInstructions: (
        workspaceId: string | null,
        text: string,
      ) => Promise<WorkspaceMemoryRecord>
      addWorkspaceFinding: (
        workspaceId: string | null,
        text: string,
        source: "user" | "agent",
      ) => Promise<WorkspaceFinding>
      editWorkspaceFinding: (
        workspaceId: string | null,
        findingId: string,
        text: string,
      ) => Promise<boolean>
      deleteWorkspaceFinding: (
        workspaceId: string | null,
        findingId: string,
      ) => Promise<boolean>
      // CAPP-97 — pin/unpin a finding (never evicted under the auto-load context cap).
      setWorkspaceFindingPinned: (
        workspaceId: string | null,
        findingId: string,
        pinned: boolean,
      ) => Promise<boolean>
      onWorkspaceMemoryChanged: (cb: (workspaceId: string) => void) => () => void
      // CAPP-94 / U6 — promote a session's findings into its OWNING workspace memory
      // (the SessionOverviewPanel "Push context to workspace" button). The owning
      // workspace is resolved main-side; the panel only needs the session id.
      promoteSessionToWorkspace: (
        sessionId: string,
      ) => Promise<{ ok: boolean; count: number; workspaceId: string | null }>
      // CAPP-98 / I1 — the READ-ONLY Context Inspector. The ContextInspectorPanel (in THIS
      // companion window) calls this on its Refresh button to re-enumerate the launch-time
      // native context + our injected primer. A `null` workspaceId is the untagged bucket.
      inspectWorkspaceContext: (workspaceId: string | null) => Promise<InspectResultView>
      // CAPP-99 / E1 — export accessors. The export control lives in THIS companion window's
      // WorkspaceMemoryPanel. STRICTLY one-directional (store → file): read state / trigger
      // regen only — there is no file → store accessor. A `null` workspaceId is the untagged bucket.
      getExportState: (workspaceId: string | null) => Promise<ExportStateView>
      enableExport: (
        workspaceId: string | null,
        mode: "A" | "C",
        customPath?: string,
      ) => Promise<EnableResultView>
      disableExport: (workspaceId: string | null) => Promise<ExportStateView>
      setUntaggedExportEnabled: (enabled: boolean) => Promise<ExportStateView>
      regenerateExport: (
        workspaceId: string | null,
      ) => Promise<{ ok: boolean; wrote?: boolean; error?: string }>
      // CAPP-100 / E2 — adoption: the reversible CLAUDE.local.md insert/Unwire (NON-MCP) + probe.
      getAdoptionState: (workspaceId: string | null) => Promise<AdoptionStateView>
      wireImportBlock: (workspaceId: string | null) => Promise<WireResultView>
      unwireImportBlock: (workspaceId: string | null) => Promise<WireResultView>
      setExportSelfWired: (
        workspaceId: string | null,
        selfWired: boolean,
      ) => Promise<ExportStateView>
      getTheme: () => Promise<string>
      onThemeChanged: (cb: (mode: string) => void) => void
      removeAllListeners: (channel: string) => void
      closeWindow: () => void
      windowMinimize: () => void
      windowMaximize: () => void
      windowClose: () => void
    }
  }
}

export default function CompanionApp() {
  const [panels, setPanels] = useState<PanelState[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  // Track most-recently-shown panel
  const lastAddedRef = useRef<string | null>(null)

  useEffect(() => {
    // Load theme
    window.companionApi.getTheme().then((mode) => {
      document.documentElement.setAttribute("data-theme", mode)
    })
    window.companionApi.onThemeChanged((mode) => {
      document.documentElement.setAttribute("data-theme", mode)
    })

    window.companionApi.onPanelShow((panel) => {
      setPanels((prev) => [...prev.filter((p) => p.id !== panel.id), panel])
      lastAddedRef.current = panel.id
      setActiveId(panel.id)
    })

    window.companionApi.onPanelUpdate(({ id, props }) => {
      setPanels((prev) =>
        prev.map((p) => (p.id === id ? { ...p, props } : p))
      )
    })

    window.companionApi.onPanelHide((id) => {
      setPanels((prev) => {
        const next = prev.filter((p) => p.id !== id)
        if (next.length === 0) window.companionApi.closeWindow()
        return next
      })
      setActiveId((prev) => (prev === id ? null : prev))
    })

    window.companionApi.onPanelHideAll(() => {
      setPanels([])
      window.companionApi.closeWindow()
    })

    // CAPP-94 / U6 — workspace-memory editor live-refresh is owned ENTIRELY by the
    // WorkspaceMemoryPanel itself: it subscribes to `workspace:memory-changed`, matches
    // its own pinned workspaceId, and re-fetches its authoritative record. CompanionApp
    // deliberately does NOT also push fresh props here — that was a redundant second
    // refresh path the panel ignored after mount (it seeds `record` from props once),
    // and doing the async fetch inside a setPanels updater is a React anti-pattern.
    // Single source of truth = the panel. (The backend push reaches this window via
    // companionService.sendToCompanion in ipc.ts's onMemoryChanged.)

    return () => {
      window.companionApi.removeAllListeners("theme:changed")
    }
  }, [])

  const panel = panels.find((p) => p.id === activeId) ?? panels[panels.length - 1]

  // CAPP-106 / S1 — build a PanelApi over `window.companionApi` ONCE. The shared
  // PanelContent switch derives every per-panel callback from this single object (it
  // folds the previously-inline six companion callbacks + the #19-23 panel accessors).
  // `sendToSession` returns true to match the PanelApi contract — companionApi's is
  // fire-and-forget (no active-session signal back over the wire).
  const api = useMemo<PanelApi>(() => {
    const c = window.companionApi
    return {
      sendToSession: (text) => { c.sendToSession(text); return true },
      missionStop: (id) => c.missionStop(id),
      missionPause: (id) => c.missionPause(id),
      // CAPP-115 — schedule detail-panel controls from a popped-out companion. Edit
      // routes through requestScheduleEdit → the MAIN window's ScheduleForm overlay.
      scheduleRunNow: (id) => { void c.scheduleRunNow(id) },
      scheduleSetEnabled: (id, enabled) => { void c.scheduleSetEnabled(id, enabled) },
      scheduleDelete: (id) => { void c.scheduleDelete(id) },
      scheduleEdit: (id) => { void c.requestScheduleEdit(id) },
      // PanelService.hide routes panel:hide back to THIS window too (onPanelHide
      // drops it locally and closes the window when empty) — no local-only close.
      hidePanel: (panelId) => { void c.hidePanel(panelId) },
      approveWorktreeTask: (m, t) => c.approveWorktreeTask(m, t),
      rejectWorktreeTask: (m, t, reason) => c.rejectWorktreeTask(m, t, reason),
      recall: (query, scope, sessionId) => c.recall(query, scope, sessionId),
      openSessionOverview: (sessionId) => c.openSessionOverview(sessionId),
      promoteSessionToWorkspace: (sessionId) => c.promoteSessionToWorkspace(sessionId),
      getWorkspaceMemory: (workspaceId) => c.getWorkspaceMemory(workspaceId),
      setWorkspaceInstructions: (workspaceId, text) => c.setWorkspaceInstructions(workspaceId, text),
      addWorkspaceFinding: (workspaceId, text, source) => c.addWorkspaceFinding(workspaceId, text, source),
      editWorkspaceFinding: (workspaceId, findingId, text) => c.editWorkspaceFinding(workspaceId, findingId, text),
      deleteWorkspaceFinding: (workspaceId, findingId) => c.deleteWorkspaceFinding(workspaceId, findingId),
      setWorkspaceFindingPinned: (workspaceId, findingId, pinned) => c.setWorkspaceFindingPinned(workspaceId, findingId, pinned),
      onWorkspaceMemoryChanged: (cb) => c.onWorkspaceMemoryChanged(cb),
      getExportState: (workspaceId) => c.getExportState(workspaceId),
      enableExport: (workspaceId, mode, customPath) => c.enableExport(workspaceId, mode, customPath),
      disableExport: (workspaceId) => c.disableExport(workspaceId),
      setUntaggedExportEnabled: (enabled) => c.setUntaggedExportEnabled(enabled),
      regenerateExport: (workspaceId) => c.regenerateExport(workspaceId),
      getAdoptionState: (workspaceId) => c.getAdoptionState(workspaceId),
      wireImportBlock: (workspaceId) => c.wireImportBlock(workspaceId),
      unwireImportBlock: (workspaceId) => c.unwireImportBlock(workspaceId),
      setExportSelfWired: (workspaceId, selfWired) => c.setExportSelfWired(workspaceId, selfWired),
      inspectWorkspaceContext: (workspaceId) => c.inspectWorkspaceContext(workspaceId),
    }
  }, [])

  if (panels.length === 0) {
    return (
      <div className="companion-empty">
        <p>No panels open</p>
      </div>
    )
  }

  const handleClose = (id: string) => {
    setPanels((prev) => {
      const next = prev.filter((p) => p.id !== id)
      if (next.length === 0) window.companionApi.closeWindow()
      return next
    })
    setActiveId((prev) => (prev === id ? null : prev))
  }

  return (
    <div className="companion-app">
      <div className="companion-header">
        <div className="companion-tabs">
          {panels.map((p) => (
            <button
              key={p.id}
              className={`companion-tab ${p === panel ? "active" : ""}`}
              onClick={() => setActiveId(p.id)}
            >
              {tabLabel(p)}
              <span
                className="companion-tab-close"
                onClick={(e) => { e.stopPropagation(); handleClose(p.id) }}
              >
                &times;
              </span>
            </button>
          ))}
        </div>
        <div className="window-controls">
          <button className="window-control minimize" onClick={() => window.companionApi.windowMinimize()} aria-label="Minimize">
            <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor" /></svg>
          </button>
          <button className="window-control maximize" onClick={() => window.companionApi.windowMaximize()} aria-label="Maximize">
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
          </button>
          <button className="window-control close" onClick={() => window.companionApi.windowClose()} aria-label="Close">
            <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2" /><line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2" /></svg>
          </button>
        </div>
      </div>
      <div className="companion-body">
        {/* CAPP-115 review — keyed by panel id so switching tabs REMOUNTS the panel
            (component-local state must never leak across panels sharing a type; see
            the matching key in ModalHost). */}
        {panel && <PanelContent key={panel.id} panel={panel} api={api} />}
      </div>
    </div>
  )
}
