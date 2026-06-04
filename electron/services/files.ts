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

export interface PathOpResult {
  from?: string // resolved source path (move/copy)
  to?: string // resolved destination path (move/copy)
  path?: string // resolved path (delete/mkdir)
  kind: "file" | "directory"
}

export interface TailResult {
  path: string // resolved absolute path
  lines: number // number of lines actually returned
  content: string // the last N lines, joined with \n
  bytesRead: number // bytes read from the end of the file
  /** True if the file is larger than the read window, so earlier content was skipped. */
  partial: boolean
}

export interface StatResult {
  path: string // resolved absolute path
  exists: boolean
  isDirectory: boolean
  isFile: boolean
  size: number // bytes (0 for directories)
  modified: string // ISO timestamp of last modification
  created: string // ISO timestamp of creation
}

const MAX_READ_BYTES = 2 * 1024 * 1024 // refuse to read files larger than 2MB
const TAIL_WINDOW_BYTES = 512 * 1024 // read at most the last 512KB when tailing

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
   * Read the last `lines` lines of `filePath` (relative to `baseDir` or
   * absolute) — the log-tailing counterpart of `read`. Only the final
   * TAIL_WINDOW_BYTES of the file are read, so this is safe on large logs that
   * `read` would refuse; `partial` flags when earlier content was skipped.
   */
  tail(baseDir: string, filePath: string, lines = 50): TailResult {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath)
    const stat = fs.statSync(abs)
    const readBytes = Math.min(stat.size, TAIL_WINDOW_BYTES)
    const start = stat.size - readBytes

    const fd = fs.openSync(abs, "r")
    let raw: string
    try {
      const buf = Buffer.alloc(readBytes)
      fs.readSync(fd, buf, 0, readBytes, start)
      raw = buf.toString("utf8")
    } finally {
      fs.closeSync(fd)
    }

    // If we started mid-file, the first (likely partial) line is unreliable.
    const partial = start > 0
    let allLines = raw.split(/\r?\n/)
    if (partial && allLines.length) allLines = allLines.slice(1)
    const tailLines = allLines.slice(-Math.max(1, lines))

    return {
      path: abs,
      lines: tailLines.length,
      content: tailLines.join("\n"),
      bytesRead: readBytes,
      partial,
    }
  }

  /**
   * Metadata for `filePath` (relative to `baseDir` or absolute): existence,
   * kind, size, and modified/created timestamps — without scraping `ls -l`/
   * `stat`. Returns `exists: false` (rather than throwing) for a missing path.
   */
  stat(baseDir: string, filePath: string): StatResult {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath)
    if (!fs.existsSync(abs)) {
      return {
        path: abs,
        exists: false,
        isDirectory: false,
        isFile: false,
        size: 0,
        modified: "",
        created: "",
      }
    }
    const s = fs.statSync(abs)
    return {
      path: abs,
      exists: true,
      isDirectory: s.isDirectory(),
      isFile: s.isFile(),
      size: s.isDirectory() ? 0 : s.size,
      modified: s.mtime.toISOString(),
      created: s.birthtime.toISOString(),
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

  private resolve(baseDir: string, filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath)
  }

  private kindOf(abs: string): "file" | "directory" {
    return fs.statSync(abs).isDirectory() ? "directory" : "file"
  }

  /**
   * Move/rename `from` to `to` (both relative to `baseDir` or absolute). Creates
   * the destination's parent directories as needed.
   */
  move(baseDir: string, from: string, to: string): PathOpResult {
    const absFrom = this.resolve(baseDir, from)
    const absTo = this.resolve(baseDir, to)
    const kind = this.kindOf(absFrom)
    fs.mkdirSync(path.dirname(absTo), { recursive: true })
    fs.renameSync(absFrom, absTo)
    return { from: absFrom, to: absTo, kind }
  }

  /**
   * Copy `from` to `to` (both relative to `baseDir` or absolute). Recurses into
   * directories. Creates the destination's parent directories as needed.
   */
  copy(baseDir: string, from: string, to: string): PathOpResult {
    const absFrom = this.resolve(baseDir, from)
    const absTo = this.resolve(baseDir, to)
    const kind = this.kindOf(absFrom)
    fs.mkdirSync(path.dirname(absTo), { recursive: true })
    fs.cpSync(absFrom, absTo, { recursive: true })
    return { from: absFrom, to: absTo, kind }
  }

  /**
   * Delete `filePath` (relative to `baseDir` or absolute). Removes directories
   * recursively. Throws if the path does not exist.
   */
  remove(baseDir: string, filePath: string): PathOpResult {
    const abs = this.resolve(baseDir, filePath)
    const kind = this.kindOf(abs)
    fs.rmSync(abs, { recursive: true, force: false })
    return { path: abs, kind }
  }

  /**
   * Create directory `dirPath` (relative to `baseDir` or absolute), including
   * any missing parents. No error if it already exists.
   */
  makeDir(baseDir: string, dirPath: string): PathOpResult {
    const abs = this.resolve(baseDir, dirPath)
    fs.mkdirSync(abs, { recursive: true })
    return { path: abs, kind: "directory" }
  }
}
