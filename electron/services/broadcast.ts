import type { TerminalService } from "./terminals"

export interface BroadcastResult {
  /** Session ids that received the input. */
  sent: string[]
  /** Requested ids that did not match an open session. */
  skipped: string[]
  /** Whether a trailing Enter (\r) was appended to submit the input. */
  submitted: boolean
}

/**
 * BroadcastService — send the same input to many sessions at once
 * ("synchronize panes"). This is the multiplexer move for ClaudeTUI's core use
 * case: fan a single prompt or command out to several Claude sessions
 * simultaneously instead of typing it into each one.
 *
 * Thin by design: it only fans out to TerminalService.write() — no PTY or session
 * state lives here. Targeting all open sessions is the default; pass explicit ids
 * to scope the broadcast to a subset.
 */
export class BroadcastService {
  constructor(private sessions: TerminalService) {}

  /**
   * Write `content` to every targeted session. With no `sessionIds`, broadcasts
   * to all open sessions. When `submit` is true, appends a carriage return so the
   * input is sent (Enter) rather than just staged in the prompt.
   */
  broadcast(content: string, sessionIds?: string[], submit?: boolean): BroadcastResult {
    const open = this.sessions.list()
    const validIds = new Set(open.map((s) => s.id))
    const targets = sessionIds && sessionIds.length > 0 ? sessionIds : open.map((s) => s.id)

    const payload = submit ? content + "\r" : content
    const sent: string[] = []
    const skipped: string[] = []

    for (const id of targets) {
      if (validIds.has(id)) {
        this.sessions.write(id, payload)
        sent.push(id)
      } else {
        skipped.push(id)
      }
    }

    return { sent, skipped, submitted: !!submit }
  }
}
