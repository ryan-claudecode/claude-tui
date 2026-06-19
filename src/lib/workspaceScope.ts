/**
 * WS-D — pure view-model helpers that resolve the active-workspace SCOPING of the
 * three sidebar sections (NEEDS YOU / MISSIONS / SESSIONS). Kept React-free (no
 * hooks, no DOM) so the filter wiring is unit-testable in vitest's node env —
 * mirrors `workspaceFilter.ts` / `missionRow.ts` / `sessionRow.ts`.
 *
 * SESSIONS + MISSIONS carry `workspaceId` DIRECTLY (stamped at create() time,
 * WS-C), so they filter through {@link filterByWorkspace} as-is. The wrinkle this
 * module solves is ATTENTION entries, which carry NO `workspaceId` — only a
 * `sessionId` (terminal-owned) and/or a `missionId`. To scope them we must first
 * RESOLVE each entry's effective workspaceId from its owner:
 *   • a mission entry (missionId set) → its mission's workspaceId
 *   • otherwise (a terminal entry)    → its owning session's workspaceId
 * Unresolvable → undefined → treated as untagged ("All"-only), so it is hidden
 * under a specific workspace and shown in "All" — the same bucket policy as a
 * legacy untagged session/mission.
 */

import { filterByWorkspace } from "./workspaceFilter"

/** The minimal session shape this module needs (the renderer's WorkSession is a
 *  superset). */
export interface ScopedSession {
  id: string
  workspaceId?: string
}

/** The minimal mission shape this module needs (the renderer's MissionSummary is
 *  a superset). */
export interface ScopedMission {
  id: string
  workspaceId?: string
}

/** The minimal attention-entry shape this module needs (the renderer's
 *  AttentionEntry is a superset). */
export interface ScopedAttention {
  sessionId: string
  missionId?: string
}

/**
 * Resolve an attention entry's effective workspaceId from its owner. A mission
 * entry inherits its mission's workspaceId; any other entry inherits its owning
 * session's workspaceId. Returns undefined when the owner can't be found or is
 * itself untagged — i.e. the entry belongs to the "All" bucket only.
 */
export function attentionWorkspaceId(
  entry: ScopedAttention,
  sessions: readonly ScopedSession[],
  missions: readonly ScopedMission[],
): string | undefined {
  if (entry.missionId) {
    const m = missions.find((x) => x.id === entry.missionId)
    return m?.workspaceId
  }
  const s = sessions.find((x) => x.id === entry.sessionId)
  return s?.workspaceId
}

/**
 * Filter the attention queue to the active workspace. In "All" mode (activeId
 * null/undefined) every entry passes through (union, order preserved). Under a
 * specific workspace, an entry survives only when its RESOLVED owner workspaceId
 * equals the active id (untagged/unresolvable → hidden). Reuses
 * {@link filterByWorkspace} by projecting each entry to its resolved id, so the
 * "All"/specific bucket policy stays in exactly one place.
 */
export function filterAttentionByWorkspace<
  T extends ScopedAttention,
>(
  entries: readonly T[],
  activeWorkspaceId: string | null | undefined,
  sessions: readonly ScopedSession[],
  missions: readonly ScopedMission[],
): T[] {
  // "All" mode short-circuits to the union — no per-entry resolution needed.
  if (activeWorkspaceId == null) return entries.slice()
  return filterByWorkspace(
    entries.map((e) => ({
      entry: e,
      workspaceId: attentionWorkspaceId(e, sessions, missions),
    })),
    activeWorkspaceId,
  ).map((x) => x.entry)
}
