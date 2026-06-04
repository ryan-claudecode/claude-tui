/**
 * TextService — the no-shell, no-`sed`/`awk`/`tr` way for Claude to crunch
 * strings: re-case/re-format a blob, count its parts, and reorder/dedupe its
 * lines. Pure and stateless — every method takes text in and returns the
 * transformed text (or stats) out, so it pairs naturally with read_file / the
 * clipboard tools without spawning a terminal. (For regex find/replace, use the
 * dedicated regex_test / regex_replace tools.)
 */

export type CaseOp =
  | "upper"
  | "lower"
  | "title"
  | "capitalize"
  | "sentence"
  | "camel"
  | "pascal"
  | "snake"
  | "kebab"
  | "constant"
  | "slug"
  | "swapcase"
  | "trim"
  | "squeeze"
  | "reverse"

export type LineOp =
  | "sort"
  | "rsort"
  | "dedupe"
  | "reverse"
  | "shuffle"
  | "number"
  | "trim"
  | "compact"

export interface TextCounts {
  chars: number
  charsNoSpaces: number
  words: number
  lines: number
  sentences: number
  paragraphs: number
  bytes: number
}

export class TextService {
  /** Split a string into word tokens for case conversion. */
  private words(text: string): string[] {
    return (
      text
        // boundaries: camelCase humps, non-alphanumerics
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
    )
  }

  /** Re-case or re-format a string. Returns the transformed text. */
  transform(text: string, op: CaseOp): string {
    switch (op) {
      case "upper":
        return text.toUpperCase()
      case "lower":
        return text.toLowerCase()
      case "title":
        return text.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
      case "capitalize":
        return text.charAt(0).toUpperCase() + text.slice(1)
      case "sentence":
        return text
          .toLowerCase()
          .replace(/(^\s*\w|[.!?]\s+\w)/g, (c) => c.toUpperCase())
      case "camel": {
        const w = this.words(text).map((s) => s.toLowerCase())
        return w
          .map((s, i) => (i === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)))
          .join("")
      }
      case "pascal":
        return this.words(text)
          .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
          .join("")
      case "snake":
        return this.words(text)
          .map((s) => s.toLowerCase())
          .join("_")
      case "kebab":
      case "slug":
        return this.words(text)
          .map((s) => s.toLowerCase())
          .join("-")
      case "constant":
        return this.words(text)
          .map((s) => s.toUpperCase())
          .join("_")
      case "swapcase":
        return text.replace(/[a-zA-Z]/g, (c) =>
          c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase(),
        )
      case "trim":
        return text.trim()
      case "squeeze":
        // collapse runs of whitespace into a single space, then trim
        return text.replace(/\s+/g, " ").trim()
      case "reverse":
        return [...text].reverse().join("")
      default:
        throw new Error(`Unknown transform op: ${op}`)
    }
  }

  /** Count characters, words, lines, sentences, paragraphs, and bytes. */
  count(text: string): TextCounts {
    const lines = text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length
    const words = (text.match(/\S+/g) ?? []).length
    const sentences = (text.match(/[^.!?]+[.!?]+/g) ?? []).length
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean).length
    return {
      chars: text.length,
      charsNoSpaces: text.replace(/\s/g, "").length,
      words,
      lines,
      sentences,
      paragraphs,
      bytes: Buffer.byteLength(text, "utf8"),
    }
  }

  /**
   * Line-oriented transform. `op` reorders or filters the lines, then they are
   * rejoined with "\n". `caseInsensitive` affects sort/dedupe comparisons.
   */
  lines(
    text: string,
    op: LineOp,
    opts: { caseInsensitive?: boolean } = {},
  ): { text: string; lineCount: number } {
    let lines = text.split(/\r\n|\r|\n/)
    const key = (s: string) => (opts.caseInsensitive ? s.toLowerCase() : s)

    switch (op) {
      case "sort":
        lines = [...lines].sort((a, b) => key(a).localeCompare(key(b)))
        break
      case "rsort":
        lines = [...lines].sort((a, b) => key(b).localeCompare(key(a)))
        break
      case "dedupe": {
        const seen = new Set<string>()
        lines = lines.filter((l) => {
          const k = key(l)
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
        break
      }
      case "reverse":
        lines = [...lines].reverse()
        break
      case "shuffle":
        lines = [...lines]
        for (let i = lines.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[lines[i], lines[j]] = [lines[j], lines[i]]
        }
        break
      case "number": {
        const width = String(lines.length).length
        lines = lines.map((l, i) => `${String(i + 1).padStart(width, " ")}  ${l}`)
        break
      }
      case "trim":
        lines = lines.map((l) => l.trim())
        break
      case "compact":
        lines = lines.filter((l) => l.trim().length > 0)
        break
      default:
        throw new Error(`Unknown line op: ${op}`)
    }
    return { text: lines.join("\n"), lineCount: lines.length }
  }
}
