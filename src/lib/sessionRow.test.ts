import { describe, it, expect } from "vitest"
import { deriveSessionRow } from "./sessionRow"

describe("deriveSessionRow", () => {
  it("empty session: idle dot, zero count, Empty activity", () => {
    expect(deriveSessionRow({ status: "running", terminals: [] })).toEqual({
      dot: "idle", count: 0, activity: "Empty",
    })
  })

  it("stopped session: dead dot, Stopped activity regardless of terminals", () => {
    expect(
      deriveSessionRow({ status: "stopped", terminals: [{ lastState: "active", activity: "x" }] }),
    ).toEqual({ dot: "dead", count: 1, activity: "Stopped" })
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
    ).toEqual({ dot: "active", count: 2, activity: "Edit(auth.ts)" })
  })

  it("active terminal with no activity string falls back to Working", () => {
    expect(
      deriveSessionRow({ status: "running", terminals: [{ lastState: "active" }] }),
    ).toEqual({ dot: "active", count: 1, activity: "Working" })
  })

  it("all idle: idle dot and Idle activity", () => {
    expect(
      deriveSessionRow({ status: "running", terminals: [{ lastState: "idle", activity: "x" }] }),
    ).toEqual({ dot: "idle", count: 1, activity: "Idle" })
  })
})
