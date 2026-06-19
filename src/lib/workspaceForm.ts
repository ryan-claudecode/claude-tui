/**
 * WS-D — pure helpers for the create-workspace modal + the useWorkspaces hook's
 * active-tracking reducer. React-free so both the validation and the
 * active-selection logic are unit-testable in vitest's node env (mirrors the
 * other `src/lib/*` view-model helpers).
 */

/** The minimal workspace shape the active-tracker needs. */
export interface ActiveTrackable {
  id: string
}

/**
 * Validate the create-workspace form. The name is the only required field (dirs
 * are optional — a workspace can start empty and gain dirs later via addDir).
 * Trims the name; returns the cleaned value + an error message when invalid.
 */
export function validateWorkspaceName(
  name: string,
): { ok: true; name: string } | { ok: false; error: string } {
  const trimmed = name.trim()
  if (!trimmed) return { ok: false, error: "Name is required" }
  return { ok: true, name: trimmed }
}

/**
 * Add a directory to the create-form's dir list, de-duped (an OS folder dialog
 * can return a path already chosen). Returns the SAME array reference when the
 * dir is already present, so a redundant pick is a no-op (no needless re-render).
 * Blank/whitespace paths are ignored.
 */
export function addFormDir(dirs: readonly string[], dir: string): string[] {
  const d = dir.trim()
  if (!d || dirs.includes(d)) return dirs as string[]
  return [...dirs, d]
}

/** Add MANY directories (the multi-select dialog result), de-duped in order. */
export function addFormDirs(dirs: readonly string[], incoming: readonly string[]): string[] {
  let next = dirs as string[]
  for (const d of incoming) next = addFormDir(next, d)
  return next
}

/** Remove a directory chip from the create-form's dir list. */
export function removeFormDir(dirs: readonly string[], dir: string): string[] {
  return dirs.filter((d) => d !== dir)
}

/**
 * The active-workspace tracking reducer for useWorkspaces: given the current
 * active id and an active-changed event payload (the new active workspace's
 * public projection, or null when cleared/deleted-active), derive the next
 * active id. A thin mapping today, but isolated + tested so the hook's reactive
 * tracking can't silently regress (e.g. forgetting the null→All clear).
 */
export function nextActiveId(payload: ActiveTrackable | null): string | null {
  return payload ? payload.id : null
}

/**
 * Resolve the workspace whose dot/name the switcher pill should show: the active
 * workspace (by id) within the list, or null for "All" mode. Returns null when
 * the active id no longer resolves to a known workspace (a deleted active that
 * hasn't round-tripped yet) — the pill then reads "All workspaces" rather than a
 * dangling label.
 */
export function activeWorkspace<T extends ActiveTrackable>(
  workspaces: readonly T[],
  activeId: string | null,
): T | null {
  if (activeId == null) return null
  return workspaces.find((w) => w.id === activeId) ?? null
}
