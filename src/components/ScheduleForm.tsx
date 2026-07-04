import { useState, useEffect, useRef } from "react"
import { useFocusTrap } from "../hooks/useFocusTrap"
import type { Recurrence } from "../../electron/services/scheduleMath"
import type { ScheduleSummary, ScheduleFormInput } from "../hooks/useSchedules"

type Kind = "interval" | "daily" | "once"

interface Props {
  open: boolean
  /** When set, the overlay edits this schedule; otherwise it creates a new one. */
  editing?: ScheduleSummary | null
  onClose: () => void
  onSubmit: (input: ScheduleFormInput) => void
  onDelete?: (id: string) => void
}

const DAY_LABELS: Array<{ d: number; label: string }> = [
  { d: 0, label: "Sun" },
  { d: 1, label: "Mon" },
  { d: 2, label: "Tue" },
  { d: 3, label: "Wed" },
  { d: 4, label: "Thu" },
  { d: 5, label: "Fri" },
  { d: 6, label: "Sat" },
]

// Convert an ISO string into a <input type="datetime-local"> value (local, no tz).
function toLocalInput(iso: string | undefined): string {
  const d = iso ? new Date(iso) : new Date(Date.now() + 60 * 60 * 1000)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * CAPP-114 (SCHED-1) — the renderer-local create/edit overlay for a scheduled run.
 * A focus-trapped full-screen overlay (NOT PanelService show_form, which
 * is agent-driven and holds an MCP promise). Every control is statically visible.
 */
export default function ScheduleForm({ open, editing, onClose, onSubmit, onDelete }: Props) {
  const [name, setName] = useState("")
  const [prompt, setPrompt] = useState("")
  const [kind, setKind] = useState<Kind>("interval")
  const [everyMinutes, setEveryMinutes] = useState(20)
  const [windowStart, setWindowStart] = useState("")
  const [windowEnd, setWindowEnd] = useState("")
  const [dailyAt, setDailyAt] = useState("09:00")
  const [onceAt, setOnceAt] = useState(toLocalInput(undefined))
  const [days, setDays] = useState<Set<number>>(() => new Set())
  const [model, setModel] = useState("")
  const [catchUp, setCatchUp] = useState(false)

  const nameRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)

  // Prefill on open (from `editing`, or defaults for a new schedule).
  useEffect(() => {
    if (!open) return
    const e = editing
    setName(e?.name ?? "")
    setPrompt(e?.prompt ?? "")
    setModel(e?.model ?? "")
    setCatchUp(e?.catchUp === true)
    const r = e?.recurrence
    setKind(r?.kind ?? "interval")
    setDays(new Set(r && "days" in r && r.days ? r.days : []))
    if (r?.kind === "interval") {
      setEveryMinutes(r.everyMinutes)
      setWindowStart(r.window?.start ?? "")
      setWindowEnd(r.window?.end ?? "")
    } else {
      setEveryMinutes(20)
      setWindowStart("")
      setWindowEnd("")
    }
    setDailyAt(r?.kind === "daily" ? r.at : "09:00")
    setOnceAt(r?.kind === "once" ? toLocalInput(r.at) : toLocalInput(undefined))
    requestAnimationFrame(() => nameRef.current?.focus())
  }, [open, editing])

  if (!open) return null

  const toggleDay = (d: number) =>
    setDays((prev) => {
      const next = new Set(prev)
      if (next.has(d)) next.delete(d)
      else next.add(d)
      return next
    })

  const buildRecurrence = (): Recurrence | null => {
    const dayList = [...days].sort((a, b) => a - b)
    if (kind === "interval") {
      if (!Number.isFinite(everyMinutes) || everyMinutes < 1) return null
      const hasWindow = windowStart.trim() && windowEnd.trim()
      return {
        kind: "interval",
        everyMinutes: Math.floor(everyMinutes),
        ...(hasWindow ? { window: { start: windowStart.trim(), end: windowEnd.trim() } } : {}),
        ...(dayList.length ? { days: dayList } : {}),
      }
    }
    if (kind === "daily") {
      if (!dailyAt.trim()) return null
      return { kind: "daily", at: dailyAt.trim(), ...(dayList.length ? { days: dayList } : {}) }
    }
    if (!onceAt.trim()) return null
    const at = new Date(onceAt)
    if (Number.isNaN(at.getTime())) return null
    return { kind: "once", at: at.toISOString() }
  }

  const canSubmit = name.trim().length > 0 && prompt.trim().length > 0 && buildRecurrence() !== null

  const submit = () => {
    const recurrence = buildRecurrence()
    if (!name.trim() || !prompt.trim() || !recurrence) return
    onClose()
    onSubmit({
      name: name.trim(),
      prompt: prompt.trim(),
      recurrence,
      // Send the raw trimmed string — "" is MEANINGFUL on the edit path: update()
      // maps `patch.model || undefined`, so blanking the field CLEARS a previously
      // set model override (folding "" → undefined here made clearing impossible —
      // update()'s `!== undefined` guard never saw it). On create, "" is dropped by
      // create()'s conditional spread, so a blank field still means "no override".
      model: model.trim(),
      catchUp,
    })
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
    <div className="schedule-form-overlay" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className="schedule-form-panel"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? "Edit scheduled run" : "New scheduled run"}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={handleKey}
      >
        <div className="schedule-form-header">
          <span className="schedule-form-title">{editing ? "Edit scheduled run" : "New scheduled run"}</span>
          <button className="schedule-form-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <label className="schedule-form-label" htmlFor="sched-name">Name</label>
        <input
          id="sched-name"
          ref={nameRef}
          className="schedule-form-input"
          placeholder="Fable watch"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <label className="schedule-form-label" htmlFor="sched-prompt">Prompt</label>
        <textarea
          id="sched-prompt"
          className="schedule-form-textarea"
          placeholder="Check the web for Fable 5 availability; if it returned, file a GitHub issue…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
        />

        <label className="schedule-form-label">Recurrence</label>
        <div className="schedule-form-kinds">
          {(["interval", "daily", "once"] as Kind[]).map((k) => (
            <button
              key={k}
              className={`schedule-form-kind ${kind === k ? "active" : ""}`}
              onClick={() => setKind(k)}
              type="button"
            >
              {k === "interval" ? "Interval" : k === "daily" ? "Daily" : "Once"}
            </button>
          ))}
        </div>

        {kind === "interval" && (
          <div className="schedule-form-recur">
            <div className="schedule-form-field">
              <span className="schedule-form-sub">Every (minutes)</span>
              <input
                className="schedule-form-input schedule-form-num"
                type="number"
                min={1}
                value={everyMinutes}
                onChange={(e) => setEveryMinutes(Number(e.target.value))}
              />
            </div>
            <div className="schedule-form-field">
              <span className="schedule-form-sub">Window (optional, local)</span>
              <div className="schedule-form-window">
                <input className="schedule-form-input" type="time" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} />
                <span className="schedule-form-dash">–</span>
                <input className="schedule-form-input" type="time" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} />
              </div>
            </div>
          </div>
        )}

        {kind === "daily" && (
          <div className="schedule-form-field">
            <span className="schedule-form-sub">At (local time)</span>
            <input className="schedule-form-input" type="time" value={dailyAt} onChange={(e) => setDailyAt(e.target.value)} />
          </div>
        )}

        {kind === "once" && (
          <div className="schedule-form-field">
            <span className="schedule-form-sub">Run at (local)</span>
            <input className="schedule-form-input" type="datetime-local" value={onceAt} onChange={(e) => setOnceAt(e.target.value)} />
          </div>
        )}

        {(kind === "interval" || kind === "daily") && (
          <div className="schedule-form-field">
            <span className="schedule-form-sub">Days (optional — all days if none)</span>
            <div className="schedule-form-days">
              {DAY_LABELS.map(({ d, label }) => (
                <button
                  key={d}
                  type="button"
                  className={`schedule-form-day ${days.has(d) ? "active" : ""}`}
                  onClick={() => toggleDay(d)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        <label className="schedule-form-label" htmlFor="sched-model">Model (optional)</label>
        <input
          id="sched-model"
          className="schedule-form-input"
          placeholder="default (e.g. opus, sonnet)"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />

        <label className="schedule-form-check">
          <input type="checkbox" checked={catchUp} onChange={(e) => setCatchUp(e.target.checked)} />
          <span>Catch up: run once at launch if a fire was missed while the app was closed</span>
        </label>

        <div className="schedule-form-actions">
          {editing && onDelete && (
            <button
              className="schedule-form-delete"
              onClick={() => {
                onClose()
                onDelete(editing.id)
              }}
              type="button"
            >
              Delete
            </button>
          )}
          <span className="schedule-form-spacer" />
          <button className="schedule-form-cancel" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="schedule-form-save" onClick={submit} disabled={!canSubmit} type="button">
            {editing ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  )
}
