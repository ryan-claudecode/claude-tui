import { describe, it, expect } from "vitest"
import { computeNextRun, isDue, describeNext, type Recurrence } from "./scheduleMath"

// All construction uses LOCAL components (new Date(y, m, d, hh, mm)) so the
// window/day assertions are timezone-independent — the math is defined in local
// time and we compare local times. The DST block pins TZ explicitly.

// 2026-01-01 is a Thursday, so 2026-01-05 is a Monday (used by the day-filter cases).
const mon = (day: number, hh: number, mm = 0) => new Date(2026, 0, day, hh, mm)

describe("computeNextRun — interval (the fable-watch shape)", () => {
  const fable: Recurrence = {
    kind: "interval",
    everyMinutes: 20,
    window: { start: "08:00", end: "22:00" },
  }

  it("steps by everyMinutes anchored to the last fire", () => {
    const next = computeNextRun(fable, mon(5, 12, 0))!
    expect(next.getTime()).toBe(mon(5, 12, 20).getTime())
  })

  it("carries the anchor's cadence (not wall-clock minute 0)", () => {
    const next = computeNextRun(fable, mon(5, 12, 3))!
    expect(next.getTime()).toBe(mon(5, 12, 23).getTime())
  })

  it("fires exactly at the inclusive window end", () => {
    const next = computeNextRun(fable, mon(5, 21, 40))!
    expect(next.getTime()).toBe(mon(5, 22, 0).getTime())
  })

  it("rolls a fire past the window end to the NEXT day's window start", () => {
    const next = computeNextRun(fable, mon(5, 21, 50))!
    expect(next.getTime()).toBe(mon(6, 8, 0).getTime())
  })

  it("rolls a fire before the window start UP to today's window start", () => {
    const next = computeNextRun(fable, mon(5, 7, 0))!
    expect(next.getTime()).toBe(mon(5, 8, 0).getTime())
  })

  it("with no window, steps freely across midnight", () => {
    const r: Recurrence = { kind: "interval", everyMinutes: 30 }
    const next = computeNextRun(r, mon(5, 23, 45))!
    expect(next.getTime()).toBe(mon(6, 0, 15).getTime())
  })

  it("returns null for a non-positive interval", () => {
    expect(computeNextRun({ kind: "interval", everyMinutes: 0 }, mon(5, 12, 0))).toBeNull()
  })
})

describe("computeNextRun — interval day filter (day-skip)", () => {
  it("rolls to the next allowed weekday's window start", () => {
    // Monday-only, hourly 09:00–17:00. A fire past 17:00 on Monday rolls to next Monday.
    const r: Recurrence = {
      kind: "interval",
      everyMinutes: 60,
      window: { start: "09:00", end: "17:00" },
      days: [1], // Monday
    }
    const next = computeNextRun(r, mon(5, 16, 30))! // Mon 16:30 → +60 = 17:30 (out)
    expect(next.getTime()).toBe(mon(12, 9, 0).getTime()) // the following Monday 09:00
  })

  it("empty days array behaves as every day (never strands)", () => {
    const r: Recurrence = { kind: "interval", everyMinutes: 20, days: [] }
    expect(computeNextRun(r, mon(5, 12, 0))).not.toBeNull()
  })
})

describe("computeNextRun — wrap-around (midnight-straddling) window", () => {
  // The overnight-watch shape: start > end means the window spans midnight.
  const overnight: Recurrence = {
    kind: "interval",
    everyMinutes: 40,
    window: { start: "22:00", end: "06:00" },
  }

  it("steps across midnight INSIDE the window (23:40 + 40m = 00:20 stays in)", () => {
    const next = computeNextRun(overnight, mon(5, 23, 40))!
    expect(next.getTime()).toBe(mon(6, 0, 20).getTime())
  })

  it("a candidate past the wrap end rolls to the SAME day's window start (06:10 → 22:00)", () => {
    const r: Recurrence = { kind: "interval", everyMinutes: 20, window: { start: "22:00", end: "06:00" } }
    const next = computeNextRun(r, mon(5, 5, 50))! // cand 06:10, out of window
    expect(next.getTime()).toBe(mon(5, 22, 0).getTime())
  })

  it("fires exactly at the inclusive wrap end (06:00)", () => {
    const r: Recurrence = { kind: "interval", everyMinutes: 20, window: { start: "22:00", end: "06:00" } }
    const next = computeNextRun(r, mon(5, 5, 40))!
    expect(next.getTime()).toBe(mon(5, 6, 0).getTime())
  })

  it("the days filter applies to the day the candidate LANDS on", () => {
    // Friday-only overnight window: Fri 23:40 + 40m lands SATURDAY 00:20 →
    // disallowed → rolls to the NEXT Friday's window start. 2026-01-02 is a
    // Friday; 2026-01-09 is the next Friday.
    const r: Recurrence = {
      kind: "interval",
      everyMinutes: 40,
      window: { start: "22:00", end: "06:00" },
      days: [5], // Friday
    }
    const next = computeNextRun(r, mon(2, 23, 40))!
    expect(next.getTime()).toBe(mon(9, 22, 0).getTime())
  })

  it("a wrap-around window NEVER yields null (the silent never-fires bug)", () => {
    expect(computeNextRun(overnight, mon(5, 12, 0))).not.toBeNull()
  })
})

describe("computeNextRun — daily", () => {
  it("fires today at the time when it's still ahead", () => {
    const r: Recurrence = { kind: "daily", at: "14:30" }
    const next = computeNextRun(r, mon(5, 9, 0))!
    expect(next.getTime()).toBe(mon(5, 14, 30).getTime())
  })

  it("rolls to tomorrow once today's time has passed", () => {
    const r: Recurrence = { kind: "daily", at: "08:00" }
    const next = computeNextRun(r, mon(5, 9, 0))!
    expect(next.getTime()).toBe(mon(6, 8, 0).getTime())
  })

  it("skips disallowed weekdays (Mon/Wed/Fri only)", () => {
    const r: Recurrence = { kind: "daily", at: "09:00", days: [1, 3, 5] }
    // Mon 10:00 → today's 09:00 passed → Tue (skip) → Wed 2026-01-07 09:00.
    const next = computeNextRun(r, mon(5, 10, 0))!
    expect(next.getTime()).toBe(mon(7, 9, 0).getTime())
  })

  it("returns null for a malformed time", () => {
    expect(computeNextRun({ kind: "daily", at: "25:99" }, mon(5, 9, 0))).toBeNull()
  })
})

describe("computeNextRun — once", () => {
  it("returns the instant when it is in the future", () => {
    const at = new Date(2026, 5, 1, 10, 0)
    const r: Recurrence = { kind: "once", at: at.toISOString() }
    const next = computeNextRun(r, new Date(2026, 4, 1, 0, 0))!
    expect(next.getTime()).toBe(at.getTime())
  })

  it("returns null when it is in the past (exhausted)", () => {
    const at = new Date(2026, 0, 1, 10, 0)
    const r: Recurrence = { kind: "once", at: at.toISOString() }
    expect(computeNextRun(r, new Date(2026, 0, 2, 0, 0))).toBeNull()
  })
})

describe("computeNextRun — DST spring-forward (local-time correctness)", () => {
  it("resolves a skipped local wall-clock time forward to the next valid instant", () => {
    const orig = process.env.TZ
    process.env.TZ = "America/New_York"
    try {
      // 2026-03-08 02:00→03:00 is the US spring-forward; 02:30 does not exist.
      const r: Recurrence = { kind: "daily", at: "02:30" }
      const from = new Date(2026, 2, 8, 1, 0) // 01:00 EST, before the gap
      const next = computeNextRun(r, from)!
      expect(next).not.toBeNull()
      expect(Number.isNaN(next.getTime())).toBe(false)
      expect(next.getTime()).toBeGreaterThan(from.getTime())
      // The nonexistent 02:30 normalizes forward to 03:30 EDT.
      expect(next.getHours()).toBe(3)
      expect(next.getMinutes()).toBe(30)
    } finally {
      // Restore precisely: assigning `undefined` would set the literal string
      // "undefined" and corrupt every later test's local-time construction.
      if (orig === undefined) delete process.env.TZ
      else process.env.TZ = orig
    }
  })
})

describe("isDue", () => {
  const now = mon(5, 12, 0)
  it("is true when enabled and nextRunAt is at/before now", () => {
    expect(isDue({ enabled: true, nextRunAt: mon(5, 11, 59).toISOString() }, now)).toBe(true)
  })
  it("is false when nextRunAt is in the future", () => {
    expect(isDue({ enabled: true, nextRunAt: mon(5, 12, 1).toISOString() }, now)).toBe(false)
  })
  it("is false when disabled", () => {
    expect(isDue({ enabled: false, nextRunAt: mon(5, 11, 0).toISOString() }, now)).toBe(false)
  })
  it("is false when exhausted (nextRunAt null)", () => {
    expect(isDue({ enabled: true, nextRunAt: null }, now)).toBe(false)
  })
})

describe("describeNext", () => {
  const now = mon(5, 9, 0)
  it("reports paused when disabled", () => {
    expect(describeNext({ enabled: false, nextRunAt: mon(5, 10, 0).toISOString() }, now)).toBe("paused")
  })
  it("reports done when exhausted", () => {
    expect(describeNext({ enabled: true, nextRunAt: null }, now)).toBe("done")
  })
  it("reports 'due now' at/after the fire time", () => {
    expect(describeNext({ enabled: true, nextRunAt: mon(5, 9, 0).toISOString() }, now)).toBe("due now")
  })
  it("reports minutes for a soon fire", () => {
    expect(describeNext({ enabled: true, nextRunAt: mon(5, 9, 14).toISOString() }, now)).toBe("in 14m")
  })
  it("reports '<1m' for a sub-minute fire (never 'in 0m')", () => {
    const at = new Date(2026, 0, 5, 9, 0, 0)
    const next = new Date(2026, 0, 5, 9, 0, 20) // 20s away: diff > 0, rounds to 0m
    expect(describeNext({ enabled: true, nextRunAt: next.toISOString() }, at)).toBe("<1m")
  })
  it("reports 'at HH:mm' later the same day", () => {
    expect(describeNext({ enabled: true, nextRunAt: mon(5, 14, 30).toISOString() }, now)).toBe("at 14:30")
  })
  it("reports 'tomorrow HH:mm' the next day", () => {
    const late = mon(5, 23, 0)
    expect(describeNext({ enabled: true, nextRunAt: mon(6, 8, 0).toISOString() }, late)).toBe("tomorrow 08:00")
  })
  it("reports '{Weekday} HH:mm' for a fire 2–6 days out", () => {
    // now = Mon Jan 5; Jan 8 is a Thursday, 3 calendar days out → unambiguous weekday.
    expect(describeNext({ enabled: true, nextRunAt: mon(8, 9, 30).toISOString() }, now)).toBe("Thu 09:30")
    // The upper edge (6 days out): Jan 11 is a Sunday.
    expect(describeNext({ enabled: true, nextRunAt: mon(11, 8, 0).toISOString() }, now)).toBe("Sun 08:00")
  })
  it("reports 'in Nd' for a fire a week or more out (weekday would be ambiguous)", () => {
    // 7 days out (Jan 12) and 10 days out (Jan 15) fall back to the day count.
    expect(describeNext({ enabled: true, nextRunAt: mon(12, 9, 0).toISOString() }, now)).toBe("in 7d")
    expect(describeNext({ enabled: true, nextRunAt: mon(15, 9, 0).toISOString() }, now)).toBe("in 10d")
  })
})
