import { useCallback, useState } from "react"
import { modelSupportsXhigh } from "../../electron/services/streamProtocol"

interface Props {
  /** The work-session container the terminal belongs to (needed to respawn). */
  sessionId: string | null
  /** The structured (headless) terminal whose ultracode posture this toggles. */
  terminalId: string
  /** The terminal's current `--model` — gates the toggle's visibility (ultracode
   *  forces xhigh, so it only shows for xhigh-capable models). */
  model?: string
  /** CAPP-113 — the ADDITIVE config `models.xhigh` list, threaded into the visibility
   *  gate so a config-declared xhigh model also shows the toggle. Absent → built-ins only. */
  extraXhigh?: string[]
  /** CAPP-117 — the terminal's current `--effort`. Ultracode forces xhigh, so the
   *  toggle also HIDES when an explicit non-xhigh effort is selected (they'd fight):
   *  visible requires `!effort || effort === "xhigh"`. */
  effort?: string
  /** The terminal's current ultracode posture (true = on). */
  ultracode?: boolean
  /** "header" | "composer" — style variant, mirroring the effort/model pickers. */
  variant?: "header" | "composer"
  /**
   * Called with the REPLACEMENT terminal id after a toggle. The respawn mints a
   * fresh terminal id (mirroring the model/effort switches), so the caller must
   * re-point the active selection at it — otherwise the new surface renders hidden.
   */
  onSwitched?: (terminalId: string) => void
}

/**
 * CAPP-108 — the structured-engine Ultracode toggle, adjacent to the effort/model
 * pickers. Ultracode is a Claude Code SESSION SETTING (xhigh reasoning + auto
 * dynamic-workflows) enabled by `--settings '{"ultracode":true}'` on the spawn;
 * flipping it RESPAWNS the terminal (resuming the same conversation) via
 * SessionService.setTerminalUltracode. The respawn changes the terminal id, so this
 * component unmounts and remounts on the fresh terminal — no local state to keep in
 * sync. Read from the terminal ref (`ultracode` prop).
 *
 * VISIBILITY GATE (two conditions, both must hold): ultracode forces xhigh reasoning,
 * so the toggle is HIDDEN (a) for a non-xhigh model (Sonnet / Haiku) via
 * {@link modelSupportsXhigh}, AND (b) when an explicit non-xhigh `--effort` is selected
 * (CAPP-117) — the two would fight (ultracode wins, silently no-op'ing the picked
 * effort), so we don't offer ultracode there. Visible requires
 * `!effort || effort === "xhigh"`.
 */
export default function AgentUltracodeToggle({
  sessionId,
  terminalId,
  model,
  extraXhigh,
  effort,
  ultracode,
  variant = "composer",
  onSwitched,
}: Props) {
  const [busy, setBusy] = useState(false)
  const on = ultracode === true

  const onToggle = useCallback(async () => {
    if (!sessionId || busy) return
    setBusy(true)
    try {
      const res = await window.api.setTerminalUltracode(sessionId, terminalId, !on)
      if (res?.terminalId) onSwitched?.(res.terminalId)
    } catch {
      // Best-effort: a failed toggle leaves the terminal on its current posture.
    } finally {
      setBusy(false)
    }
  }, [sessionId, terminalId, on, busy, onSwitched])

  // Gate visibility on the selected model supporting xhigh AND no explicit non-xhigh
  // effort — ultracode forces xhigh, so it's meaningless (and would be rejected) on a
  // non-xhigh model, and it would silently override a picked lower effort. The hooks
  // above ALWAYS run (rules-of-hooks); only the render output is gated.
  if (!modelSupportsXhigh(model, extraXhigh)) return null
  if (effort && effort !== "xhigh") return null

  return (
    <label className={`agent-ultracode-toggle agent-ultracode-toggle-${variant}`}>
      <span className="agent-ultracode-toggle-label">Ultracode</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Ultracode"
        className={`agent-ultracode-toggle-switch ${on ? "on" : "off"}`}
        onClick={onToggle}
        disabled={busy || !sessionId}
        title={
          on
            ? "Ultracode is on — xhigh reasoning + auto dynamic-workflows. Click to turn off (respawns, keeping the conversation)."
            : "Turn on Ultracode — xhigh reasoning + auto dynamic-workflows (respawns, keeping the conversation)."
        }
      >
        {on ? "On" : "Off"}
      </button>
    </label>
  )
}
