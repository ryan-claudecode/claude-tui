import fs from "fs"
import path from "path"

export interface FoundFile {
  path: string // relative to the search root
  sizeBytes: number
}

export interface GrepMatch {
  file: string // relative to the search root
  line: number // 1-based
  text: string // the matching line, trimmed and length-capped
}

export interface GrepResult {
  matches: GrepMatch[]
  filesScanned: number
  truncated: boolean
}

// Directories that are never worth walking — build output, deps, VCS metadata.
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  ".next",
  ".cache",
  "coverage",
  ".turbo",
  ".vite",
])

const MAX_FILE_BYTES = 1024 * 1024 // skip files larger than 1MB for content grep
const MAX_LINE_LEN = 400

/**
 * FileSearchService — structured file discovery and content search scoped to a
 * session's working directory. The read-only counterpart to CommandService:
 * instead of asking Claude to run `find`/`grep` in a terminal and scrape the
 * output (which differs per-OS and needs the right tools installed), these give
 * a portable, bounded, machine-readable result.
 *
 * Pure Node (fs walk) — no shell, no external dependency. Walks are bounded by
 * file/match caps and skip common build/dependency directories so a search in a
 * large repo stays fast and never floods the response.
 */
export class FileSearchService {
  /**
   * Find files whose path matches a glob `pattern` (supports `*`, `**`, `?`),
   * relative to `cwd`. Returns up to `limit` results (default 200).
   */
  findFiles(cwd: string, pattern: string, limit = 200): FoundFile[] {
    const regex = globToRegExp(pattern)
    const results: FoundFile[] = []
    this.walk(cwd, cwd, (abs, rel) => {
      if (results.length >= limit) return false
      if (regex.test(rel)) {
        let sizeBytes = 0
        try {
          sizeBytes = fs.statSync(abs).size
        } catch {
          /* ignore */
        }
        results.push({ path: rel, sizeBytes })
      }
      return true
    })
    return results
  }

  /**
   * Search file contents under `cwd` for `pattern` (a regex; pass
   * `caseInsensitive` to ignore case). Optionally restrict to files whose path
   * matches `glob`. Returns up to `maxMatches` matches (default 200).
   */
  grep(
    cwd: string,
    pattern: string,
    opts: { glob?: string; caseInsensitive?: boolean; maxMatches?: number } = {},
  ): GrepResult {
    const maxMatches = opts.maxMatches ?? 200
    let regex: RegExp
    try {
      regex = new RegExp(pattern, opts.caseInsensitive ? "i" : "")
    } catch {
      regex = new RegExp(escapeRegExp(pattern), opts.caseInsensitive ? "i" : "")
    }
    const globRegex = opts.glob ? globToRegExp(opts.glob) : null

    const matches: GrepMatch[] = []
    let filesScanned = 0
    let truncated = false

    this.walk(cwd, cwd, (abs, rel) => {
      if (matches.length >= maxMatches) {
        truncated = true
        return false
      }
      if (globRegex && !globRegex.test(rel)) return true

      let stat: fs.Stats
      try {
        stat = fs.statSync(abs)
      } catch {
        return true
      }
      if (stat.size > MAX_FILE_BYTES) return true

      let content: string
      try {
        content = fs.readFileSync(abs, "utf8")
      } catch {
        return true // binary or unreadable
      }
      if (content.includes("\u0000")) return true // looks binary

      filesScanned++
      const lines = content.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= maxMatches) {
          truncated = true
          break
        }
        if (regex.test(lines[i])) {
          let text = lines[i].trim()
          if (text.length > MAX_LINE_LEN) text = text.slice(0, MAX_LINE_LEN) + "…"
          matches.push({ file: rel, line: i + 1, text })
        }
      }
      return true
    })

    return { matches, filesScanned, truncated }
  }

  /**
   * Depth-first walk of `dir`, calling `visit(absolutePath, relativePath)` for
   * each file. If `visit` returns false the walk stops early. Skips ignored
   * directories and anything unreadable.
   */
  private walk(root: string, dir: string, visit: (abs: string, rel: string) => boolean): boolean {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return true
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        if (!this.walk(root, abs, visit)) return false
      } else if (entry.isFile()) {
        const rel = path.relative(root, abs).split(path.sep).join("/")
        if (!visit(abs, rel)) return false
      }
    }
    return true
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Convert a glob pattern into an anchored RegExp matching forward-slash paths.
 * Supports `**` (any path segments), `*` (anything but `/`), and `?`.
 */
function globToRegExp(glob: string): RegExp {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*"
        i++
        if (glob[i + 1] === "/") i++ // consume the slash after **
      } else {
        re += "[^/]*"
      }
    } else if (c === "?") {
      re += "[^/]"
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c
    } else {
      re += c
    }
  }
  return new RegExp("^" + re + "$", "i")
}
