/**
 * JsonService — the no-shell, no-`jq` way for Claude to reshape and inspect
 * JSON it already has in hand (a tool result, an HTTP body, a config blob).
 * Pure, synchronous, stateless: parse once, then pretty-print/minify or pluck a
 * value out by path. Throws a clear error on invalid JSON or a bad path so the
 * caller gets a structured failure instead of malformed output.
 */
export class JsonService {
  /** Pretty-print (indent) or minify a JSON string, optionally sorting object keys. */
  format(text: string, opts: { minify?: boolean; indent?: number; sortKeys?: boolean } = {}): string {
    const value = JSON.parse(text)
    const replacer = opts.sortKeys ? this.sortReplacer(value) : undefined
    if (opts.minify) return JSON.stringify(replacer ?? value)
    return JSON.stringify(replacer ?? value, null, opts.indent ?? 2)
  }

  /**
   * Pluck a value out of a JSON string by a dot/bracket path, e.g.
   * `users[0].name` or `data.items[2]`. Returns the value (re-serialized for
   * objects/arrays, raw for primitives) plus its JS `type`. Throws if the path
   * doesn't resolve.
   */
  query(text: string, path: string): { value: unknown; type: string } {
    const root = JSON.parse(text)
    const keys = this.parsePath(path)
    let cur: unknown = root
    const walked: string[] = []
    for (const key of keys) {
      if (cur == null || typeof cur !== "object") {
        throw new Error(`Path '${path}' does not resolve: '${walked.join(".") || "<root>"}' is not indexable`)
      }
      cur = (cur as Record<string, unknown>)[key]
      walked.push(key)
      if (cur === undefined) {
        throw new Error(`Path '${path}' does not resolve: no key '${key}'`)
      }
    }
    return { value: cur, type: Array.isArray(cur) ? "array" : cur === null ? "null" : typeof cur }
  }

  /** The top-level keys (objects) or length (arrays) of a JSON string — a quick shape probe. */
  keys(text: string): { type: string; keys?: string[]; length?: number } {
    const value = JSON.parse(text)
    if (Array.isArray(value)) return { type: "array", length: value.length }
    if (value && typeof value === "object") return { type: "object", keys: Object.keys(value) }
    return { type: value === null ? "null" : typeof value }
  }

  /** Split `a.b[0].c` into ["a","b","0","c"]. */
  private parsePath(path: string): string[] {
    const out: string[] = []
    for (const seg of path.split(".")) {
      if (!seg) continue
      const m = seg.matchAll(/([^[\]]+)|\[(\d+)\]/g)
      for (const part of m) {
        out.push(part[1] ?? part[2])
      }
    }
    return out
  }

  /** Recursively rebuild objects with sorted keys so JSON.stringify emits them ordered. */
  private sortReplacer(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((v) => this.sortReplacer(v))
    if (value && typeof value === "object") {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(value).sort()) {
        sorted[k] = this.sortReplacer((value as Record<string, unknown>)[k])
      }
      return sorted
    }
    return value
  }
}
