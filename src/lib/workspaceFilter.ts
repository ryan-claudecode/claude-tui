/**
 * WS-C — the pure workspace data-scoping helper. Kept separate from any
 * hook/component so it can be unit-tested in vitest's node environment (no React,
 * no DOM) — mirrors `missionRow.ts` / `attentionRow.ts` / `sessionRow.ts`.
 *
 * The renderer consumes this in WS-D to scope the sidebar's NEEDS YOU / MISSIONS /
 * SESSIONS sections to the active workspace. It is NOT wired into the sidebar
 * here (WS-C is backend data-scoping + this filter only).
 *
 * "All" bucket semantics (the design's escape hatch):
 *  - active workspace is null/undefined ("All" mode) → show EVERYTHING (both
 *    tagged and untagged/legacy items). "All" is the union, never a filter.
 *  - a SPECIFIC workspace is active → show ONLY items whose `workspaceId` equals
 *    that id. Untagged/legacy items (no `workspaceId`) belong to "All" ONLY, so
 *    they are HIDDEN under a specific workspace (never leak into a scoped view).
 */

/** The minimal shape the filter needs — works for both WorkSessions and Missions
 *  (and anything else carrying an optional `workspaceId`). */
export interface WorkspaceScoped {
  workspaceId?: string
}

/**
 * Filter a list of workspace-scoped items by the active workspace id.
 *
 * @param items the items to filter (each `{ workspaceId? }`-shaped).
 * @param activeWorkspaceId the active workspace id, or null/undefined for "All".
 * @returns the items visible under the active selection (a new array; input
 *          order preserved; never mutated).
 */
export function filterByWorkspace<T extends WorkspaceScoped>(
  items: readonly T[],
  activeWorkspaceId: string | null | undefined,
): T[] {
  // "All" mode (no specific workspace active) → the union: everything is visible.
  if (activeWorkspaceId == null) return items.slice()
  // A specific workspace is active → only items stamped with exactly that id.
  // Untagged/legacy items (undefined workspaceId) fall to "All" only → hidden.
  return items.filter((item) => item.workspaceId === activeWorkspaceId)
}
