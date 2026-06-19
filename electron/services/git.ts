import { execFileSync } from "child_process"

export interface GitFileChange {
  path: string
  /** Two-char porcelain status code, e.g. " M", "A ", "??", "R " */
  status: string
  staged: boolean
  /** Human-readable label derived from the status code */
  label: string
}

export interface GitStatus {
  branch: string
  ahead: number
  behind: number
  clean: boolean
  changes: GitFileChange[]
}

export interface GitCommit {
  hash: string
  author: string
  date: string
  subject: string
}

export interface GitCommitDetail {
  hash: string
  author: string
  email: string
  date: string
  subject: string
  body: string
  /** Changed-files summary from `git show --stat`. */
  stat: string
  /** Full patch for the commit. */
  diff: string
}

export interface GitBranch {
  /** Short branch name (e.g. "main" or "origin/feature-x"). */
  name: string
  /** True for the currently checked-out branch. */
  current: boolean
  /** True for remote-tracking branches (refs/remotes/*). */
  remote: boolean
}

export interface GitBlameLine {
  /** 1-based line number in the final file. */
  line: number
  /** Abbreviated commit hash that last touched this line. */
  hash: string
  author: string
  /** Author date (YYYY-MM-DD). */
  date: string
  /** Subject of the commit that last touched this line. */
  summary: string
  /** The source line's content. */
  content: string
}

/**
 * GitService — structured, read-only git queries scoped to a working dir.
 *
 * Gives Claude machine-readable repo state (branch, ahead/behind, staged vs.
 * unstaged changes, recent log, diffs, commit detail, blame, branches) instead
 * of forcing it to parse raw terminal output. Read-only by design: write-side
 * git (stage/commit/push/branch/stash) is deliberately not exposed — that
 * plumbing belongs to the agent's own shell (see docs/roadmap/00-identity.md).
 */
export class GitService {
  private run(cwd: string, args: string[]): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    }).trimEnd()
  }

  private labelFor(code: string): string {
    const c = code.trim()
    if (code === "??") return "untracked"
    if (c.includes("D")) return "deleted"
    if (c.includes("A")) return "added"
    if (c.includes("R")) return "renamed"
    if (c.includes("M")) return "modified"
    if (c.includes("U") || c === "DD" || c === "AA") return "conflict"
    return "changed"
  }

  status(cwd: string): GitStatus {
    // Branch + ahead/behind via the porcelain v1 header line.
    const raw = this.run(cwd, ["status", "--porcelain=v1", "--branch"])
    const lines = raw.split("\n")
    let branch = "HEAD"
    let ahead = 0
    let behind = 0
    const changes: GitFileChange[] = []

    for (const line of lines) {
      if (line.startsWith("## ")) {
        const header = line.slice(3)
        branch = header.split(/\.\.\.| /)[0] || "HEAD"
        const aheadMatch = header.match(/ahead (\d+)/)
        const behindMatch = header.match(/behind (\d+)/)
        if (aheadMatch) ahead = parseInt(aheadMatch[1], 10)
        if (behindMatch) behind = parseInt(behindMatch[1], 10)
        continue
      }
      if (!line.trim()) continue
      const code = line.slice(0, 2)
      const path = line.slice(3)
      changes.push({
        path,
        status: code,
        staged: code[0] !== " " && code[0] !== "?",
        label: this.labelFor(code),
      })
    }

    return { branch, ahead, behind, clean: changes.length === 0, changes }
  }

  log(cwd: string, limit = 15): GitCommit[] {
    const sep = "\x1f"
    const fmt = ["%h", "%an", "%ad", "%s"].join(sep)
    const raw = this.run(cwd, [
      "log",
      `-n${limit}`,
      "--date=short",
      `--pretty=format:${fmt}`,
    ])
    if (!raw) return []
    return raw.split("\n").map((line) => {
      const [hash, author, date, subject] = line.split(sep)
      return { hash, author, date, subject }
    })
  }

  diff(cwd: string, file?: string, staged = false): string {
    const args = ["diff"]
    if (staged) args.push("--staged")
    if (file) args.push("--", file)
    return this.run(cwd, args)
  }

  /**
   * List local and remote-tracking branches with a flag for the current one.
   * Answers "what branches exist / which am I on?" without parsing
   * `git branch -a`.
   */
  branches(cwd: string): GitBranch[] {
    const sep = "\x1f"
    const raw = this.run(cwd, [
      "for-each-ref",
      `--format=%(refname)${sep}%(HEAD)`,
      "refs/heads",
      "refs/remotes",
    ])
    if (!raw) return []
    const out: GitBranch[] = []
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      const [refname, head] = line.split(sep)
      const remote = refname.startsWith("refs/remotes/")
      // Skip the symbolic "origin/HEAD -> origin/main" pointer.
      if (remote && refname.endsWith("/HEAD")) continue
      const name = refname.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "")
      out.push({ name, current: head.trim() === "*", remote })
    }
    return out
  }

  /**
   * Show a single commit: full metadata, the changed-files summary (`--stat`),
   * and the patch. `git_log` lists commits; this drills into one of them (or any
   * ref) so Claude can review exactly what changed without parsing terminal
   * output. Defaults to HEAD.
   */
  show(cwd: string, ref = "HEAD"): GitCommitDetail {
    const sep = "\x1f"
    const fmt = ["%H", "%an", "%ae", "%ad", "%s", "%b"].join(sep)
    const meta = this.run(cwd, ["show", "-s", "--date=short", `--pretty=format:${fmt}`, ref])
    const [hash, author, email, date, subject, body] = meta.split(sep)
    const stat = this.run(cwd, ["show", "--stat", "--format=", ref]).trim()
    const diff = this.run(cwd, ["show", "--format=", ref]).trim()
    return {
      hash,
      author,
      email,
      date,
      subject,
      body: (body ?? "").trim(),
      stat,
      diff,
    }
  }

  /**
   * Line-by-line authorship for a file via `git blame --line-porcelain`.
   * Tells Claude *who* last changed each line and in *which* commit — the "why
   * is this line here" question — without parsing raw blame output. Optionally
   * scope to a 1-based inclusive `startLine`/`endLine` range (`-L`).
   */
  blame(cwd: string, file: string, startLine?: number, endLine?: number): GitBlameLine[] {
    const args = ["blame", "--line-porcelain", "--date=short"]
    if (startLine && endLine) args.push("-L", `${startLine},${endLine}`)
    args.push("--", file)
    const raw = this.run(cwd, args)
    if (!raw) return []

    const lines = raw.split("\n")
    const out: GitBlameLine[] = []
    // commit-hash metadata is repeated per line in --line-porcelain, but we
    // still cache it so a line that reuses a prior commit resolves its fields.
    const meta = new Map<string, { author: string; date: string; summary: string }>()
    let i = 0
    while (i < lines.length) {
      const header = lines[i]
      const m = header.match(/^([0-9a-f]{7,40})\s+\d+\s+(\d+)/)
      if (!m) {
        i++
        continue
      }
      const hash = m[1]
      const finalLine = parseInt(m[2], 10)
      let author = meta.get(hash)?.author ?? ""
      let date = meta.get(hash)?.date ?? ""
      let summary = meta.get(hash)?.summary ?? ""
      let content = ""
      i++
      while (i < lines.length && !lines[i].startsWith("\t")) {
        const field = lines[i]
        if (field.startsWith("author ")) author = field.slice(7)
        else if (field.startsWith("author-time ")) {
          date = new Date(parseInt(field.slice(12), 10) * 1000).toISOString().slice(0, 10)
        } else if (field.startsWith("summary ")) summary = field.slice(8)
        i++
      }
      if (i < lines.length && lines[i].startsWith("\t")) {
        content = lines[i].slice(1)
        i++
      }
      meta.set(hash, { author, date, summary })
      out.push({ line: finalLine, hash: hash.slice(0, 8), author, date, summary, content })
    }
    return out
  }
}
