import { describe, it, expect } from "vitest"
import {
  goalExcerpt,
  missionProgress,
  isMissionActive,
  isMissionDismissable,
} from "./missionRow"

describe("goalExcerpt", () => {
  it("passes through short goals unchanged", () => {
    expect(goalExcerpt("Build a search feature")).toBe("Build a search feature")
  })

  it("truncates at maxLen with ellipsis", () => {
    const long = "A".repeat(60)
    const result = goalExcerpt(long, 48)
    expect(result).toHaveLength(48)
    expect(result.endsWith("…")).toBe(true)
  })

  it("collapses whitespace before truncating", () => {
    const messy = "foo   bar   baz"
    expect(goalExcerpt(messy)).toBe("foo bar baz")
  })

  it("returns exactly maxLen chars when input is exactly maxLen (no truncation)", () => {
    const exact = "x".repeat(48)
    expect(goalExcerpt(exact, 48)).toBe(exact)
  })

  it("uses default maxLen of 48", () => {
    const long = "Z".repeat(100)
    const result = goalExcerpt(long)
    expect(result).toHaveLength(48)
    expect(result.endsWith("…")).toBe(true)
  })
})

describe("missionProgress", () => {
  it("returns zeros for undefined tasks", () => {
    expect(missionProgress(undefined)).toEqual({ done: 0, total: 0, pct: 0 })
  })

  it("returns zeros for empty tasks array", () => {
    expect(missionProgress([])).toEqual({ done: 0, total: 0, pct: 0 })
  })

  it("counts done tasks and computes rounded pct", () => {
    const tasks = [
      { status: "done" },
      { status: "done" },
      { status: "done" },
      { status: "pending" },
      { status: "in-progress" },
      { status: "failed" },
    ]
    const result = missionProgress(tasks)
    expect(result.done).toBe(3)
    expect(result.total).toBe(6)
    expect(result.pct).toBe(50)
  })

  it("returns 100 pct when all tasks are done", () => {
    const tasks = [{ status: "done" }, { status: "done" }]
    expect(missionProgress(tasks)).toEqual({ done: 2, total: 2, pct: 100 })
  })

  it("returns 0 pct when no tasks are done", () => {
    const tasks = [{ status: "pending" }, { status: "assigned" }]
    const result = missionProgress(tasks)
    expect(result.done).toBe(0)
    expect(result.pct).toBe(0)
  })

  it("rounds fractional percentages", () => {
    // 1/3 = 33.3... → rounds to 33
    const tasks = [{ status: "done" }, { status: "pending" }, { status: "pending" }]
    expect(missionProgress(tasks).pct).toBe(33)
  })
})

describe("isMissionActive", () => {
  it("returns true for active statuses", () => {
    expect(isMissionActive("planning")).toBe(true)
    expect(isMissionActive("running")).toBe(true)
    expect(isMissionActive("paused")).toBe(true)
  })

  it("returns false for terminal statuses", () => {
    expect(isMissionActive("done")).toBe(false)
    expect(isMissionActive("blocked")).toBe(false)
    expect(isMissionActive("stopped")).toBe(false)
  })
})

describe("isMissionDismissable", () => {
  it("returns true only for terminal statuses", () => {
    expect(isMissionDismissable("done")).toBe(true)
    expect(isMissionDismissable("blocked")).toBe(true)
    expect(isMissionDismissable("stopped")).toBe(true)
  })

  it("returns false for active statuses", () => {
    expect(isMissionDismissable("planning")).toBe(false)
    expect(isMissionDismissable("running")).toBe(false)
    expect(isMissionDismissable("paused")).toBe(false)
  })
})
