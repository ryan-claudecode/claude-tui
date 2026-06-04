import fs from "fs"
import path from "path"

export interface ReadFileResult {
  path: string // resolved absolute path
  totalLines: number
  startLine: number // 1-based, inclusive
  endLine: number // 1-based, inclusive
  content: string // the requested slice, joined with \n
}

export interface WriteFileResult {
  path: string // resolved absolute path
  bytesWritten: number
  created: boolean // true if the file did not exist before
}

const MAX_READ_BYTES = 2 * 1024 * 1024 // refuse to read files larger than 2MB

/**
 * FileService — structured file read/write scoped to a session's working
 * directory. Pairs with FileSearchService (find/grep): once Claude locates a
 * file it can read a precise line range or write content back, all with a
 * machine-readable result instead of scraping a terminal `cat`/`echo`.
 *
 * Paths are resolved relative to the provided base dir; reads are size-capped
 * and writes create parent directories as needed. No shell, no persistence.
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

  /**
   * Write `content` to `filePath` (relative to `baseDir` or absolute), creating
   * parent directories if needed. Returns whether the file was newly created.
   */
  write(baseDir: string, filePath: string, content: string): WriteFileResult {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath)
    const created = !fs.existsSync(abs)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, "utf8")
    return {
      path: abs,
      bytesWritten: Buffer.byteLength(content, "utf8"),
      created,
    }
  }
}
