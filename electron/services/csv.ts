/**
 * CsvService — the no-shell, no-dependency bridge between CSV and JSON. The
 * tabular counterpart to JsonService: hand it a CSV blob (a query export, a
 * spreadsheet dump, an HTTP body) and get back structured JSON, or turn an
 * array of objects back into CSV. Pure, synchronous, stateless. The parser is
 * RFC-4180-aware — it handles quoted fields, embedded delimiters/newlines, and
 * escaped quotes ("") — so Claude never has to eyeball-split on commas.
 */
export class CsvService {
  /**
   * Parse a CSV string into JSON. With `hasHeader` (default true) the first row
   * names the columns and each subsequent row becomes an object; otherwise rows
   * are returned as arrays of strings. Returns the parsed value plus row/column
   * counts. Throws on malformed quoting.
   */
  toJson(
    text: string,
    opts: { delimiter?: string; hasHeader?: boolean } = {},
  ): { rows: unknown[]; rowCount: number; columns: string[] } {
    const delimiter = opts.delimiter ?? ","
    const hasHeader = opts.hasHeader ?? true
    const grid = this.parseGrid(text, delimiter)
    if (grid.length === 0) return { rows: [], rowCount: 0, columns: [] }

    if (!hasHeader) {
      return { rows: grid, rowCount: grid.length, columns: [] }
    }

    const columns = grid[0]
    const rows = grid.slice(1).map((cells) => {
      const obj: Record<string, string> = {}
      columns.forEach((col, i) => {
        obj[col] = cells[i] ?? ""
      })
      return obj
    })
    return { rows, rowCount: rows.length, columns }
  }

  /**
   * Serialize JSON into a CSV string. Accepts an array of objects (keys become
   * the header — union of all keys, or an explicit `columns` order) or an array
   * of arrays (emitted as-is, no header). Fields are quoted only when they
   * contain the delimiter, a quote, or a newline. Throws if the input JSON is
   * invalid or not an array.
   */
  fromJson(
    text: string,
    opts: { delimiter?: string; columns?: string[] } = {},
  ): { csv: string; rowCount: number; columns: string[] } {
    const delimiter = opts.delimiter ?? ","
    const value = JSON.parse(text)
    if (!Array.isArray(value)) {
      throw new Error("Input JSON must be an array (of objects or of arrays)")
    }
    if (value.length === 0) return { csv: "", rowCount: 0, columns: [] }

    // Array of arrays → straight grid, no header.
    if (Array.isArray(value[0])) {
      const lines = (value as unknown[][]).map((row) =>
        row.map((c) => this.encodeCell(c, delimiter)).join(delimiter),
      )
      return { csv: lines.join("\r\n"), rowCount: value.length, columns: [] }
    }

    // Array of objects → header + rows.
    const columns =
      opts.columns ?? this.collectColumns(value as Record<string, unknown>[])
    const header = columns.map((c) => this.encodeCell(c, delimiter)).join(delimiter)
    const lines = (value as Record<string, unknown>[]).map((obj) =>
      columns
        .map((col) => this.encodeCell(obj[col] ?? "", delimiter))
        .join(delimiter),
    )
    return {
      csv: [header, ...lines].join("\r\n"),
      rowCount: value.length,
      columns,
    }
  }

  /**
   * A quick shape probe: parse the CSV and return its column names, total row
   * count, and the first `limit` rows (default 10) as objects. The CSV sibling
   * of json_keys — see the table before committing to a full conversion.
   */
  preview(
    text: string,
    opts: { delimiter?: string; hasHeader?: boolean; limit?: number } = {},
  ): { columns: string[]; rowCount: number; sample: unknown[] } {
    const limit = opts.limit ?? 10
    const { rows, rowCount, columns } = this.toJson(text, opts)
    return { columns, rowCount, sample: rows.slice(0, limit) }
  }

  /** Parse CSV text into a grid of string cells (RFC-4180 quoting). */
  private parseGrid(text: string, delimiter: string): string[][] {
    const rows: string[][] = []
    let row: string[] = []
    let field = ""
    let inQuotes = false
    let i = 0
    const n = text.length
    // Strip a leading UTF-8 BOM if present.
    if (text.charCodeAt(0) === 0xfeff) i = 1

    const pushField = () => {
      row.push(field)
      field = ""
    }
    const pushRow = () => {
      pushField()
      rows.push(row)
      row = []
    }

    while (i < n) {
      const ch = text[i]
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"'
            i += 2
            continue
          }
          inQuotes = false
          i++
          continue
        }
        field += ch
        i++
        continue
      }
      if (ch === '"') {
        inQuotes = true
        i++
        continue
      }
      if (ch === delimiter) {
        pushField()
        i++
        continue
      }
      if (ch === "\r") {
        // Handle CRLF and bare CR.
        if (text[i + 1] === "\n") i++
        pushRow()
        i++
        continue
      }
      if (ch === "\n") {
        pushRow()
        i++
        continue
      }
      field += ch
      i++
    }
    if (inQuotes) throw new Error("Malformed CSV: unterminated quoted field")
    // Flush the trailing field/row unless the input ended on a newline.
    if (field.length > 0 || row.length > 0) pushRow()
    return rows
  }

  /** Union of object keys, preserving first-seen order. */
  private collectColumns(objs: Record<string, unknown>[]): string[] {
    const seen = new Set<string>()
    const cols: string[] = []
    for (const obj of objs) {
      for (const key of Object.keys(obj)) {
        if (!seen.has(key)) {
          seen.add(key)
          cols.push(key)
        }
      }
    }
    return cols
  }

  /** Stringify a cell, quoting only when it contains a delimiter, quote, or newline. */
  private encodeCell(value: unknown, delimiter: string): string {
    const s =
      value == null
        ? ""
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value)
    if (
      s.includes(delimiter) ||
      s.includes('"') ||
      s.includes("\n") ||
      s.includes("\r")
    ) {
      return '"' + s.replace(/"/g, '""') + '"'
    }
    return s
  }
}
