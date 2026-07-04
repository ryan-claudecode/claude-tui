import { useCallback, useState } from "react"
import AgentView, { type TranscriptCache } from "./AgentView"
import AgentComposer from "./AgentComposer"
import ContextMeterBar from "./ContextMeterBar"
import type { ContextMeter } from "../lib/contextMeter"
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
  /** CAPP-108 — the terminal's current ultracode posture (driven by the toggle in
   *  the composer controls row; only renders for xhigh-capable models). */
  ultracode?: boolean
  /** CAPP-113 — the effective, config-extensible model option list for the picker. */
  modelOptions?: string[]
  /** CAPP-113 — the RESOLVED full model id (init echo) for the picker's tooltip. */
  resolvedModel?: string
  /** CAPP-113 — the ADDITIVE config models.xhigh list for the ultracode visibility gate. */
  extraXhigh?: string[]
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
 * CAPP-39 gate ③ — the surface also owns the "Raw view" escape hatch: switch THIS
 * structured terminal back to the legacy xterm/PTY engine at runtime (resuming the
 * same conversation). Copies the AgentModelPicker respawn-and-re-point pattern
 * (setTerminalEngine → res.terminalId → onSwitched), so the surface stays
 * self-contained and works identically single-pane and in a split.
 *
 * UI tweak (header removal) — the old top header bar is gone; the model picker, the
 * effort picker, and the Raw-view button now live in a `.composer-controls-row`
 * UNDER the composer's send/stop button row. AgentSurface still owns the switchToRaw
 * handler + switching state (it has the sessionId/terminalId), and threads them — plus
 * model/effort — down into AgentComposer, which renders the secondary chrome.
 */
export default function AgentSurface({
  terminalId,
  sessionId,
  model,
  effort,
  ultracode,
  modelOptions,
  resolvedModel,
  extraXhigh,
  ccConversationId,
  transcriptCache,
  active,
  busy,
  onSwitched,
}: Props) {
  const [switching, setSwitching] = useState(false)
  // CAPP-127 — the derived context meter, lifted from AgentView (which owns the folded
  // blocks). Null until a usage-bearing result lands → the bar stays hidden.
  const [contextMeter, setContextMeter] = useState<ContextMeter | null>(null)

  // CAPP-127 — the legend's "Compact" action: send `/compact` through the SAME
  // agent-input path the composer's send uses (the slash forwards unchanged to Claude,
  // per the BO-7 routing). Guarded to a live, non-busy terminal.
  const compact = useCallback(() => {
    if (busy || !sessionId) return
    window.api.sendAgentInput(terminalId, { text: "/compact", attachments: [] })
  }, [busy, sessionId, terminalId])

  // CAPP-127 — the legend's "Handoff" action: retire-and-continue THIS terminal via the
  // same window.api.handoffTerminal mechanism as Ctrl+Shift+H (flush summary + fresh
  // terminal + retire old — the logic lives in the backend service, not duplicated here).
  // The respawn mints a new terminal id; onSwitched re-points the active selection at it.
  const handoff = useCallback(async () => {
    if (!sessionId) return
    try {
      const r = await window.api.handoffTerminal(sessionId, terminalId)
      if (r?.terminalId) onSwitched?.(r.terminalId)
    } catch {
      toast("error", "Couldn't hand off the terminal.")
    }
  }, [sessionId, terminalId, onSwitched])

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
      <AgentView
        terminalId={terminalId}
        active={active}
        busy={busy}
        sessionId={sessionId}
        model={model}
        modelOptions={modelOptions}
        resolvedModel={resolvedModel}
        ccConversationId={ccConversationId}
        transcriptCache={transcriptCache}
        onSwitched={onSwitched}
        onContextMeter={setContextMeter}
      />
      {/* CAPP-127 — the live context meter, spanning the bottom of the chat surface
          directly above the composer. Slim + statically visible; hidden until the
          first usage-bearing result (meter null). Works identically single-pane and
          in a split (this surface is shared by both). */}
      <ContextMeterBar meter={contextMeter} busy={busy} onCompact={compact} onHandoff={handoff} />
      <AgentComposer
        terminalId={terminalId}
        sessionId={sessionId}
        model={model}
        effort={effort}
        ultracode={ultracode}
        modelOptions={modelOptions}
        resolvedModel={resolvedModel}
        extraXhigh={extraXhigh}
        busy={busy}
        switching={switching}
        rawViewDisabled={!sessionId || busy || switching}
        onSwitchToRaw={switchToRaw}
        onSwitched={onSwitched}
      />
    </div>
  )
}
