export interface RowTerminal {
  lastState: string
  activity?: string
  /** BACKGROUND WORK — outstanding background tasks for this terminal (from the snapshot). */
  backgroundCount?: number
}

export interface RowSession {
  status: string
  terminals: RowTerminal[]
}

export interface SessionRowView {
  dot: "dead" | "active" | "idle"
  count: number
  activity: string
  /** BACKGROUND WORK — total outstanding background tasks across the session's terminals;
   *  drives the `⚙ N` badge. 0 ⇒ no badge. */
  background: number
}

/**
 * Pure view-model for one sidebar session row. The row is fixed-height and never
 * expands, so all triage info (dot color, terminal count, one activity line, background
 * badge) is derived here from the busiest terminal.
 *
 * BACKGROUND WORK — the dot stays "active" (green) while ANY background task is
 * outstanding, even after the foreground turn ended: detached work is still running, so
 * the session must not read as idle. (The backend already holds the terminal "active"
 * for this, but deriving it here too makes the requirement robust to snapshot timing.)
 */
export function deriveSessionRow(s: RowSession): SessionRowView {
  const working = s.terminals.filter((t) => t.lastState === "active").length
  const background = s.terminals.reduce((n, t) => n + (t.backgroundCount ?? 0), 0)
  const dot = s.status === "stopped" ? "dead" : working > 0 || background > 0 ? "active" : "idle"
  const count = s.terminals.length
  const [busy] = [...s.terminals].sort(
    (a, b) => (b.lastState === "active" ? 1 : 0) - (a.lastState === "active" ? 1 : 0),
  )
  const activity =
    s.status === "stopped" ? "Stopped"
    : count === 0 ? "Empty"
    : busy?.lastState === "active" ? (busy.activity ?? "Working")
    : background > 0 ? "Working in background"
    : "Idle"
  return { dot, count, activity, background }
}
