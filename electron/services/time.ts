export interface TimeRepr {
  iso: string
  epochMs: number
  epochSec: number
  utc: string
  local: string
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: string
}

/**
 * TimeService — the no-shell, no-`date` way for Claude to reason about
 * timestamps: get "now" in every common representation, convert an epoch or ISO
 * string into all the others, and humanize the gap between two times. Pure and
 * stateless. Handy when a tool result hands back a raw epoch and you need a
 * readable date (or vice versa) without spawning a terminal.
 */
export class TimeService {
  private readonly weekdays = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ]

  /** Every representation of the current moment. */
  now(): TimeRepr {
    return this.represent(new Date())
  }

  /**
   * Convert an input into all representations. Accepts an epoch in seconds or
   * milliseconds (number or numeric string — sub-1e12 is treated as seconds) or
   * any Date-parseable string (ISO 8601, etc). Throws on an unparseable input.
   */
  convert(input: string | number): TimeRepr {
    return this.represent(this.parse(input))
  }

  /**
   * Signed duration `to - from` (each parsed like `convert`). Returns the gap in
   * several units plus a humanized string. Positive = `to` is later than `from`.
   */
  diff(from: string | number, to: string | number): {
    ms: number
    seconds: number
    minutes: number
    hours: number
    days: number
    human: string
  } {
    const a = this.parse(from).getTime()
    const b = this.parse(to).getTime()
    const ms = b - a
    return {
      ms,
      seconds: ms / 1000,
      minutes: ms / 60000,
      hours: ms / 3600000,
      days: ms / 86400000,
      human: this.humanize(ms),
    }
  }

  private parse(input: string | number): Date {
    if (typeof input === "number" || /^-?\d+$/.test(String(input).trim())) {
      const n = Number(input)
      // Heuristic: values below 1e12 are almost certainly epoch *seconds*.
      const ms = Math.abs(n) < 1e12 ? n * 1000 : n
      const d = new Date(ms)
      if (isNaN(d.getTime())) throw new Error(`Unparseable epoch: ${input}`)
      return d
    }
    const d = new Date(input)
    if (isNaN(d.getTime())) throw new Error(`Unparseable date string: ${input}`)
    return d
  }

  private represent(d: Date): TimeRepr {
    return {
      iso: d.toISOString(),
      epochMs: d.getTime(),
      epochSec: Math.floor(d.getTime() / 1000),
      utc: d.toUTCString(),
      local: d.toString(),
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      second: d.getSeconds(),
      weekday: this.weekdays[d.getDay()],
    }
  }

  private humanize(ms: number): string {
    const sign = ms < 0 ? "-" : ""
    let s = Math.abs(ms) / 1000
    const units: [string, number][] = [
      ["d", 86400],
      ["h", 3600],
      ["m", 60],
      ["s", 1],
    ]
    const parts: string[] = []
    for (const [label, secs] of units) {
      if (s >= secs || (label === "s" && parts.length === 0)) {
        const v = Math.floor(s / secs)
        if (v > 0 || (label === "s" && parts.length === 0)) parts.push(`${v}${label}`)
        s -= v * secs
      }
    }
    return sign + parts.join(" ")
  }
}
