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
 * GitService — structured, read-only git queries scoped to a working directory.
 *
 * Gives Claude machine-readable repo state (branch, ahead/behind, staged vs.
 * unstaged changes, recent log, diffs) instead of forcing it to parse raw
 * terminal output. Read-only by design: mutating operations (commit/push) stay
 * the user's responsibility and Claude can still run them in the terminal.
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
}
