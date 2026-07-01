import { describe, it, expect } from "vitest"
import { recurrenceSummary, nextRunText, lastRun, runStatusTone } from "./scheduleRow"
import type { Recurrence } from "../../electron/services/scheduleMath"

describe("recurrenceSummary", () => {
  it("summarizes an interval with a window and days (the fable-watch shape)", () => {
    const r: Recurrence = { kind: "interval", everyMinutes: 20, window: { start: "08:00", end: "22:00" } }
    expect(recurrenceSummary(r)).toBe("every 20m · 08:00–22:00")
  })
  it("formats whole-hour intervals as hours and lists days", () => {
    const r: Recurrence = { kind: "interval", everyMinutes: 120, days: [1, 3, 5] }
    expect(recurrenceSummary(r)).toBe("every 2h · Mon,Wed,Fri")
  })
  it("summarizes a daily schedule", () => {
    expect(recurrenceSummary({ kind: "daily", at: "09:00" })).toBe("daily 09:00")
  })
  it("summarizes a one-shot", () => {
    const at = new Date(2026, 5, 1, 10, 5)
    expect(recurrenceSummary({ kind: "once", at: at.toISOString() })).toBe("once · Jun 1 10:05")
  })
})

describe("nextRunText", () => {
  it("reflects the shared countdown math", () => {
    const now = new Date(2026, 0, 5, 9, 0)
    expect(nextRunText({ enabled: true, nextRunAt: new Date(2026, 0, 5, 9, 14).toISOString() }, now)).toBe("in 14m")
    expect(nextRunText({ enabled: false, nextRunAt: null }, now)).toBe("paused")
  })
})

describe("lastRun / runStatusTone", () => {
  it("returns the newest run record (or undefined)", () => {
    expect(lastRun(undefined)).toBeUndefined()
    expect(lastRun([])).toBeUndefined()
    expect(lastRun([{ at: "x", status: "ok" }, { at: "y", status: "error" }])?.status).toBe("ok")
  })
  it("maps statuses to tones", () => {
    expect(runStatusTone("ok")).toBe("ok")
    expect(runStatusTone("error")).toBe("error")
    expect(runStatusTone("timeout")).toBe("error")
    expect(runStatusTone("killed")).toBe("error")
    expect(runStatusTone("skipped-overlap")).toBe("skipped")
    expect(runStatusTone("skipped-missed")).toBe("skipped")
  })
})
