import { describe, it, expect } from "vitest"
import {
  countResuming,
  resumingNotice,
  restoreSeeds,
  deriveResumingRows,
  type ResumingSession,
  type ResumingSeed,
} from "./resumingList"

const sess = (id: string, name: string, terminals: ResumingSession["terminals"]): ResumingSession => ({
  id,
  name,
  terminals,
})

const seed = (sid: string, origId: string, sessionName: string, terminalName: string): ResumingSeed => ({
  token: `${sid}::${origId}`,
  sessionId: sid,
  originalId: origId,
  sessionName,
  terminalName,
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

describe("restoreSeeds", () => {
  it("builds one seed per dead terminal, capturing token + names", () => {
    const sessions = [
      sess("s1", "Alpha", [
        { id: "t1", name: "Worker", lastState: "dead" },
        { id: "t2", name: "Live", lastState: "active" },
      ]),
      sess("s2", "Beta", [{ id: "t3", name: "Helper", lastState: "dead" }]),
    ]
    expect(restoreSeeds(sessions)).toEqual([
      { token: "s1::t1", sessionId: "s1", originalId: "t1", sessionName: "Alpha", terminalName: "Worker" },
      { token: "s2::t3", sessionId: "s2", originalId: "t3", sessionName: "Beta", terminalName: "Helper" },
    ])
  })

  it("returns [] when nothing is dead", () => {
    expect(restoreSeeds([sess("s1", "A", [{ id: "t1", name: "x", lastState: "idle" }])])).toEqual([])
  })
})

describe("deriveResumingRows", () => {
  it("resolves the live terminal by its live id once reopen has landed", () => {
    const seeds = [seed("s1", "t1", "Alpha", "Worker"), seed("s2", "t3", "Beta", "Helper")]
    const tracked = new Set(seeds.map((s) => s.token))
    // reopen minted t1->t1b (online) and t3->t3b (still spawning/dead)
    const liveIds = new Map([
      ["s1::t1", "t1b"],
      ["s2::t3", "t3b"],
    ])
    const sessions = [
      sess("s1", "Alpha", [{ id: "t1b", name: "Worker", lastState: "active" }]),
      sess("s2", "Beta", [{ id: "t3b", name: "Helper", lastState: "dead" }]),
    ]
    expect(deriveResumingRows(sessions, tracked, seeds, liveIds)).toEqual([
      { key: "s1::t1", sessionId: "s1", terminalId: "t1b", sessionName: "Alpha", terminalName: "Worker", state: "ready" },
      { key: "s2::t3", sessionId: "s2", terminalId: "t3b", sessionName: "Beta", terminalName: "Helper", state: "resuming" },
    ])
  })

  it("preserves the original restore order even if the session list reorders", () => {
    const seeds = [seed("s1", "t1", "Alpha", "One"), seed("s2", "t2", "Beta", "Two")]
    const tracked = new Set(seeds.map((s) => s.token))
    const liveIds = new Map([
      ["s1::t1", "t1b"],
      ["s2::t2", "t2b"],
    ])
    // sessions arrive reversed
    const sessions = [
      sess("s2", "Beta", [{ id: "t2b", name: "Two", lastState: "idle" }]),
      sess("s1", "Alpha", [{ id: "t1b", name: "One", lastState: "idle" }]),
    ]
    expect(deriveResumingRows(sessions, tracked, seeds, liveIds).map((r) => r.key)).toEqual(["s1::t1", "s2::t2"])
  })

  it("shows a pending 'resuming' row from the captured name while reopen is in flight (no flash) — even after the ref is re-keyed but before its live id lands", () => {
    // The narrow window: worksession:updated already re-keyed t1 -> t1b in `sessions`,
    // but the per-token live-id map hasn't been set yet. The row must NOT drop.
    const seeds = [seed("s1", "t1", "Alpha", "Worker")]
    const tracked = new Set(["s1::t1"])
    const liveIds = new Map<string, string>() // empty: live id not recorded yet
    const sessions = [sess("s1", "Alpha", [{ id: "t1b", name: "Worker", lastState: "idle" }])]
    const rows = deriveResumingRows(sessions, tracked, seeds, liveIds)
    expect(rows).toEqual([
      { key: "s1::t1", sessionId: "s1", terminalId: "t1", sessionName: "Alpha", terminalName: "Worker", state: "resuming" },
    ])
  })

  it("REGRESSION: stopping one row does NOT re-target or drop sibling rows in the same session (id resolution, not position)", () => {
    // s1 restored 3 terminals; all online. User Stops the FIRST (t1b removed from the
    // live array + its token cleared). The other two must keep their OWN terminals.
    const seeds = [
      seed("s1", "t1", "Alpha", "One"),
      seed("s1", "t2", "Alpha", "Two"),
      seed("s1", "t3", "Alpha", "Three"),
    ]
    const liveIds = new Map([
      ["s1::t1", "t1b"],
      ["s1::t2", "t2b"],
      ["s1::t3", "t3b"],
    ])
    const tracked = new Set(["s1::t2", "s1::t3"]) // t1 cleared by Stop
    const sessions = [
      sess("s1", "Alpha", [
        // t1b filtered out by closeTerminal — the array shrank + indices shifted
        { id: "t2b", name: "Two", lastState: "idle" },
        { id: "t3b", name: "Three", lastState: "idle" },
      ]),
    ]
    const rows = deriveResumingRows(sessions, tracked, seeds, liveIds)
    // A position-keyed impl would mis-map s1::t2 -> t3b and DROP s1::t3. By id:
    expect(rows).toEqual([
      { key: "s1::t2", sessionId: "s1", terminalId: "t2b", sessionName: "Alpha", terminalName: "Two", state: "ready" },
      { key: "s1::t3", sessionId: "s1", terminalId: "t3b", sessionName: "Alpha", terminalName: "Three", state: "ready" },
    ])
  })

  it("REGRESSION: a partial reopen failure (live array shorter than the token list) does not mis-pair the surviving tokens", () => {
    // t1 failed to reopen (no live id, ref gone); only t2 came back as t2b.
    const seeds = [seed("s1", "t1", "Alpha", "One"), seed("s1", "t2", "Alpha", "Two")]
    const tracked = new Set(["s1::t1", "s1::t2"])
    const liveIds = new Map([["s1::t2", "t2b"]])
    const sessions = [sess("s1", "Alpha", [{ id: "t2b", name: "Two", lastState: "idle" }])]
    const rows = deriveResumingRows(sessions, tracked, seeds, liveIds)
    // t1 resolves to ITSELF (captured name, still "resuming"), NOT onto t2b.
    expect(rows).toEqual([
      { key: "s1::t1", sessionId: "s1", terminalId: "t1", sessionName: "Alpha", terminalName: "One", state: "resuming" },
      { key: "s1::t2", sessionId: "s1", terminalId: "t2b", sessionName: "Alpha", terminalName: "Two", state: "ready" },
    ])
  })

  it("drops only the row whose online terminal was later closed/removed — siblings untouched", () => {
    const seeds = [seed("s1", "t1", "Alpha", "One"), seed("s1", "t2", "Alpha", "Two")]
    const tracked = new Set(["s1::t1", "s1::t2"])
    const liveIds = new Map([
      ["s1::t1", "t1b"],
      ["s1::t2", "t2b"],
    ])
    // t1b was closed (removed) but its token wasn't cleared (e.g. closed via Ctrl+W).
    const sessions = [sess("s1", "Alpha", [{ id: "t2b", name: "Two", lastState: "idle" }])]
    const rows = deriveResumingRows(sessions, tracked, seeds, liveIds)
    expect(rows.map((r) => r.key)).toEqual(["s1::t2"])
    expect(rows[0].terminalId).toBe("t2b")
  })

  it("a handed-off terminal (live id present but ref dead) shows 'resuming' keyed to itself, never onto a sibling", () => {
    const seeds = [seed("s1", "t1", "Alpha", "One")]
    const tracked = new Set(["s1::t1"])
    const liveIds = new Map([["s1::t1", "t1b"]])
    // handoff kept the old dead ref t1b in the array and pushed a fresh t1c
    const sessions = [
      sess("s1", "Alpha", [
        { id: "t1b", name: "One", lastState: "dead" },
        { id: "t1c", name: "One", lastState: "idle" },
      ]),
    ]
    const rows = deriveResumingRows(sessions, tracked, seeds, liveIds)
    expect(rows).toEqual([
      { key: "s1::t1", sessionId: "s1", terminalId: "t1b", sessionName: "Alpha", terminalName: "One", state: "resuming" },
    ])
  })

  it("drops a token no longer tracked (focused/dismissed/stopped) — self-closing", () => {
    const seeds = [seed("s1", "t1", "Alpha", "One"), seed("s1", "t2", "Alpha", "Two")]
    const liveIds = new Map([
      ["s1::t1", "t1b"],
      ["s1::t2", "t2b"],
    ])
    const tracked = new Set(["s1::t2"]) // first cleared
    const sessions = [
      sess("s1", "Alpha", [
        { id: "t1b", name: "One", lastState: "idle" },
        { id: "t2b", name: "Two", lastState: "idle" },
      ]),
    ]
    const rows = deriveResumingRows(sessions, tracked, seeds, liveIds)
    expect(rows.map((r) => r.key)).toEqual(["s1::t2"])
    expect(rows[0].terminalId).toBe("t2b")
  })

  it("drops a row whose session was killed mid-restore", () => {
    const seeds = [seed("s1", "t1", "Alpha", "One")]
    const tracked = new Set(["s1::t1"])
    expect(deriveResumingRows([], tracked, seeds, new Map())).toEqual([])
  })

  it("returns [] when nothing is tracked", () => {
    const seeds = [seed("s1", "t1", "A", "x")]
    const sessions = [sess("s1", "A", [{ id: "t1b", name: "x", lastState: "idle" }])]
    expect(deriveResumingRows(sessions, new Set(), seeds, new Map([["s1::t1", "t1b"]]))).toEqual([])
  })
})
