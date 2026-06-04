interface FileChange {
  path: string
  /** Two-char porcelain status code, e.g. " M", "A ", "??" */
  status?: string
  staged?: boolean
  /** Human-readable label, e.g. "modified", "added", "untracked" */
  label?: string
}

interface Commit {
  hash: string
  author?: string
  date?: string
  subject: string
}

interface Props {
  branch?: string
  ahead?: number
  behind?: number
  clean?: boolean
  changes?: FileChange[]
  /** Optional recent commits, e.g. from git_log */
  commits?: Commit[]
}

/** Map a change's label to a single-letter marker + CSS modifier. */
const MARKER: Record<string, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "?",
  conflict: "U",
  changed: "•",
}

function markerFor(c: FileChange): { ch: string; kind: string } {
  const label = c.label ?? "changed"
  return { ch: MARKER[label] ?? "•", kind: label }
}

function FileRow({ c }: { c: FileChange }) {
  const { ch, kind } = markerFor(c)
  return (
    <li className="git-file">
      <span className={`git-marker git-marker-${kind}`}>{ch}</span>
      <span className="git-path">{c.path}</span>
      <span className="git-file-label">{c.label}</span>
    </li>
  )
}

export default function GitPanel({
  branch,
  ahead = 0,
  behind = 0,
  clean,
  changes = [],
  commits = [],
}: Props) {
  const staged = changes.filter((c) => c.staged)
  const unstaged = changes.filter((c) => !c.staged)
  const isClean = clean ?? changes.length === 0

  return (
    <div className="git-panel">
      <div className="git-head">
        <span className="git-branch-icon">⎇</span>
        <span className="git-branch">{branch ?? "HEAD"}</span>
        {(ahead > 0 || behind > 0) && (
          <span className="git-tracking">
            {ahead > 0 && <span className="git-ahead">↑{ahead}</span>}
            {behind > 0 && <span className="git-behind">↓{behind}</span>}
          </span>
        )}
        <span className={`git-state ${isClean ? "git-state-clean" : "git-state-dirty"}`}>
          {isClean ? "clean" : `${changes.length} change${changes.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {staged.length > 0 && (
        <section className="git-section">
          <h3 className="git-section-title git-section-staged">
            Staged <span className="git-section-count">{staged.length}</span>
          </h3>
          <ul className="git-files">
            {staged.map((c, i) => (
              <FileRow key={`s${i}`} c={c} />
            ))}
          </ul>
        </section>
      )}

      {unstaged.length > 0 && (
        <section className="git-section">
          <h3 className="git-section-title git-section-unstaged">
            Unstaged <span className="git-section-count">{unstaged.length}</span>
          </h3>
          <ul className="git-files">
            {unstaged.map((c, i) => (
              <FileRow key={`u${i}`} c={c} />
            ))}
          </ul>
        </section>
      )}

      {isClean && (
        <div className="git-clean-note">Working tree clean — nothing to commit.</div>
      )}

      {commits.length > 0 && (
        <section className="git-section">
          <h3 className="git-section-title">Recent commits</h3>
          <ul className="git-commits">
            {commits.map((c, i) => (
              <li key={c.hash ?? i} className="git-commit">
                <code className="git-commit-hash">{(c.hash ?? "").slice(0, 7)}</code>
                <span className="git-commit-subject">{c.subject}</span>
                {(c.author || c.date) && (
                  <span className="git-commit-meta">
                    {c.author}
                    {c.author && c.date ? " · " : ""}
                    {c.date}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
