import { useCallback, useState } from "react"
import { EFFORT_LEVELS } from "../../electron/services/streamProtocol"

interface Props {
  /** The work-session container the terminal belongs to (needed to respawn). */
  sessionId: string | null
  /** The structured (headless) terminal whose effort this picks. */
  terminalId: string
  /** The terminal's current `--effort` level, or undefined when none is set. */
  effort?: string
  /** "header" (legacy surface toolbar) | "banner" (inline variant, for parity with the
   *  model picker) | "composer" (the compact secondary controls row under the composer). */
  variant?: "header" | "banner" | "composer"
  /**
   * Called with the REPLACEMENT terminal id after a switch. The respawn mints a
   * fresh terminal id (mirroring the model switch / handoff / reopen), so the caller
   * must re-point the active selection at it — otherwise the new surface renders hidden.
   */
  onSwitched?: (terminalId: string) => void
}

/** Sentinel `<option>` value for "no explicit effort" (Claude's built-in default).
 *  Distinct from the levels so picking it CLEARS the level (the respawn omits --effort). */
const UNSET = ""

/**
 * CAPP-46 — the structured-engine reasoning-effort control, mirroring
 * {@link AgentModelPicker}. A compact `<select>` of the effort LEVELS (low, medium,
 * high, xhigh, max) plus a "default" sentinel; picking a different one respawns the
 * terminal with the new `--effort` (or omits it for "default") while resuming the
 * same conversation (SessionService.setTerminalEffort). The respawn changes the
 * terminal id, so this component unmounts and remounts on the fresh terminal — no
 * local effort state to keep in sync. The `init` event does NOT report effort, so the
 * current value is read from the terminal ref (`effort` prop).
 */
export default function AgentEffortPicker({ sessionId, terminalId, effort, variant = "header", onSwitched }: Props) {
  const current = effort && effort.trim() ? effort : UNSET
  const [busy, setBusy] = useState(false)

  // Offer the level list; if the current effort is an unrecognized raw value, surface
  // it as an extra option so the select isn't blank/forced to a wrong value.
  const known = current === UNSET || EFFORT_LEVELS.includes(current)
  const options = known ? EFFORT_LEVELS : [current, ...EFFORT_LEVELS]

  const onChange = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const next = e.target.value
      if (!sessionId || next === current || busy) return
      setBusy(true)
      try {
        // A blank value (the "default" sentinel) clears the level server-side.
        const res = await window.api.setTerminalEffort(sessionId, terminalId, next)
        if (res?.terminalId) onSwitched?.(res.terminalId)
      } catch {
        // Best-effort: a failed switch leaves the terminal on its current effort.
      } finally {
        setBusy(false)
      }
    },
    [sessionId, terminalId, current, busy, onSwitched],
  )

  return (
    <label className={`agent-effort-picker agent-effort-picker-${variant}`}>
      <span className="agent-effort-picker-label">Effort</span>
      <select
        className="agent-effort-picker-select"
        value={current}
        onChange={onChange}
        disabled={busy || !sessionId}
        title="Switch the reasoning effort for this session (respawns, keeping the conversation)"
        aria-label="Effort"
      >
        <option value={UNSET}>default</option>
        {options.map((e) => (
          <option key={e} value={e}>
            {e}
          </option>
        ))}
      </select>
    </label>
  )
}
