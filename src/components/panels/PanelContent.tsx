import DiffPanel from "./DiffPanel"
import FormPanel from "./FormPanel"
import ImagePanel from "./ImagePanel"
import MarkdownPanel from "./MarkdownPanel"
import TablePanel from "./TablePanel"
import TestPanel from "./TestPanel"
import ChartPanel from "./ChartPanel"
import TreePanel from "./TreePanel"
import TimelinePanel from "./TimelinePanel"
import GitPanel from "./GitPanel"
import KanbanPanel from "./KanbanPanel"
import NotesPanel from "./NotesPanel"
import StatPanel from "./StatPanel"
import LogPanel from "./LogPanel"
import ProgressPanel from "./ProgressPanel"
import CodePanel from "./CodePanel"
import HeatmapPanel from "./HeatmapPanel"
import MissionPanel from "./MissionPanel"
import SessionOverviewPanel from "./SessionOverviewPanel"
import RecallPanel from "./RecallPanel"
import WorktreeReviewPanel from "./WorktreeReviewPanel"
import WorkspaceMemoryPanel from "./WorkspaceMemoryPanel"
import ContextInspectorPanel from "./ContextInspectorPanel"
import type { PanelApi } from "../../lib/panelApi"

/**
 * CAPP-106 / S1 — the SINGLE shared panel switch. Lifted out of `CompanionApp.tsx`
 * so BOTH the companion window AND (in S2) the main-window ModalHost render every
 * panel through ONE code path — killing the prior drift between CompanionApp, the
 * stale PanelDrawer, and the would-be modal.
 *
 * The contract is `(panel, api)` where `api: PanelApi` is ONE behavior object the
 * switch derives EVERY callback it threads from (this folds the six callbacks the
 * companion used to thread inline — onSendToSession / onMissionStop / onMissionPause
 * / onApproveWorktree / onRejectWorktree, plus the #19-23 panel-internal accessors —
 * into `api`, dropping NONE of them). Each caller builds a `PanelApi` over its native
 * bridge (companion → window.companionApi; modal → window.api). `api` is optional so a
 * harness can render a static panel without a bridge; the behavior panels degrade
 * gracefully when it's absent (e.g. RecallPanel's A.4 negative control).
 */

/** The minimal panel shape the switch reads. Mirrors `PanelService.PanelState`'s
 *  renderer-facing fields (the union both windows receive over `panel:show`). */
export interface PanelLike {
  id: string
  type: string
  props: Record<string, any>
}

/** Display label for a panel TYPE (the generic fallback the tab strip uses). */
export const PANEL_LABELS: Record<string, string> = {
  diff: "Diff", form: "Form", image: "Image", markdown: "Markdown",
  table: "Table", test: "Tests", chart: "Chart", tree: "Tree",
  timeline: "Timeline", git: "Git", kanban: "Kanban", notes: "Notes",
  stat: "Stats", log: "Log", progress: "Progress", code: "Code",
  heatmap: "Heatmap", mission: "Mission", "session-overview": "Overview",
  "worktree-review": "Review", recall: "Recall", "workspace-memory": "Memory",
  "context-inspector": "Context",
}

/** The specialized tab/title label for a concrete panel: the session name for an
 *  overview, the title for a review, the workspace name for memory/context — falling
 *  back to the type's generic label. Shared by the companion tab strip AND (S2) the
 *  modal's title/tab strip so they can never drift. */
export function tabLabel(p: PanelLike): string {
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

export interface PanelContentProps {
  panel: PanelLike
  /** The single behavior object the switch derives every callback from. Optional so a
   *  static harness can render without a bridge (behavior panels degrade gracefully). */
  api?: PanelApi
}

export default function PanelContent({ panel, api }: PanelContentProps) {
  switch (panel.type) {
    case "diff":
      return <DiffPanel {...panel.props} onSend={api?.sendToSession} />
    case "form":
      return <FormPanel panelId={panel.id} {...panel.props} />
    case "image":
      return <ImagePanel {...panel.props} />
    case "markdown":
      return <MarkdownPanel {...panel.props} />
    case "table":
      return <TablePanel {...panel.props} />
    case "test":
      return <TestPanel {...panel.props} />
    case "chart":
      return <ChartPanel {...panel.props} />
    case "tree":
      return <TreePanel {...panel.props} />
    case "timeline":
      return <TimelinePanel {...panel.props} />
    case "git":
      return <GitPanel {...panel.props} />
    case "kanban":
      return <KanbanPanel {...panel.props} />
    case "notes":
      return <NotesPanel {...panel.props} />
    case "stat":
      return <StatPanel {...panel.props} />
    case "log":
      return <LogPanel {...panel.props} />
    case "progress":
      return <ProgressPanel {...panel.props} />
    case "code":
      return <CodePanel {...panel.props} />
    case "heatmap":
      return <HeatmapPanel {...(panel.props as any)} />
    case "mission":
      return (
        <MissionPanel
          {...panel.props}
          onStop={api?.missionStop}
          onPause={api?.missionPause}
        />
      )
    case "session-overview":
      return <SessionOverviewPanel {...(panel.props as any)} api={api} />
    case "recall":
      return <RecallPanel {...(panel.props as any)} api={api} />
    case "workspace-memory":
      return <WorkspaceMemoryPanel {...(panel.props as any)} api={api} />
    case "context-inspector":
      return <ContextInspectorPanel {...(panel.props as any)} api={api} />
    case "worktree-review":
      return (
        <WorktreeReviewPanel
          {...panel.props}
          onSend={api?.sendToSession}
          // Swallow IPC failures to null so the panel shows its inline error state
          // rather than rejecting the click handler (P0-5 — never silent).
          onApprove={
            api
              ? (m, t) => api.approveWorktreeTask(m, t).catch(() => null)
              : undefined
          }
          onReject={
            api
              ? (m, t, reason) => api.rejectWorktreeTask(m, t, reason).catch(() => null)
              : undefined
          }
        />
      )
    default:
      return <pre className="panel-raw">{JSON.stringify(panel.props, null, 2)}</pre>
  }
}
