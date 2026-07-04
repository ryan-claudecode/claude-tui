import type { TerminalService } from "../../services/terminals"

/**
 * The work-session + terminal a given MCP connection is bound to. Carried on the
 * `/sse?sid=<session>&tid=<terminal>` URL each spawned terminal connects with, so
 * the work-session tools can default their ids to the caller's own terminal — no
 * need for Claude to discover or pass them.
 */
export interface TerminalIdentity {
  sessionId?: string
  terminalId?: string
}

/**
 * Resolve a working directory for git/file ops: prefer the named session's
 * cwd, fall back to the first open session, then the app's own cwd. Used by the
 * git tool module and panels (diff_files).
 */
export function resolveCwd(sessions: TerminalService, sessionId?: string): string {
  const list = sessions.list()
  if (sessionId) {
    const match = list.find((s) => s.id === sessionId)
    if (match) return match.cwd
  }
  return list[0]?.cwd ?? process.cwd()
}
