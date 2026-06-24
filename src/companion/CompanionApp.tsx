import { useState, useEffect, useRef } from "react"
import DiffPanel from "../components/panels/DiffPanel"
import FormPanel from "../components/panels/FormPanel"
import ImagePanel from "../components/panels/ImagePanel"
import MarkdownPanel from "../components/panels/MarkdownPanel"
import TablePanel from "../components/panels/TablePanel"
import TestPanel from "../components/panels/TestPanel"
import ChartPanel from "../components/panels/ChartPanel"
import TreePanel from "../components/panels/TreePanel"
import TimelinePanel from "../components/panels/TimelinePanel"
import GitPanel from "../components/panels/GitPanel"
import KanbanPanel from "../components/panels/KanbanPanel"
import NotesPanel from "../components/panels/NotesPanel"
import StatPanel from "../components/panels/StatPanel"
import LogPanel from "../components/panels/LogPanel"
import ProgressPanel from "../components/panels/ProgressPanel"
import CodePanel from "../components/panels/CodePanel"
import HeatmapPanel from "../components/panels/HeatmapPanel"
import MissionPanel from "../components/panels/MissionPanel"
import SessionOverviewPanel from "../components/panels/SessionOverviewPanel"
import RecallPanel from "../components/panels/RecallPanel"
import WorktreeReviewPanel, { type ReviewActionResult } from "../components/panels/WorktreeReviewPanel"
import WorkspaceMemoryPanel from "../components/panels/WorkspaceMemoryPanel"
import ContextInspectorPanel, {
  type InspectResultView,
} from "../components/panels/ContextInspectorPanel"
import type {
  WorkspaceMemoryRecord,
  WorkspaceFinding,
} from "../lib/workspaceMemoryView"
import type { ExportStateView, EnableResultView } from "../lib/exportView"

interface PanelState {
  id: string
  type: string
  position: "right" | "bottom"
  props: Record<string, any>
  visible: boolean
}

const PANEL_LABELS: Record<string, string> = {
  diff: "Diff", form: "Form", image: "Image", markdown: "Markdown",
  table: "Table", test: "Tests", chart: "Chart", tree: "Tree",
  timeline: "Timeline", git: "Git", kanban: "Kanban", notes: "Notes",
  stat: "Stats", log: "Log", progress: "Progress", code: "Code",
  heatmap: "Heatmap", mission: "Mission", "session-overview": "Overview",
  "worktree-review": "Review", recall: "Recall", "workspace-memory": "Memory",
  "context-inspector": "Context",
}

function tabLabel(p: PanelState): string {
  const base = PANEL_LABELS[p.type] ?? p.type
  if (p.type === "session-overview" && typeof p.props?.name === "string" && p.props.name) {
    return p.props.name
  }
  if (p.type === "worktree-review" && typeof p.props?.title === "string" && p.props.title) {
    return `Review: ${p.props.title}`
  }
  if (p.type === "workspace-memory" && typeof p.props?.workspaceName === "string" && p.props.workspaceName) {
    return `Memory: ${p.props.workspaceName}`
  }
  if (p.type === "context-inspector" && typeof p.props?.workspaceName === "string" && p.props.workspaceName) {
    return `Context: ${p.props.workspaceName}`
  }
  return base
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
        {panel && <PanelContent
          panel={panel}
          onSendToSession={(text) => { window.companionApi.sendToSession(text); return true }}
          onMissionStop={(id) => window.companionApi.missionStop(id)}
          onMissionPause={(id) => window.companionApi.missionPause(id)}
          onApproveWorktree={(m, t) =>
            // Swallow IPC failures to null so the panel shows its inline error
            // state rather than rejecting the click handler (P0-5 — never silent).
            window.companionApi.approveWorktreeTask(m, t).catch(() => null)}
          onRejectWorktree={(m, t, reason) =>
            window.companionApi.rejectWorktreeTask(m, t, reason).catch(() => null)}
        />}
      </div>
    </div>
  )
}

function PanelContent({
  panel, onSendToSession, onMissionStop, onMissionPause, onApproveWorktree, onRejectWorktree,
}: {
  panel: PanelState
  onSendToSession?: (text: string) => boolean
  onMissionStop?: (id: string) => void
  onMissionPause?: (id: string) => void
  onApproveWorktree?: (missionId: string, taskId: string) => Promise<ReviewActionResult | null>
  onRejectWorktree?: (missionId: string, taskId: string, reason?: string) => Promise<ReviewActionResult | null>
}) {
  switch (panel.type) {
    case "diff": return <DiffPanel {...panel.props} onSend={onSendToSession} />
    case "form": return <FormPanel panelId={panel.id} {...panel.props} />
    case "image": return <ImagePanel {...panel.props} />
    case "markdown": return <MarkdownPanel {...panel.props} />
    case "table": return <TablePanel {...panel.props} />
    case "test": return <TestPanel {...panel.props} />
    case "chart": return <ChartPanel {...panel.props} />
    case "tree": return <TreePanel {...panel.props} />
    case "timeline": return <TimelinePanel {...panel.props} />
    case "git": return <GitPanel {...panel.props} />
    case "kanban": return <KanbanPanel {...panel.props} />
    case "notes": return <NotesPanel {...panel.props} />
    case "stat": return <StatPanel {...panel.props} />
    case "log": return <LogPanel {...panel.props} />
    case "progress": return <ProgressPanel {...panel.props} />
    case "code": return <CodePanel {...panel.props} />
    case "heatmap": return <HeatmapPanel {...(panel.props as any)} />
    case "mission": return <MissionPanel {...panel.props} onStop={onMissionStop} onPause={onMissionPause} />
    case "session-overview": return <SessionOverviewPanel {...(panel.props as any)} />
    case "recall": return <RecallPanel {...(panel.props as any)} />
    case "workspace-memory": return <WorkspaceMemoryPanel {...(panel.props as any)} />
    case "context-inspector": return <ContextInspectorPanel {...(panel.props as any)} />
    case "worktree-review": return (
      <WorktreeReviewPanel
        {...panel.props}
        onSend={onSendToSession}
        onApprove={onApproveWorktree}
        onReject={onRejectWorktree}
      />
    )
    default: return <pre className="panel-raw">{JSON.stringify(panel.props, null, 2)}</pre>
  }
}
