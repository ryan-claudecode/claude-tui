import { useCallback, useRef, useState } from "react"
import { MODEL_ALIASES, DEFAULT_MODEL } from "../../electron/services/streamProtocol"

interface Props {
  /** The work-session container the terminal belongs to (needed to respawn). */
  sessionId: string | null
  /** The structured (headless) terminal whose model this picks. */
  terminalId: string
  /** The terminal's current `--model` (alias or id). */
  model?: string
  /**
   * CAPP-113 — the effective, config-extensible option list (built-in aliases ∪
   * config `models.extra` − `models.hidden`, order preserved). Absent → the built-in
   * {@link MODEL_ALIASES}. The current (possibly custom) model is always prepended if
   * not already present, so a respawned custom value renders selected.
   */
  options?: string[]
  /**
   * CAPP-113 — the RESOLVED full model id the headless `init` event reported (e.g.
   * `claude-opus-4-8`). DIAGNOSTIC-ONLY: shown as the select's `title` tooltip
   * ("opus → claude-opus-4-8") when known + different from the alias. No visible chrome.
   */
  resolvedModel?: string
  /** "header" (legacy surface toolbar) | "banner" (inline in the unavailable-model
   *  error) | "composer" (the compact secondary controls row under the composer). */
  variant?: "header" | "banner" | "composer"
  /**
   * Called with the REPLACEMENT terminal id after a switch. The respawn mints a
   * fresh terminal id (mirroring handoff/reopen), so the caller must re-point the
   * active selection at it — otherwise the new surface renders hidden.
   */
  onSwitched?: (terminalId: string) => void
}

/** Sentinel `<option>` value: opening the free-text custom entry (never a real model). */
const CUSTOM_SENTINEL = "__custom__"

/**
 * BO-6 / CAPP-113 — the structured-engine model control. A compact `<select>` of the
 * effective model list (built-in aliases + config `models.extra`); picking a different
 * one respawns the terminal with the new `--model` while resuming the same conversation
 * (SessionService.setTerminalModel). The respawn changes the terminal id, so this
 * component unmounts and remounts on the fresh terminal — no local model state to keep
 * in sync. Used in BOTH the surface header AND, with `variant="banner"`, the
 * model-unavailable error banner so the next disablement is self-service.
 *
 * CAPP-113 "never-stale": the list ends with a statically-visible "Custom…" option that
 * swaps in an inline free-text input, so a NEW model alias/id can be run with no code
 * edit; a successful switch persists it into config `models.extra` (it then appears in
 * the list from then on).
 */
export default function AgentModelPicker({
  sessionId,
  terminalId,
  model,
  options,
  resolvedModel,
  variant = "header",
  onSwitched,
}: Props) {
  const current = model && model.trim() ? model : DEFAULT_MODEL
  const [busy, setBusy] = useState(false)
  const [customMode, setCustomMode] = useState(false)
  const [customValue, setCustomValue] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  // The effective list (config-extensible); prepend the current model if it's an
  // unrecognized value (e.g. a pinned "claude-…" or a just-entered custom id) so the
  // select isn't blank/forced to a wrong value.
  const base = options && options.length ? options : MODEL_ALIASES
  const listed = base.includes(current) ? base : [current, ...base]

  // Diagnostic-only tooltip: what the alias resolved to (init echo), when known.
  const title =
    resolvedModel && resolvedModel !== current
      ? `${current} → ${resolvedModel}`
      : "Switch the model for this session (respawns, keeping the conversation)"

  // The single switch path, shared by the dropdown + the custom entry. On a SUCCESSFUL
  // switch (invoke resolves with a terminalId) a custom value is persisted into config
  // models.extra so it appears in the list from then on.
  const switchTo = useCallback(
    async (next: string, opts?: { persist?: boolean }) => {
      const value = next.trim()
      if (!sessionId || !value || value === current || busy) return
      setBusy(true)
      try {
        const res = await window.api.setTerminalModel(sessionId, terminalId, value)
        if (res?.terminalId) {
          if (opts?.persist) {
            // Best-effort persist — a failed write never blocks the switch.
            try {
              await window.api.addModelExtra(value)
            } catch {
              /* ignore */
            }
          }
          onSwitched?.(res.terminalId)
        }
      } catch {
        // Best-effort: a failed switch leaves the terminal on its current model.
      } finally {
        setBusy(false)
      }
    },
    [sessionId, terminalId, current, busy, onSwitched],
  )

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const next = e.target.value
      if (next === CUSTOM_SENTINEL) {
        setCustomValue("")
        setCustomMode(true)
        // Focus the input once it mounts.
        requestAnimationFrame(() => inputRef.current?.focus())
        return
      }
      void switchTo(next)
    },
    [switchTo],
  )

  const cancelCustom = useCallback(() => {
    setCustomMode(false)
    setCustomValue("")
  }, [])

  const submitCustom = useCallback(() => {
    const value = customValue.trim()
    // Blank OR already-current: a successful no-op — close the input back to the
    // select instead of silently doing nothing (switchTo would early-return on the
    // current model, leaving the input stranded open with no feedback).
    if (!value || value === current) {
      cancelCustom()
      return
    }
    // Persist the custom value on success so it joins the list.
    void switchTo(value, { persist: true })
  }, [customValue, current, switchTo, cancelCustom])

  const onCustomKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault()
        submitCustom()
      } else if (e.key === "Escape") {
        e.preventDefault()
        cancelCustom()
      }
    },
    [submitCustom, cancelCustom],
  )

  return (
    <label className={`agent-model-picker agent-model-picker-${variant}`}>
      <span className="agent-model-picker-label">Model</span>
      {customMode ? (
        <span className="agent-model-picker-custom-wrap">
          <input
            ref={inputRef}
            type="text"
            className="agent-model-picker-custom"
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            onKeyDown={onCustomKeyDown}
            onBlur={cancelCustom}
            disabled={busy || !sessionId}
            placeholder="model alias or full id"
            aria-label="Custom model"
            title="Type a model alias or full id, then Enter (or ✓) to switch. Esc cancels."
          />
          <button
            type="button"
            className="agent-model-picker-custom-ok"
            // Use onMouseDown so the click lands before the input's onBlur cancels it.
            onMouseDown={(e) => {
              e.preventDefault()
              submitCustom()
            }}
            disabled={busy || !sessionId || !customValue.trim()}
            aria-label="Apply custom model"
            title="Switch to this model (respawns, keeping the conversation)"
          >
            ✓
          </button>
        </span>
      ) : (
        <select
          className="agent-model-picker-select"
          value={current}
          onChange={onChange}
          disabled={busy || !sessionId}
          title={title}
          aria-label="Model"
        >
          {listed.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value={CUSTOM_SENTINEL}>Custom…</option>
        </select>
      )}
    </label>
  )
}
