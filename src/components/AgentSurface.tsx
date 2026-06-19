import { useCallback, useState } from "react"
import AgentView, { type TranscriptCache } from "./AgentView"
import AgentComposer from "./AgentComposer"
import AgentModelPicker from "./AgentModelPicker"
import AgentEffortPicker from "./AgentEffortPicker"
import { toast } from "../lib/toast"

interface Props {
  /** The structured (headless) terminal this surface renders. */
  terminalId: string
  /** The work-session container the terminal belongs to (for the model switch). */
  sessionId: string | null
  /** The terminal's current `--model` (shown in + driven by the header picker). */
  model?: string
  /** CAPP-46 — the terminal's current `--effort` level (shown in + driven by the
   *  header effort picker); undefined when no level is set. */
  effort?: string
  /** BO-12 — the terminal's Claude Code conversation id (for transcript rehydrate). */
  ccConversationId?: string
  /** BO-12 — the shared, cross-pane transcript cache. */
  transcriptCache?: TranscriptCache
  active: boolean
  /**
   * BO-10 — the terminal is generating a turn or parked on a permission prompt.
   * Drives the composer's Stop button + disabled Send. Optional/defaults to false
   * so the split-pane call site (CAPP-42) compiles unchanged until it threads busy.
   */
  busy?: boolean
  /** Re-point the active selection at the respawned terminal after a model switch
   *  OR an interrupt respawn (both mint a new terminal id). */
  onSwitched?: (terminalId: string) => void
}

/**
 * BO-6 — the full structured-engine surface: a slim header with the model picker,
 * the AgentView transcript, and the AgentComposer. Factored out of App.tsx /
 * SplitView so the header (and the model-unavailable banner inside AgentView) live
 * in ONE place shared by the single-pane and split layouts. Replaces the inline
 * `<div class="agent-surface"><AgentView/><AgentComposer/></div>` both call sites
 * used before.
 *
 * CAPP-39 gate ③ — the header also carries the "Raw view" escape hatch: switch THIS
 * structured terminal back to the legacy xterm/PTY engine at runtime (resuming the
 * same conversation). Copies the AgentModelPicker respawn-and-re-point pattern
 * (setTerminalEngine → res.terminalId → onSwitched), so the surface stays
 * self-contained and works identically single-pane and in a split.
 */
export default function AgentSurface({
  terminalId,
  sessionId,
  model,
  effort,
  ccConversationId,
  transcriptCache,
  active,
  busy,
  onSwitched,
}: Props) {
  const [switching, setSwitching] = useState(false)
  const switchToRaw = useCallback(async () => {
    if (!sessionId || busy || switching) return
    setSwitching(true)
    try {
      const res = await window.api.setTerminalEngine(sessionId, terminalId, "xterm")
      if (res?.terminalId) onSwitched?.(res.terminalId)
      // A refused switch returns undefined; clear the transient flag so the button is
      // usable again, and toast WHY (mirroring the command-palette path in App.tsx).
      // The button is busy-disabled, so the only reachable refusal here is the no-cc
      // case (the session hasn't started a conversation yet).
      else {
        setSwitching(false)
        toast(
          "warning",
          "Couldn't switch the view yet — the session needs a started conversation first.",
        )
      }
    } catch {
      setSwitching(false)
    }
  }, [sessionId, terminalId, busy, switching, onSwitched])

  return (
    <div className={`agent-surface ${active ? "active" : "hidden"}`}>
      <div className="agent-surface-header">
        <AgentModelPicker sessionId={sessionId} terminalId={terminalId} model={model} onSwitched={onSwitched} />
        <AgentEffortPicker sessionId={sessionId} terminalId={terminalId} effort={effort} onSwitched={onSwitched} />
        {/* CAPP-39 gate ③ — switch this session to the raw xterm terminal. Disabled
            while the agent is busy (the switch would lose the live turn — Stop first). */}
        <button
          className="agent-raw-view-btn"
          onClick={switchToRaw}
          disabled={!sessionId || busy || switching}
          title="Switch this session to the raw terminal view (keeps the conversation)"
        >
          {switching ? "Switching…" : "Raw view"}
        </button>
      </div>
      <AgentView
        terminalId={terminalId}
        active={active}
        busy={busy}
        sessionId={sessionId}
        model={model}
        ccConversationId={ccConversationId}
        transcriptCache={transcriptCache}
        onSwitched={onSwitched}
      />
      <AgentComposer terminalId={terminalId} busy={busy} onSwitched={onSwitched} />
    </div>
  )
}
