export interface RowTerminal {
  lastState: string
  activity?: string
}

export interface RowSession {
  status: string
  terminals: RowTerminal[]
}

export interface SessionRowView {
  dot: "dead" | "active" | "idle"
  count: number
  activity: string
}

/**
 * Pure view-model for one sidebar session row. The row is fixed-height and never
 * expands, so all triage info (dot color, terminal count, one activity line) is
 * derived here from the busiest terminal.
 */
export function deriveSessionRow(s: RowSession): SessionRowView {
  const working = s.terminals.filter((t) => t.lastState === "active").length
  const dot = s.status === "stopped" ? "dead" : working > 0 ? "active" : "idle"
  const count = s.terminals.length
  const [busy] = [...s.terminals].sort(
    (a, b) => (b.lastState === "active" ? 1 : 0) - (a.lastState === "active" ? 1 : 0),
  )
  const activity =
    s.status === "stopped" ? "Stopped"
    : count === 0 ? "Empty"
    : busy?.lastState === "active" ? (busy.activity ?? "Working")
    : "Idle"
  return { dot, count, activity }
}
