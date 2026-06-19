import { useState, useEffect, useRef } from "react"
import { useFocusTrap } from "../hooks/useFocusTrap"

export type Autonomy = "hands-off" | "checkpoints" | "supervised"

interface Props {
  open: boolean
  onClose: () => void
  onSubmit: (goal: string, autonomy: Autonomy) => void
}

const AUTONOMY_OPTS: { value: Autonomy; label: string; hint: string }[] = [
  { value: "hands-off", label: "Hands-off", hint: "Run to completion without stopping" },
  { value: "checkpoints", label: "Checkpoints", hint: "Pause for approval at milestones" },
  { value: "supervised", label: "Supervised", hint: "Confirm each task before it runs" },
]

// Modal for kicking off an orchestration mission. Replaces window.prompt (which
// Electron does not implement) — matches the app's overlay pattern.
export default function MissionPrompt({ open, onClose, onSubmit }: Props) {
  const [goal, setGoal] = useState("")
  const [autonomy, setAutonomy] = useState<Autonomy>("hands-off")
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)

  useEffect(() => {
    if (open) {
      setGoal("")
      setAutonomy("hands-off")
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  if (!open) return null

  const submit = () => {
    const trimmed = goal.trim()
    if (!trimmed) return
    onClose()
    onSubmit(trimmed, autonomy)
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault()
      onClose()
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="mission-prompt-overlay" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className="mission-prompt-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Start mission"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mission-prompt-header">
          <span className="mission-prompt-title">Start Mission</span>
          <button className="mission-prompt-close" onClick={onClose} aria-label="Close start mission dialog">
            ×
          </button>
        </div>
        <label className="mission-prompt-label">Goal</label>
        <textarea
          ref={inputRef}
          className="mission-prompt-input"
          placeholder="Describe the goal to orchestrate…"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={handleKey}
          rows={3}
        />
        <label className="mission-prompt-label">Autonomy</label>
        <div className="mission-prompt-autonomy">
          {AUTONOMY_OPTS.map((opt) => (
            <button
              key={opt.value}
              className={`mission-prompt-opt ${autonomy === opt.value ? "active" : ""}`}
              onClick={() => setAutonomy(opt.value)}
              title={opt.hint}
            >
              <span className="mission-prompt-opt-label">{opt.label}</span>
              <span className="mission-prompt-opt-hint">{opt.hint}</span>
            </button>
          ))}
        </div>
        <div className="mission-prompt-actions">
          <button className="mission-prompt-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="mission-prompt-start" onClick={submit} disabled={!goal.trim()}>
            Start Mission
          </button>
        </div>
      </div>
    </div>
  )
}
