import fs from "fs"
import path from "path"

export interface ReadFileResult {
  path: string // resolved absolute path
  totalLines: number
  startLine: number // 1-based, inclusive
  endLine: number // 1-based, inclusive
  content: string // the requested slice, joined with \n
}

const MAX_READ_BYTES = 2 * 1024 * 1024 // refuse to read files larger than 2MB

/**
 * FileService — structured file read scoped to a session's working directory.
 * The sole surviving caller is the `diff_files` panel tool, which reads two
 * files (or a file vs. proposed content) to render an interactive diff. Paths
 * resolve relative to the provided base dir; reads are size-capped. No shell,
 * no persistence.
 */
export class FileService {
  /**
   * Read `filePath` (relative to `baseDir` or absolute). Optionally return only
   * lines `[startLine, endLine]` (1-based, inclusive). Refuses files > 2MB.
   */
  read(baseDir: string, filePath: string, startLine?: number, endLine?: number): ReadFileResult {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath)
    const stat = fs.statSync(abs)
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(`File too large to read (${stat.size} bytes, max ${MAX_READ_BYTES})`)
    }
    const raw = fs.readFileSync(abs, "utf8")
    const lines = raw.split(/\r?\n/)
    const totalLines = lines.length

    const start = Math.max(1, startLine ?? 1)
    const end = Math.min(totalLines, endLine ?? totalLines)
    const slice = start <= end ? lines.slice(start - 1, end) : []

    return {
      path: abs,
      totalLines,
      startLine: start,
      endLine: end,
      content: slice.join("\n"),
    }
  }
}
