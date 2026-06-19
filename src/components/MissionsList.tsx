import { useEffect, useRef } from "react"
import type { MissionSummary } from "../hooks/useMissions"
import { useFocusTrap } from "../hooks/useFocusTrap"

// Re-export so external consumers (tests, etc.) have a stable alias.
export type Mission = MissionSummary

interface Props {
  open: boolean
  missions: Mission[]
  onClose: () => void
  onOpen: (m: Mission) => void
  onStop: (id: string) => void
  onPause: (id: string) => void
  onResume: (id: string) => void
}

// Mirror MissionService's terminal set (mission.ts) — a terminal mission has
// no live workers/conductor, so it offers no actions.
const TERMINAL = ["done", "stopped"]

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

// Browse every mission (durable, on-disk) and jump into one's dashboard. The
// list is fed by useMissions (MS-2 push events), staying live without polling.
export default function MissionsList({ open, missions, onClose, onOpen, onStop, onPause, onResume }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener("keydown", handler, true)
    return () => window.removeEventListener("keydown", handler, true)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="missions-list-overlay" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className="missions-list-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Missions list"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="missions-list-header">
          <span className="missions-list-title">Missions</span>
          <span className="missions-list-count">{missions.length}</span>
          <button className="missions-list-close" onClick={onClose} aria-label="Close missions list">
            ×
          </button>
        </div>
        {missions.length === 0 ? (
          <div className="missions-list-empty">No missions yet. Start one with "Start Mission…".</div>
        ) : (
          <div className="missions-list-rows">
            {missions.map((m) => {
              const tasks = m.tasks ?? []
              const done = tasks.filter((t) => t.status === "done").length
              const active = !TERMINAL.includes(m.status)
              return (
                <div key={m.id} className="missions-list-row" onClick={() => onOpen(m)}>
                  <span className={`missions-list-status missions-list-status-${m.status}`}>{m.status}</span>
                  <div className="missions-list-body">
                    <div className="missions-list-goal">{m.goal}</div>
                    <div className="missions-list-sub">
                      <span>{done}/{tasks.length} tasks</span>
                      {m.autonomy && <span>· {m.autonomy}</span>}
                      <span>· {relativeTime(m.updatedAt)}</span>
                    </div>
                  </div>
                  <div className="missions-list-actions" onClick={(e) => e.stopPropagation()}>
                    {m.status === "paused" && (
                      <button onClick={() => onResume(m.id)} title="Resume">Resume</button>
                    )}
                    {m.status === "running" && (
                      <button onClick={() => onPause(m.id)} title="Pause">Pause</button>
                    )}
                    {active && (
                      <button onClick={() => onStop(m.id)} title="Stop">Stop</button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
