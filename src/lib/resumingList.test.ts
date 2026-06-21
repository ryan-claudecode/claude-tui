import { describe, it, expect } from "vitest"
import {
  countResuming,
  resumingNotice,
  restoreTokens,
  deriveResumingRows,
  type ResumingSession,
} from "./resumingList"

const sess = (id: string, name: string, terminals: ResumingSession["terminals"]): ResumingSession => ({
  id,
  name,
  terminals,
})

describe("countResuming", () => {
  it("counts every dead terminal across sessions", () => {
    const sessions = [
      sess("s1", "A", [
        { id: "t1", name: "term-1", lastState: "dead" },
        { id: "t2", name: "term-2", lastState: "dead" },
      ]),
      sess("s2", "B", [{ id: "t3", name: "term-3", lastState: "dead" }]),
    ]
    expect(countResuming(sessions)).toBe(3)
  })

  it("ignores live (active/idle) terminals", () => {
    const sessions = [
      sess("s1", "A", [
        { id: "t1", name: "term-1", lastState: "active" },
        { id: "t2", name: "term-2", lastState: "idle" },
        { id: "t3", name: "term-3", lastState: "dead" },
      ]),
    ]
    expect(countResuming(sessions)).toBe(1)
  })

  it("returns 0 for no sessions / no dead terminals", () => {
    expect(countResuming([])).toBe(0)
    expect(countResuming([sess("s1", "A", [{ id: "t1", name: "x", lastState: "active" }])])).toBe(0)
  })
})

describe("resumingNotice", () => {
  it("returns null for N === 0 (no toast)", () => {
    expect(resumingNotice(0)).toBeNull()
    expect(resumingNotice(-1)).toBeNull()
  })

  it("uses the singular form for one agent", () => {
    expect(resumingNotice(1)).toBe("Resuming 1 background agent")
  })

  it("pluralizes for many agents", () => {
    expect(resumingNotice(3)).toBe("Resuming 3 background agents")
  })
})

describe("restoreTokens", () => {
  it("builds one token per dead terminal, keyed session::terminal", () => {
    const sessions = [
      sess("s1", "A", [
        { id: "t1", name: "term-1", lastState: "dead" },
        { id: "t2", name: "term-2", lastState: "active" },
      ]),
      sess("s2", "B", [{ id: "t3", name: "term-3", lastState: "dead" }]),
    ]
    expect(restoreTokens(sessions)).toEqual(["s1::t1", "s2::t3"])
  })

  it("returns [] when nothing is dead", () => {
    expect(restoreTokens([sess("s1", "A", [{ id: "t1", name: "x", lastState: "idle" }])])).toEqual([])
  })
})

describe("deriveResumingRows", () => {
  it("derives a row per tracked token, resolving the live terminal by position", () => {
    // Post-reopen: the live terminal ids changed (t1 -> t1b), but the token still
    // resolves by position within the session.
    const sessions = [
      sess("s1", "Alpha", [{ id: "t1b", name: "Worker", lastState: "active" }]),
      sess("s2", "Beta", [{ id: "t3b", name: "Helper", lastState: "dead" }]),
    ]
    const order = ["s1::t1", "s2::t3"]
    const tracked = new Set(order)
    const rows = deriveResumingRows(sessions, tracked, order)
    expect(rows).toEqual([
      { key: "s1::t1", sessionId: "s1", terminalId: "t1b", sessionName: "Alpha", terminalName: "Worker", state: "ready" },
      { key: "s2::t3", sessionId: "s2", terminalId: "t3b", sessionName: "Beta", terminalName: "Helper", state: "resuming" },
    ])
  })

  it("preserves the original restore order even if the session list reorders", () => {
    const order = ["s1::t1", "s2::t2"]
    const tracked = new Set(order)
    // sessions arrive reversed
    const sessions = [
      sess("s2", "Beta", [{ id: "t2b", name: "Two", lastState: "idle" }]),
      sess("s1", "Alpha", [{ id: "t1b", name: "One", lastState: "idle" }]),
    ]
    const rows = deriveResumingRows(sessions, tracked, order)
    expect(rows.map((r) => r.key)).toEqual(["s1::t1", "s2::t2"])
  })

  it("drops a token no longer tracked (focused/dismissed) — self-closing", () => {
    const sessions = [
      sess("s1", "Alpha", [
        { id: "t1b", name: "One", lastState: "idle" },
        { id: "t2b", name: "Two", lastState: "idle" },
      ]),
    ]
    const order = ["s1::t1", "s1::t2"]
    const tracked = new Set(["s1::t2"]) // first one cleared
    const rows = deriveResumingRows(sessions, tracked, order)
    expect(rows.map((r) => r.key)).toEqual(["s1::t2"])
    expect(rows[0].terminalId).toBe("t2b")
  })

  it("drops a row whose session was killed mid-restore", () => {
    const order = ["s1::t1"]
    const tracked = new Set(order)
    const rows = deriveResumingRows([], tracked, order)
    expect(rows).toEqual([])
  })

  it("returns [] when nothing is tracked", () => {
    const sessions = [sess("s1", "A", [{ id: "t1b", name: "x", lastState: "idle" }])]
    expect(deriveResumingRows(sessions, new Set(), ["s1::t1"])).toEqual([])
  })
})
