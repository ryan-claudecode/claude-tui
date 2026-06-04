import { useState, useRef, useCallback } from "react"
import DiffPanel from "./panels/DiffPanel"
import FormPanel from "./panels/FormPanel"
import ImagePanel from "./panels/ImagePanel"
import MarkdownPanel from "./panels/MarkdownPanel"
import TablePanel from "./panels/TablePanel"
import TestPanel from "./panels/TestPanel"
import ChartPanel from "./panels/ChartPanel"
import TreePanel from "./panels/TreePanel"
import TimelinePanel from "./panels/TimelinePanel"
import GitPanel from "./panels/GitPanel"
import KanbanPanel from "./panels/KanbanPanel"
import NotesPanel from "./panels/NotesPanel"
import StatPanel from "./panels/StatPanel"
import LogPanel from "./panels/LogPanel"
import ProgressPanel from "./panels/ProgressPanel"
import CodePanel from "./panels/CodePanel"

export interface PanelState {
  id: string
  type: string
  position: "right" | "bottom"
  width?: number
  height?: number
  props: Record<string, any>
  visible: boolean
}

interface Props {
  panels: PanelState[]
  onClose: (id: string) => void
}

const PANEL_LABELS: Record<string, string> = {
  diff: "Diff",
  form: "Form",
  image: "Image",
  markdown: "Markdown",
  table: "Table",
  test: "Tests",
  chart: "Chart",
  tree: "Tree",
  timeline: "Timeline",
  git: "Git",
  kanban: "Kanban",
  notes: "Notes",
  stat: "Stats",
  log: "Log",
  progress: "Progress",
  code: "Code",
}

export default function PanelDrawer({ panels, onClose }: Props) {
  const visiblePanels = panels.filter((p) => p.visible)
  const [activeIdx, setActiveIdx] = useState(0)

  // Resize handling
  const [size, setSize] = useState<number | null>(null)
  const [maximized, setMaximized] = useState(false)
  const dragging = useRef(false)

  const panel = visiblePanels[Math.min(activeIdx, visiblePanels.length - 1)]

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      if (!panel) return
      dragging.current = true
      e.preventDefault()
      const isRight = panel.position === "right"
      const startPos = isRight ? e.clientX : e.clientY
      const startSize = size ?? (isRight ? window.innerWidth * 0.4 : window.innerHeight * 0.4)

      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return
        const delta = isRight ? startPos - ev.clientX : startPos - ev.clientY
        const next = Math.min(
          isRight ? window.innerWidth * 0.85 : window.innerHeight * 0.85,
          Math.max(240, startSize + delta)
        )
        setSize(next)
      }
      const onUp = () => {
        dragging.current = false
        window.removeEventListener("mousemove", onMove)
        window.removeEventListener("mouseup", onUp)
      }
      window.addEventListener("mousemove", onMove)
      window.addEventListener("mouseup", onUp)
    },
    [panel, size]
  )

  if (visiblePanels.length === 0 || !panel) return null

  const isRight = panel.position === "right"
  const style: React.CSSProperties = maximized
    ? isRight
      ? { width: "92%" }
      : { height: "92%" }
    : isRight
      ? { width: size ?? "40%" }
      : { height: size ?? "40%" }

  return (
    <div
      className={`panel-drawer panel-drawer-${panel.position}${maximized ? " maximized" : ""}`}
      style={style}
    >
      {!maximized && <div className="panel-resize-handle" onMouseDown={onResizeStart} />}
      <div className="panel-header">
        <div className="panel-tabs">
          {visiblePanels.map((p, i) => (
            <button
              key={p.id}
              className={`panel-tab ${p === panel ? "active" : ""}`}
              onClick={() => setActiveIdx(i)}
            >
              {PANEL_LABELS[p.type] ?? p.type}
            </button>
          ))}
        </div>
        <div className="panel-header-actions">
          <button
            className="panel-action"
            onClick={() => setMaximized((m) => !m)}
            title={maximized ? "Restore panel" : "Maximize panel"}
          >
            {maximized ? "❐" : "⤢"}
          </button>
          <button className="panel-close" onClick={() => onClose(panel.id)} title="Close panel">
            ×
          </button>
        </div>
      </div>
      <div className="panel-body">
        <PanelContent panel={panel} />
      </div>
    </div>
  )
}

function PanelContent({ panel }: { panel: PanelState }) {
  switch (panel.type) {
    case "diff":
      return <DiffPanel {...panel.props} />
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
    default:
      return <pre className="panel-raw">{JSON.stringify(panel.props, null, 2)}</pre>
  }
}
