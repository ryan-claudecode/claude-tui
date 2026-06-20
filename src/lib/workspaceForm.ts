/**
 * WS-D/H — pure helpers for the create-workspace modal + the useWorkspaces hook's
 * active-tracking reducer. React-free so both the validation and the
 * active-selection logic are unit-testable in vitest's node env (mirrors the
 * other `src/lib/*` view-model helpers).
 */

/** The minimal workspace shape the active-tracker needs. */
export interface ActiveTrackable {
  id: string
}

/**
 * Validate the create-workspace form. The name is the only required field (the
 * folder is optional — a workspace can start folderless and bind one later via
 * set_workspace_dir). Trims the name; returns the cleaned value + an error
 * message when invalid.
 */
export function validateWorkspaceName(
  name: string,
): { ok: true; name: string } | { ok: false; error: string } {
  const trimmed = name.trim()
  if (!trimmed) return { ok: false, error: "Name is required" }
  return { ok: true, name: trimmed }
}

/**
 * WS-H — the display label for a workspace's single folder: the PARENT FOLDER
 * NAME ONLY (the last path segment, e.g. `claude-tui-app` for
 * `C:\Users\me\projects\claude-tui-app`), so the full absolute path never blows
 * out the sidebar width. Tolerant of both separator styles and trailing slashes;
 * falls back to the whole string if it can't split. Empty/undefined → "".
 */
export function dirBasename(dir: string | null | undefined): string {
  if (!dir) return ""
  const parts = dir.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || dir
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
