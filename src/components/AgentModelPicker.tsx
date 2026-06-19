import { useCallback, useState } from "react"
import { MODEL_ALIASES, DEFAULT_MODEL } from "../../electron/services/streamProtocol"

interface Props {
  /** The work-session container the terminal belongs to (needed to respawn). */
  sessionId: string | null
  /** The structured (headless) terminal whose model this picks. */
  terminalId: string
  /** The terminal's current `--model` (alias or id). */
  model?: string
  /** "header" (the surface toolbar) | "banner" (inline in the unavailable-model error). */
  variant?: "header" | "banner"
  /**
   * Called with the REPLACEMENT terminal id after a switch. The respawn mints a
   * fresh terminal id (mirroring handoff/reopen), so the caller must re-point the
   * active selection at it — otherwise the new surface renders hidden.
   */
  onSwitched?: (terminalId: string) => void
}

/**
 * BO-6 — the structured-engine model control. A compact `<select>` of the model
 * ALIASES (opus, opus[1m], sonnet, haiku); picking a different one respawns the
 * terminal with the new `--model` while resuming the same conversation
 * (SessionService.setTerminalModel). The respawn changes the terminal id, so this
 * component unmounts and remounts on the fresh terminal — no local model state to
 * keep in sync. Used in BOTH the surface header AND, with `variant="banner"`, the
 * model-unavailable error banner so the next disablement is self-service.
 */
export default function AgentModelPicker({ sessionId, terminalId, model, variant = "header", onSwitched }: Props) {
  const current = model && model.trim() ? model : DEFAULT_MODEL
  const [busy, setBusy] = useState(false)

  // Always offer the alias list; if the current model is an unrecognized raw id
  // (e.g. a pinned "claude-…"), surface it as an extra option so the select isn't
  // blank/forced to a wrong value.
  const options = MODEL_ALIASES.includes(current) ? MODEL_ALIASES : [current, ...MODEL_ALIASES]

  const onChange = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const next = e.target.value
      if (!sessionId || !next || next === current || busy) return
      setBusy(true)
      try {
        const res = await window.api.setTerminalModel(sessionId, terminalId, next)
        if (res?.terminalId) onSwitched?.(res.terminalId)
      } catch {
        // Best-effort: a failed switch leaves the terminal on its current model.
      } finally {
        setBusy(false)
      }
    },
    [sessionId, terminalId, current, busy, onSwitched],
  )

  return (
    <label className={`agent-model-picker agent-model-picker-${variant}`}>
      <span className="agent-model-picker-label">Model</span>
      <select
        className="agent-model-picker-select"
        value={current}
        onChange={onChange}
        disabled={busy || !sessionId}
        title="Switch the model for this session (respawns, keeping the conversation)"
        aria-label="Model"
      >
        {options.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </label>
  )
}
