export interface RegexMatch {
  /** The full matched substring. */
  match: string
  /** 0-based index where the match starts in the input. */
  index: number
  /** Positional capture groups (1..n); undefined entries become null. */
  groups: (string | null)[]
  /** Named capture groups, if the pattern uses `(?<name>...)`. */
  named?: Record<string, string | null>
}

/**
 * RegexService — the no-shell way for Claude to test and apply regular
 * expressions against text it already has (a log blob, a tool result, a code
 * snippet). Pure, synchronous, stateless. The interactive counterpart to
 * grep_code's file scanning: paste a pattern, see exactly what it matches
 * (with capture groups) before committing to a replace. Throws a clear error on
 * an invalid pattern/flags instead of leaking a raw SyntaxError.
 */
export class RegexService {
  /** Hard cap so a runaway pattern can't flood the response. */
  private static readonly MAX_MATCHES = 1000

  /**
   * Find every match of `pattern` in `text`. `g` is added automatically so all
   * matches are returned. Each match carries its start `index`, positional
   * `groups`, and `named` groups. Returns the matches plus a `count` and a
   * `truncated` flag if the cap was hit.
   */
  test(
    pattern: string,
    text: string,
    flags = "",
  ): { matches: RegexMatch[]; count: number; truncated: boolean } {
    const re = this.compile(pattern, flags, true)
    const matches: RegexMatch[] = []
    let truncated = false
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      matches.push({
        match: m[0],
        index: m.index,
        groups: m.slice(1).map((g) => g ?? null),
        ...(m.groups
          ? {
              named: Object.fromEntries(
                Object.entries(m.groups).map(([k, v]) => [k, v ?? null]),
              ),
            }
          : {}),
      })
      if (matches.length >= RegexService.MAX_MATCHES) {
        truncated = true
        break
      }
      // Guard against zero-width matches looping forever.
      if (m.index === re.lastIndex) re.lastIndex++
    }
    return { matches, count: matches.length, truncated }
  }

  /**
   * Replace every match of `pattern` in `text` with `replacement`, which
   * supports JS substitution syntax (`$1`, `$<name>`, `$&`, `$$`). `g` is added
   * automatically so all matches are replaced. Returns the rewritten `result`
   * and how many `replacements` were made.
   */
  replace(
    pattern: string,
    text: string,
    replacement: string,
    flags = "",
  ): { result: string; replacements: number } {
    // Count via a fresh global regex (replace() doesn't report a count).
    const counter = this.compile(pattern, flags, true)
    const replacements = (text.match(counter) ?? []).length
    const re = this.compile(pattern, flags, true)
    return { result: text.replace(re, replacement), replacements }
  }

  /** Compile a pattern, optionally forcing the global flag, with friendly errors. */
  private compile(pattern: string, flags: string, forceGlobal: boolean): RegExp {
    let f = flags
    if (forceGlobal && !f.includes("g")) f += "g"
    try {
      return new RegExp(pattern, f)
    } catch (e) {
      throw new Error(`Invalid regex /${pattern}/${flags}: ${(e as Error).message}`)
    }
  }
}
