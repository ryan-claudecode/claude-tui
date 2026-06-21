/**
 * Pure view-model for the transient "RESUMING (n)" sidebar section (CAPP-80).
 *
 * On launch the restore flow reopens EVERY app-managed dead terminal in parallel,
 * but only the first (foreground) session is made active — so the others run
 * invisibly. This section surfaces one row per startup-restored terminal so the user
 * gets a real, non-flashing window to notice + act.
 *
 * Clearing is USER-INITIATED: a row is dropped when the user focuses it, dismisses
 * it, stops it, or selects its owning session. When the tracked set empties the
 * section hides — self-closing. (There is intentionally no "online + seen" auto-clear;
 * a restored agent stays listed until the user acts on it, so it can't slip away
 * unnoticed.)
 *
 * IMPORTANT: this only ever describes APP-MANAGED terminals (refs inside persisted
 * work-sessions being reopened). It NEVER enumerates the standalone `claude.exe`
 * farm the user runs outside the app — the caller seeds from the sessions it is
 * itself reopening, so an external process can't leak in here.
 *
 * Kept separate from the hook/component so the derivation is unit-testable in
 * vitest's node environment (no React, no DOM) — mirrors `sessionRow.ts`.
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

/**
 * A restore-token captured BEFORE reopen, with the pre-reopen display name.
 *
 * The token (`${sessionId}::${originalId}`) is the STABLE row key. The live terminal
 * id is learned later (reopen mints a fresh id) and supplied via the `liveIds` map.
 * Carrying the name here means a still-resuming row never blanks/flashes even in the
 * brief window where the original ref has been re-keyed but the live id hasn't landed.
 */
export interface ResumingSeed {
  token: string
  sessionId: string
  originalId: string
  sessionName: string
  terminalName: string
}

/** One rendered RESUMING row: a restored terminal and how to address it. */
export interface ResumingRow {
  /** STABLE key — the originating session+terminal restore-token (not the live id,
   *  which changes on reopen). */
  key: string
  sessionId: string
  /** The id to focus/stop: the LIVE id once reopen has landed, else the original. */
  terminalId: string
  sessionName: string
  terminalName: string
  /** "resuming" while the PTY/proc is not yet attached; "ready" once online. */
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
 * Build one seed per app-managed dead terminal, in restore order, capturing the
 * pre-reopen name. The caller seeds the tracked set + live-id map from these.
 */
export function restoreSeeds(sessions: ResumingSession[]): ResumingSeed[] {
  const seeds: ResumingSeed[] = []
  for (const s of sessions) {
    for (const t of s.terminals) {
      if (t.lastState === "dead") {
        seeds.push({
          token: `${s.id}::${t.id}`,
          sessionId: s.id,
          originalId: t.id,
          sessionName: s.name,
          terminalName: t.name,
        })
      }
    }
  }
  return seeds
}

/**
 * Derive the rows the RESUMING section renders, resolving each row's live terminal
 * by STABLE id — never by array position.
 *
 * This id-resolution is the load-bearing correctness property: closing, handing off,
 * or reordering one terminal in a multi-terminal session must NOT re-target or drop
 * its siblings' rows (an earlier position-keyed version did exactly that, and could
 * point a row's Stop at the wrong background agent).
 *
 * @param sessions  the CURRENT (post-reopen) session list
 * @param tracked   restore-tokens still surfaced (cleared by user focus/dismiss/stop/select)
 * @param seeds     the immutable restore seeds (display order + captured names)
 * @param liveIds   token → live terminal id, populated as each reopen resolves
 *
 * Resolution per seed (in order, if still tracked):
 *  - session gone        → drop (killed mid-restore)
 *  - live id known:
 *      - terminal present → row (state from its lastState; usually "ready")
 *      - terminal absent  → drop (it came online then was closed/removed — no sibling impact)
 *  - live id unknown (reopen still pending, or it failed):
 *      - use the original ref if still present for the freshest name/state, else the
 *        captured name → a "resuming" row keyed to THIS seed only (never blanks,
 *        never mis-pairs onto a sibling)
 */
export function deriveResumingRows(
  sessions: ResumingSession[],
  tracked: ReadonlySet<string>,
  seeds: readonly ResumingSeed[],
  liveIds: ReadonlyMap<string, string>,
): ResumingRow[] {
  const byId = new Map<string, ResumingSession>()
  for (const s of sessions) byId.set(s.id, s)

  const rows: ResumingRow[] = []
  for (const seed of seeds) {
    if (!tracked.has(seed.token)) continue
    const session = byId.get(seed.sessionId)
    if (!session) continue

    const liveId = liveIds.get(seed.token)
    if (liveId != null) {
      // Reopen has landed: resolve by the live id. If it's gone, the terminal was
      // closed/removed after coming online — drop only THIS row.
      const term = session.terminals.find((t) => t.id === liveId)
      if (!term) continue
      rows.push({
        key: seed.token,
        sessionId: session.id,
        terminalId: liveId,
        sessionName: session.name,
        terminalName: term.name,
        state: term.lastState === "dead" ? "resuming" : "ready",
      })
    } else {
      // Reopen pending or failed: a stable "resuming" row for this seed alone. Prefer
      // the live ref (still present pre-reopen) for the freshest name/state; otherwise
      // fall back to the captured name so the row can't blank or flash out.
      const term = session.terminals.find((t) => t.id === seed.originalId)
      rows.push({
        key: seed.token,
        sessionId: session.id,
        terminalId: term?.id ?? seed.originalId,
        sessionName: session.name,
        terminalName: term?.name ?? seed.terminalName,
        state: term && term.lastState !== "dead" ? "ready" : "resuming",
      })
    }
  }
  return rows
}
