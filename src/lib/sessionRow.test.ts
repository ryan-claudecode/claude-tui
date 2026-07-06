import { describe, it, expect } from "vitest"
import { deriveSessionRow } from "./sessionRow"

describe("deriveSessionRow", () => {
  it("empty session: idle dot, zero count, Empty activity", () => {
    expect(deriveSessionRow({ status: "running", terminals: [] })).toEqual({
      dot: "idle", count: 0, activity: "Empty", background: 0,
    })
  })

  it("stopped session: dead dot, Stopped activity regardless of terminals", () => {
    expect(
      deriveSessionRow({ status: "stopped", terminals: [{ lastState: "active", activity: "x" }] }),
    ).toEqual({ dot: "dead", count: 1, activity: "Stopped", background: 0 })
  })

  it("active terminal: active dot, count, and its activity string surfaces", () => {
    expect(
      deriveSessionRow({
        status: "running",
        terminals: [
          { lastState: "idle", activity: "old" },
          { lastState: "active", activity: "Edit(auth.ts)" },
        ],
      }),
    ).toEqual({ dot: "active", count: 2, activity: "Edit(auth.ts)", background: 0 })
  })

  it("active terminal with no activity string falls back to Working", () => {
    expect(
      deriveSessionRow({ status: "running", terminals: [{ lastState: "active" }] }),
    ).toEqual({ dot: "active", count: 1, activity: "Working", background: 0 })
  })

  it("all idle: idle dot and Idle activity", () => {
    expect(
      deriveSessionRow({ status: "running", terminals: [{ lastState: "idle", activity: "x" }] }),
    ).toEqual({ dot: "idle", count: 1, activity: "Idle", background: 0 })
  })

  // BACKGROUND WORK — background tasks running after the foreground turn ended: the dot
  // stays GREEN (not idle), the total is surfaced for the ⚙ N badge, and the activity
  // line reads "Working in background".
  it("idle terminal with background tasks: GREEN dot, background count, bg activity", () => {
    expect(
      deriveSessionRow({
        status: "running",
        terminals: [{ lastState: "idle", activity: "old", backgroundCount: 2 }],
      }),
    ).toEqual({ dot: "active", count: 1, activity: "Working in background", background: 2 })
  })

  it("sums background tasks across terminals", () => {
    expect(
      deriveSessionRow({
        status: "running",
        terminals: [
          { lastState: "idle", backgroundCount: 3 },
          { lastState: "idle", backgroundCount: 1 },
        ],
      }).background,
    ).toBe(4)
  })

  it("an actively-working terminal still shows its live activity (not the bg line)", () => {
    // Foreground work takes precedence for the activity LINE; the badge count still rides along.
    expect(
      deriveSessionRow({
        status: "running",
        terminals: [{ lastState: "active", activity: "Grep(x)", backgroundCount: 1 }],
      }),
    ).toEqual({ dot: "active", count: 1, activity: "Grep(x)", background: 1 })
  })

  it("a stopped session never reads as background-active", () => {
    expect(
      deriveSessionRow({
        status: "stopped",
        terminals: [{ lastState: "dead", backgroundCount: 2 }],
      }),
    ).toEqual({ dot: "dead", count: 1, activity: "Stopped", background: 2 })
  })
})
