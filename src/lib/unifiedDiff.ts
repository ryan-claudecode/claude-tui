/**
 * Pure parser that turns a `git diff` unified-diff string into the
 * `{ path, oldContent, newContent }[]` shape DiffPanel consumes.
 *
 * WW-2b captures a worker's review diff as a single unified-diff STRING
 * (`git diff <base>...HEAD`), but DiffPanel renders by recomputing a line diff
 * from old/new file CONTENT (it owns the `diff` package internally). Rather than
 * fork DiffPanel to accept raw unified text, we reconstruct per-file old/new
 * content from the hunks here — so the captured diff flows into the existing,
 * hunk-selectable review panel unchanged.
 *
 * Reconstruction is faithful for the lines the diff touches plus their context;
 * unchanged regions OUTSIDE any hunk aren't present in the diff and so don't
 * appear in either reconstructed side (DiffPanel will just show the hunks as
 * context/add/del, which is exactly what a reviewer wants to see). Binary files
 * and pure rename/mode changes (no hunks) surface as a single context line.
 *
 * Kept dependency-free and DOM-free so it unit-tests in vitest's node env.
 */

export interface ParsedFileDiff {
  path: string
  oldContent: string
  newContent: string
}

/** Strip a `a/` or `b/` git prefix from a diff header path. */
function stripPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2)
  return p
}

/** Pull the file path out of a `diff --git a/x b/x` header. */
function pathFromGitHeader(line: string): string | undefined {
  // `diff --git a/foo/bar.ts b/foo/bar.ts`
  const m = line.match(/^diff --git (\S+) (\S+)$/)
  if (!m) return undefined
  // Prefer the b/ (new) path; fall back to a/ for deletions.
  return stripPrefix(m[2]) || stripPrefix(m[1])
}

/**
 * Parse a unified diff into per-file reconstructed old/new content. Returns one
 * entry per file section. An empty/whitespace-only diff yields `[]`.
 */
export function parseUnifiedDiff(diff: string): ParsedFileDiff[] {
  if (!diff || !diff.trim()) return []
  const lines = diff.split("\n")
  const files: ParsedFileDiff[] = []
  let current: ParsedFileDiff | null = null
  // Whether we're inside a hunk body (after an `@@` header). Outside a hunk the
  // header/metadata lines (index, ---, +++, mode, etc.) are skipped.
  let inHunk = false

  const flush = () => {
    if (current) files.push(current)
  }

  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      flush()
      current = { path: pathFromGitHeader(raw) ?? "file", oldContent: "", newContent: "" }
      inHunk = false
      continue
    }
    // A `--- a/x` / `+++ b/x` pair appears for diffs that lack a `diff --git`
    // header (e.g. a plain `diff -u`). Use +++ to (re)name the current file.
    if (raw.startsWith("--- ")) {
      if (!current) current = { path: "file", oldContent: "", newContent: "" }
      inHunk = false
      continue
    }
    if (raw.startsWith("+++ ")) {
      if (!current) current = { path: "file", oldContent: "", newContent: "" }
      const p = raw.slice(4).trim().split("\t")[0]
      if (p && p !== "/dev/null") current.path = stripPrefix(p)
      inHunk = false
      continue
    }
    if (raw.startsWith("@@")) {
      inHunk = true
      continue
    }
    if (!current) continue
    if (!inHunk) {
      // Metadata between the git header and the first hunk (index/mode/binary).
      // Surface a binary-file note so the panel isn't blank for binaries.
      if (raw.startsWith("Binary files")) {
        current.oldContent += raw + "\n"
        current.newContent += raw + "\n"
      }
      continue
    }
    // Inside a hunk: classify each line by its first char.
    const tag = raw[0]
    const body = raw.slice(1)
    if (tag === "+") {
      current.newContent += body + "\n"
    } else if (tag === "-") {
      current.oldContent += body + "\n"
    } else if (tag === "\\") {
      // "\ No newline at end of file" — annotation, ignore.
    } else {
      // Context line (leading space) or a blank line within the hunk.
      current.oldContent += body + "\n"
      current.newContent += body + "\n"
    }
  }
  flush()
  return files
}
