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

export interface GitTag {
  /** Tag name (e.g. "v1.2.0"). */
  name: string
  /** Commit the tag points at (abbreviated hash). */
  hash: string
  /** Tagger/commit date (YYYY-MM-DD). */
  date: string
  /** Annotation message (annotated tags) or commit subject (lightweight tags). */
  subject: string
}

export interface GitRemote {
  /** Remote name (e.g. "origin"). */
  name: string
  /** Fetch URL. */
  fetchUrl: string
  /** Push URL (often identical to fetchUrl). */
  pushUrl: string
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
 * GitService — structured git queries and operations scoped to a working dir.
 *
 * Gives Claude machine-readable repo state (branch, ahead/behind, staged vs.
 * unstaged changes, recent log, diffs) instead of forcing it to parse raw
 * terminal output. Also exposes the common write operations (stage, unstage,
 * commit, branch, checkout) so Claude can drive a review-and-commit flow from
 * panels/tools instead of typing into the terminal. Mutating ops return the
 * refreshed GitStatus so the caller sees the result immediately.
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

  /** Stage specific files, or everything (`git add -A`) when none are given. */
  stage(cwd: string, files?: string[]): GitStatus {
    if (files && files.length) this.run(cwd, ["add", "--", ...files])
    else this.run(cwd, ["add", "-A"])
    return this.status(cwd)
  }

  /** Unstage specific files, or everything, leaving working-tree changes intact. */
  unstage(cwd: string, files?: string[]): GitStatus {
    const args = ["restore", "--staged"]
    if (files && files.length) args.push("--", ...files)
    else args.push(".")
    this.run(cwd, args)
    return this.status(cwd)
  }

  /**
   * Commit staged changes. When `all` is true, stages all tracked modifications
   * first (`git commit -a`). Returns the new HEAD commit plus refreshed status.
   */
  commit(cwd: string, message: string, all = false): { commit: GitCommit; status: GitStatus } {
    const args = ["commit", "-m", message]
    if (all) args.push("-a")
    this.run(cwd, args)
    const commit = this.log(cwd, 1)[0]
    return { commit, status: this.status(cwd) }
  }

  /** Create a branch (optionally checking it out) and return refreshed status. */
  createBranch(cwd: string, name: string, checkout = true): GitStatus {
    this.run(cwd, checkout ? ["checkout", "-b", name] : ["branch", name])
    return this.status(cwd)
  }

  /** Switch to an existing branch/ref and return refreshed status. */
  checkout(cwd: string, ref: string): GitStatus {
    this.run(cwd, ["checkout", ref])
    return this.status(cwd)
  }

  /**
   * List local and remote-tracking branches with a flag for the current one.
   * Fills the gap between `git_branch` (create) and `git_checkout` (switch):
   * answers "what branches can I switch to?" without parsing `git branch -a`.
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

  /** Push to the remote. Uses --porcelain so the result lands on stdout. */
  push(cwd: string): { output: string; status: GitStatus } {
    const output = this.run(cwd, ["push", "--porcelain"])
    return { output: output || "(pushed)", status: this.status(cwd) }
  }

  /** Pull (fast-forward only to avoid surprise merge commits). */
  pull(cwd: string): { output: string; status: GitStatus } {
    const output = this.run(cwd, ["pull", "--ff-only"])
    return { output: output || "(up to date)", status: this.status(cwd) }
  }

  /** Stash the working tree (optionally with a message). */
  stash(cwd: string, message?: string): { output: string; status: GitStatus } {
    const args = ["stash", "push"]
    if (message) args.push("-m", message)
    const output = this.run(cwd, args)
    return { output, status: this.status(cwd) }
  }

  /** Re-apply and drop the most recent (or given) stash entry. */
  stashPop(cwd: string, ref?: string): { output: string; status: GitStatus } {
    const args = ["stash", "pop"]
    if (ref) args.push(ref)
    const output = this.run(cwd, args)
    return { output, status: this.status(cwd) }
  }

  /** List stash entries (raw `git stash list` lines). */
  stashList(cwd: string): string[] {
    const raw = this.run(cwd, ["stash", "list"])
    return raw ? raw.split("\n") : []
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

  /**
   * Commit history for a single file (`git log --follow -- <file>`), tracking
   * the file across renames. `git_log` covers the whole repo; this answers "how
   * did this one file evolve?".
   */
  fileHistory(cwd: string, file: string, limit = 20): GitCommit[] {
    const sep = "\x1f"
    const fmt = ["%h", "%an", "%ad", "%s"].join(sep)
    const raw = this.run(cwd, [
      "log",
      `-n${limit}`,
      "--follow",
      "--date=short",
      `--pretty=format:${fmt}`,
      "--",
      file,
    ])
    if (!raw) return []
    return raw.split("\n").map((line) => {
      const [hash, author, date, subject] = line.split(sep)
      return { hash, author, date, subject }
    })
  }

  /**
   * List tags (newest first by creation), each resolved to its target commit.
   * Fills the release-marker gap alongside git_branches: answers "what versions
   * are tagged?". `subject` is the annotation for annotated tags, else the
   * pointed-at commit's subject.
   */
  tags(cwd: string, limit = 50): GitTag[] {
    const sep = "\x1f"
    const raw = this.run(cwd, [
      "for-each-ref",
      `--count=${limit}`,
      "--sort=-creatordate",
      `--format=%(refname:short)${sep}%(objectname:short)${sep}%(creatordate:short)${sep}%(contents:subject)`,
      "refs/tags",
    ])
    if (!raw) return []
    const out: GitTag[] = []
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      const [name, hash, date, subject] = line.split(sep)
      out.push({ name, hash, date, subject: subject ?? "" })
    }
    return out
  }

  /** List configured remotes with their fetch/push URLs. */
  remotes(cwd: string): GitRemote[] {
    const raw = this.run(cwd, ["remote", "-v"])
    if (!raw) return []
    const map = new Map<string, GitRemote>()
    for (const line of raw.split("\n")) {
      // Format: "origin\thttps://...\t(fetch)"
      const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/)
      if (!m) continue
      const [, name, url, kind] = m
      const existing = map.get(name) ?? { name, fetchUrl: "", pushUrl: "" }
      if (kind === "fetch") existing.fetchUrl = url
      else existing.pushUrl = url
      map.set(name, existing)
    }
    return [...map.values()]
  }
}
