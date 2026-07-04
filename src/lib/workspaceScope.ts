/**
 * WS-D — pure view-model helpers that resolve the active-workspace SCOPING of the
 * sidebar sections (NEEDS YOU / SESSIONS). Kept React-free (no hooks, no DOM) so
 * the filter wiring is unit-testable in vitest's node env — mirrors
 * `workspaceFilter.ts` / `sessionRow.ts`.
 *
 * SESSIONS carry `workspaceId` DIRECTLY (stamped at create() time, WS-C), so they
 * filter through {@link filterByWorkspace} as-is. The wrinkle this module solves
 * is ATTENTION entries, which carry NO `workspaceId` — only a `sessionId`
 * (terminal-owned). To scope them we RESOLVE each entry's effective workspaceId
 * from its owning session. Unresolvable → undefined → treated as untagged
 * ("All"-only), so it is hidden under a specific workspace and shown in "All" —
 * the same bucket policy as a legacy untagged session.
 */

/** The minimal session shape this module needs (the renderer's WorkSession is a
 *  superset). */
export interface ScopedSession {
  id: string
  workspaceId?: string
}

/** The minimal attention-entry shape this module needs (the renderer's
 *  AttentionEntry is a superset). `tier` is read so tier-1 (blocking) entries
 *  can be EXEMPTED from the workspace hide — see {@link filterAttentionByWorkspace}. */
export interface ScopedAttention {
  sessionId: string
  tier: 1 | 2 | 3
}

/**
 * Resolve an attention entry's effective workspaceId from its owning session.
 * Returns undefined when the owner can't be found or is itself untagged — i.e.
 * the entry belongs to the "All" bucket only.
 */
export function attentionWorkspaceId(
  entry: ScopedAttention,
  sessions: readonly ScopedSession[],
): string | undefined {
  const s = sessions.find((x) => x.id === entry.sessionId)
  return s?.workspaceId
}

/**
 * Filter the attention queue to the active workspace. In "All" mode (activeId
 * null/undefined) every entry passes through (union, order preserved). Under a
 * specific workspace, a tier-2/3 entry survives only when its RESOLVED owner
 * workspaceId equals the active id (untagged/unresolvable → hidden) — the same
 * "All"/specific bucket policy as {@link filterByWorkspace} applies to tagged
 * items.
 *
 * TIER-1 EXEMPTION (the review's MAJOR 2 fix): a tier-1 entry is a HARD BLOCKER
 * the user must act on — a `show_form` checkpoint. Hiding it under a workspace
 * filter would strand the user on something they MUST act on with no way to reach
 * it. So tier-1 entries are ALWAYS included regardless of the active workspace;
 * only tier-2 / tier-3 entries filter by workspace. Input order is preserved (the
 * exempted tier-1 entries keep their original positions).
 */
export function filterAttentionByWorkspace<
  T extends ScopedAttention,
>(
  entries: readonly T[],
  activeWorkspaceId: string | null | undefined,
  sessions: readonly ScopedSession[],
): T[] {
  // "All" mode short-circuits to the union — no per-entry resolution needed.
  if (activeWorkspaceId == null) return entries.slice()
  // Filter only tier-2/3 by workspace; tier-1 blockers are never hidden. We
  // partition-preserving-order: walk the original list, keep every tier-1, and
  // keep a tier-2/3 only when its resolved owner matches the active workspace.
  return entries.filter((e) => {
    if (e.tier === 1) return true
    return attentionWorkspaceId(e, sessions) === activeWorkspaceId
  })
}
