import { useCallback } from "react"
import TerminalPane from "./TerminalPane"
import AgentSurface from "./AgentSurface"
import type { TranscriptCache } from "./AgentView"

interface PaneTerminal {
  id: string
  lastState: string
  /** BO-4b — the transport this terminal was spawned with; drives the per-pane fork. */
  engine?: "xterm" | "structured"
  /** BO-6 — the terminal's current --model, surfaced to the pane's model picker. */
  model?: string
  /** CAPP-46 — the terminal's current --effort level, surfaced to the pane's effort picker. */
  effort?: string
  /** BO-12 — the terminal's Claude Code conversation id (for transcript rehydrate). */
  ccConversationId?: string
}

interface Props {
  leftId: string
  rightId: string
  activeId: string
  onSelectSession: (id: string) => void
  terminals?: PaneTerminal[]
  /** BO-6 — the work-session container, so a pane's model picker can respawn. */
  sessionId?: string | null
  /** BO-12 — the shared, cross-pane transcript cache (rehydrate on respawn). */
  transcriptCache?: TranscriptCache
  /** BO-6 — re-point the active selection at a respawned terminal after a model switch. */
  onSwitched?: (terminalId: string) => void
  /** CAPP-49 — per-terminal busy (generating OR permission-parked). Drives each
   *  structured pane's composer Stop button + disabled Send, exactly like the
   *  single-pane path. Without it busy defaulted to false in split panes, so a
   *  permission-blocked pane silently DROPPED typed input (the send cleared the
   *  textarea but the IPC guard rejected the write) and showed no Stop button. */
  isTerminalBusy?: (terminalId: string) => boolean
  themeMode?: string
  fontFamily?: string
  fontSize?: number
}

/**
 * BO-4b — a split pane forks on its terminal's ACTUAL engine, exactly like the
 * non-split path in App.tsx: a structured (headless) terminal renders the
 * AgentSurface (model picker + AgentView + AgentComposer); an xterm (or legacy/
 * undefined) terminal keeps TerminalPane. Before this, SplitView rendered
 * TerminalPane unconditionally, so a structured terminal in a split was a
 * permanently blank xterm with NO composer at all. Both panes stay visible (a
 * split shows both side by side), so the structured surface is always `active`.
 */
function PaneContent({
  id,
  terminals,
  active,
  sessionId,
  transcriptCache,
  onSwitched,
  busy,
  themeMode,
  fontFamily,
  fontSize,
}: {
  id: string
  terminals?: PaneTerminal[]
  active: boolean
  sessionId?: string | null
  transcriptCache?: TranscriptCache
  onSwitched?: (terminalId: string) => void
  busy?: boolean
  themeMode?: string
  fontFamily?: string
  fontSize?: number
}) {
  const term = terminals?.find((t) => t.id === id)
  if (term?.engine === "structured") {
    return (
      <AgentSurface
        terminalId={id}
        sessionId={sessionId ?? null}
        model={term.model}
        effort={term.effort}
        ccConversationId={term.ccConversationId}
        transcriptCache={transcriptCache}
        active
        busy={busy}
        onSwitched={onSwitched}
      />
    )
  }
  return (
    <TerminalPane
      sessionId={id}
      active={active}
      lastState={term?.lastState}
      themeMode={themeMode}
      fontFamily={fontFamily}
      fontSize={fontSize}
    />
  )
}

export default function SplitView({
  leftId,
  rightId,
  activeId,
  onSelectSession,
  terminals,
  sessionId,
  transcriptCache,
  onSwitched,
  isTerminalBusy,
  themeMode,
  fontFamily,
  fontSize,
}: Props) {
  const handleLeftClick = useCallback(() => onSelectSession(leftId), [onSelectSession, leftId])
  const handleRightClick = useCallback(() => onSelectSession(rightId), [onSelectSession, rightId])

  return (
    <div className="split-view">
      <div
        className={`split-pane ${activeId === leftId ? "focused" : ""}`}
        onMouseDown={handleLeftClick}
      >
        <PaneContent
          id={leftId}
          terminals={terminals}
          active={activeId === leftId}
          sessionId={sessionId}
          transcriptCache={transcriptCache}
          onSwitched={onSwitched}
          busy={isTerminalBusy?.(leftId) ?? false}
          themeMode={themeMode}
          fontFamily={fontFamily}
          fontSize={fontSize}
        />
      </div>
      <div className="split-divider" />
      <div
        className={`split-pane ${activeId === rightId ? "focused" : ""}`}
        onMouseDown={handleRightClick}
      >
        <PaneContent
          id={rightId}
          terminals={terminals}
          active={activeId === rightId}
          sessionId={sessionId}
          transcriptCache={transcriptCache}
          onSwitched={onSwitched}
          busy={isTerminalBusy?.(rightId) ?? false}
          themeMode={themeMode}
          fontFamily={fontFamily}
          fontSize={fontSize}
        />
      </div>
    </div>
  )
}
