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
}
