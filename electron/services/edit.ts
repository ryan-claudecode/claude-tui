import fs from "fs"
import path from "path"

export interface ReplaceResult {
  path: string // resolved absolute path
  replacements: number // how many occurrences were replaced
  bytesWritten: number
}

export interface InsertResult {
  path: string // resolved absolute path
  line: number // 1-based line the content was inserted before (or appended after EOF)
  bytesWritten: number
}

const MAX_EDIT_BYTES = 2 * 1024 * 1024 // refuse to edit files larger than 2MB

/**
 * EditService — surgical, in-place edits to a file scoped to a session's working
 * directory. FileService can only read or overwrite a whole file; this is the
 * missing middle ground: change a precise string or insert at a line without
 * rewriting (and risking clobbering) the rest of the file.
 *
 * `replaceInFile` mirrors the semantics of the editor's exact-string-replace:
 * it requires the target to exist and (unless `replaceAll`) to be unique, so an
 * ambiguous edit fails loudly instead of silently changing the wrong place.
 *
 * Paths resolve relative to the provided base dir; no shell, no persistence.
 */
export class EditService {
  private resolve(baseDir: string, filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath)
  }

  private readSized(abs: string): string {
    const stat = fs.statSync(abs)
    if (stat.size > MAX_EDIT_BYTES) {
      throw new Error(`File too large to edit (${stat.size} bytes, max ${MAX_EDIT_BYTES})`)
    }
    return fs.readFileSync(abs, "utf8")
  }

  /**
   * Replace `oldString` with `newString` in `filePath`. By default the target
   * must occur exactly once (so the edit is unambiguous); pass `replaceAll` to
   * replace every occurrence. Throws if `oldString` is absent, equal to
   * `newString`, or (without `replaceAll`) appears more than once.
   */
  replaceInFile(
    baseDir: string,
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ): ReplaceResult {
    if (oldString === newString) {
      throw new Error("old_string and new_string are identical — nothing to change")
    }
    const abs = this.resolve(baseDir, filePath)
    const content = this.readSized(abs)

    // Count occurrences of the literal target.
    let count = 0
    let idx = content.indexOf(oldString)
    while (idx !== -1) {
      count++
      idx = content.indexOf(oldString, idx + oldString.length)
    }

    if (count === 0) {
      throw new Error("old_string not found in file")
    }
    if (count > 1 && !replaceAll) {
      throw new Error(
        `old_string is not unique (${count} occurrences) — provide more context or set replace_all`,
      )
    }

    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString)

    fs.writeFileSync(abs, updated, "utf8")
    return {
      path: abs,
      replacements: replaceAll ? count : 1,
      bytesWritten: Buffer.byteLength(updated, "utf8"),
    }
  }

  /**
   * Insert `content` before 1-based `line` in `filePath`. A `line` <= 0 or
   * greater than the file's line count appends at the end. The inserted content
   * occupies its own line(s); existing line endings are preserved.
   */
  insertInFile(baseDir: string, filePath: string, line: number, content: string): InsertResult {
    const abs = this.resolve(baseDir, filePath)
    const existing = this.readSized(abs)
    const lines = existing.split(/\r?\n/)
    const total = lines.length

    let at: number
    if (line <= 0 || line > total) {
      at = total // append
    } else {
      at = line - 1 // insert before the 1-based line
    }

    const insertLines = content.split(/\r?\n/)
    lines.splice(at, 0, ...insertLines)
    const updated = lines.join("\n")

    fs.writeFileSync(abs, updated, "utf8")
    return {
      path: abs,
      line: at + 1,
      bytesWritten: Buffer.byteLength(updated, "utf8"),
    }
  }
}
