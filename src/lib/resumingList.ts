/**
 * Pure view-model for the transient "RESUMING (n)" sidebar section (CAPP-80).
 *
 * On launch the restore flow reopens EVERY app-managed dead terminal in parallel,
 * but only the first session is made active — so the others run invisibly. This
 * section surfaces one row per startup-restored terminal so the user gets a real,
 * non-flashing window to notice + act, then self-closes as rows are focused,
 * dismissed, or come online and are seen.
 *
 * IMPORTANT: this only ever describes APP-MANAGED terminals (refs inside persisted
 * work-sessions being reopened). It NEVER enumerates the standalone `claude.exe`
 * farm the user runs outside the app — the caller seeds `restoring` from the
 * sessions it is itself reopening, so an external process can't leak in here.
 *
 * Kept separate from the hook/component so the derivation (counting, pluralization,
 * the self-closing filter) is unit-testable in vitest's node environment (no React,
 * no DOM) — mirrors `sessionRow.ts` / `attentionRow.ts`.
 */

/** A terminal as seen by the sidebar (the same minimal shape used elsewhere). */
export interface ResumingTerminal {
  id: string
  name: string
  lastState: string
}

export interface ResumingSession {
  id: string
  name: string
  terminals: ResumingTerminal[]
}

/** One rendered RESUMING row: a restored terminal and how to address it. */
export interface ResumingRow {
  /** STABLE key for the row — the originating session+terminal pair the user is
   *  restoring. The live terminal id changes on reopen (a fresh PTY/proc id), so
   *  rows are keyed by the durable restore-token, not the live id. */
  key: string
  sessionId: string
  /** The CURRENT (live) terminal id to focus/stop — re-resolved each derive from
   *  the session's terminal at this row's position, since reopen mints a new id. */
  terminalId: string
  sessionName: string
  terminalName: string
  /** "resuming" while the terminal is still dead (PTY/proc not yet attached);
   *  "ready" once it has come online (active/idle). */
  state: "resuming" | "ready"
}

/**
 * Count the app-managed terminals being restored at startup: every dead terminal
 * ref across the loaded sessions. This is the N for the launch notice ("Resuming N
 * background agent(s)"). N === 0 → no notice.
 */
export function countResuming(sessions: ResumingSession[]): number {
  let n = 0
  for (const s of sessions) for (const t of s.terminals) if (t.lastState === "dead") n++
  return n
}

/**
 * Pluralize the launch-notice message for `n` restored terminals. Returns null for
 * n === 0 (no toast) so the caller can early-out cleanly.
 */
export function resumingNotice(n: number): string | null {
  if (n <= 0) return null
  return `Resuming ${n} background agent${n === 1 ? "" : "s"}`
}

/**
 * The set of restore-tokens this section should track. Each token keys a terminal
 * the launch flow is reopening, in the form `${sessionId}::${terminalId}` — the id
 * captured BEFORE reopen (which mints a new live id). The caller builds this once
 * at startup from the sessions it is restoring.
 */
export function restoreTokens(sessions: ResumingSession[]): string[] {
  const tokens: string[] = []
  for (const s of sessions) {
    for (const t of s.terminals) {
      if (t.lastState === "dead") tokens.push(`${s.id}::${t.id}`)
    }
  }
  return tokens
}

/**
 * Derive the rows the RESUMING section renders.
 *
 * @param sessions   the CURRENT session list (post-reopen ids land here)
 * @param tracked    restore-tokens still being surfaced — a token is dropped by
 *                   the caller once the user focuses or dismisses it, or once it
 *                   has come online AND been seen
 * @param order      the original tracked tokens in restore order, so rows keep a
 *                   stable order even as the live ids churn (sessions[i] order may
 *                   shift). Each token is `${sessionId}::${originalTerminalId}`;
 *                   we resolve the live terminal by POSITION within the session.
 *
 * Self-closing: a token absent from `tracked` is filtered out, so the list shrinks
 * to empty (the section then hides). A row whose session/terminal can no longer be
 * resolved (killed mid-restore) is also dropped.
 */
export function deriveResumingRows(
  sessions: ResumingSession[],
  tracked: ReadonlySet<string>,
  order: readonly string[],
): ResumingRow[] {
  // Map each session id → its terminals so we can resolve a token to a live row.
  const byId = new Map<string, ResumingSession>()
  for (const s of sessions) byId.set(s.id, s)

  // For each session, remember which restore-tokens belong to it (in order) so we
  // can pair the i-th tracked token with the i-th terminal after reopen re-keys.
  const tokensPerSession = new Map<string, string[]>()
  for (const token of order) {
    const sep = token.indexOf("::")
    if (sep === -1) continue
    const sid = token.slice(0, sep)
    const arr = tokensPerSession.get(sid) ?? []
    arr.push(token)
    tokensPerSession.set(sid, arr)
  }

  const rows: ResumingRow[] = []
  for (const token of order) {
    if (!tracked.has(token)) continue
    const sep = token.indexOf("::")
    if (sep === -1) continue
    const sid = token.slice(0, sep)
    const session = byId.get(sid)
    if (!session) continue
    // Resolve the live terminal by this token's position among its session's
    // restore-tokens (reopen preserves terminal count/order within a session).
    const sessionTokens = tokensPerSession.get(sid) ?? []
    const pos = sessionTokens.indexOf(token)
    const terminal = pos >= 0 ? session.terminals[pos] : undefined
    if (!terminal) continue
    rows.push({
      key: token,
      sessionId: session.id,
      terminalId: terminal.id,
      sessionName: session.name,
      terminalName: terminal.name,
      state: terminal.lastState === "dead" ? "resuming" : "ready",
    })
  }
  return rows
}
