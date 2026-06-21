/**
 * Pure view-model helper for the shared inline-rename UX (terminal tabs + session
 * rows). Kept separate from the editors so the commit decision is unit-testable in
 * vitest's node environment (no React, no DOM) — mirrors `sessionRow.ts` /
 * `attentionRow.ts`. Both editors call this on Enter/blur so the trim + empty-revert
 * policy lives in ONE place and can't drift between the two.
 */

export interface RenameCommit {
  /** The name to apply: the trimmed input, or `previous` unchanged when blank. */
  name: string
  /** Whether the name actually changed (a no-op commit when false). */
  changed: boolean
}

/**
 * Resolve what a rename should commit to, given the raw editor input and the
 * current (previous) name. Trims surrounding whitespace; an empty/whitespace-only
 * input reverts to `previous` (NEVER blanks the name). `changed` is true only when
 * the trimmed value differs from `previous`, so a caller can skip a no-op IPC call.
 */
export function commitRenameValue(raw: string, previous: string): RenameCommit {
  const trimmed = raw.trim()
  if (!trimmed) return { name: previous, changed: false }
  return { name: trimmed, changed: trimmed !== previous }
}
