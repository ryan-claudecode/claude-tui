import { describe, it, expect } from "vitest"
import type { StreamEvent } from "../../electron/services/streamProtocol"
import {
  createTranscriptStore,
  mergeSeededHistory,
} from "./transcriptStore"
import {
  emptyTranscript,
  reduceTranscript,
  type TranscriptBlock,
  type TranscriptState,
} from "./agentTranscript"

/**
 * THE TRUST BUG (switched-away transcript loss). The renderer transcript store is
 * the always-on fold that lives as long as the window, so a terminal's stream keeps
 * being captured even while its AgentView is unmounted (the user switched sessions).
 * These tests are the DOM-free / Electron-free seam (the same pattern as
 * transcriptWindow.ts, scrollStick.ts): pure store + merge math, no React.
 */

// Minimal StreamEvent constructors — the store folds these through the SAME
// reduceTranscript the component used, so we only need the shapes the reducer reads.
const userMsg = (text: string): StreamEvent => ({ kind: "user_message", text })
const asstDelta = (text: string): StreamEvent => ({ kind: "assistant_delta", text })
const result = (text: string): StreamEvent =>
  ({ kind: "result", isError: false, subtype: "success", result: text, raw: {} }) as StreamEvent

/** Fold a list of events into a TranscriptState the way a mounted AgentView would. */
function fold(events: StreamEvent[]): TranscriptState {
  return events.reduce(reduceTranscript, emptyTranscript())
}

/** The rendered "shape" of a state, ignoring the seq-minted block ids (which the
 *  merge renumbers) — compare by kind + text so tests assert content, not ids. */
function shape(state: TranscriptState): Array<{ kind: string; text?: string }> {
  return state.blocks.map((b) => {
    const t = (b as { text?: string }).text
    return t !== undefined ? { kind: b.kind, text: t } : { kind: b.kind }
  })
}

describe("createTranscriptStore — ingest retention (the switched-away case)", () => {
  it("retains events ingested with NO subscriber and returns them from get()", () => {
    const store = createTranscriptStore()
    // No one is subscribed — mimics the user having switched to another session so
    // this terminal's AgentView is unmounted. The events must NOT be dropped.
    store.ingest({ terminalId: "t1", event: userMsg("hi") })
    store.ingest({ terminalId: "t1", event: asstDelta("fake agent ") })
    store.ingest({ terminalId: "t1", event: asstDelta("reply") })
    store.ingest({ terminalId: "t1", event: result("fake agent reply") })

    const state = store.get("t1")
    expect(shape(state)).toEqual([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "fake agent reply" },
      { kind: "result", text: undefined }, // echo of the assistant text → dropped
    ])
  })

  it("keeps per-terminal state isolated", () => {
    const store = createTranscriptStore()
    store.ingest({ terminalId: "a", event: userMsg("alpha") })
    store.ingest({ terminalId: "b", event: userMsg("beta") })
    expect(shape(store.get("a"))).toEqual([{ kind: "user", text: "alpha" }])
    expect(shape(store.get("b"))).toEqual([{ kind: "user", text: "beta" }])
  })

  it("returns a STABLE empty snapshot reference for an unknown terminal (no render loop)", () => {
    const store = createTranscriptStore()
    // useSyncExternalStore compares snapshots with Object.is — a fresh object each
    // call would loop forever. The empty snapshot must be referentially stable.
    expect(store.get("missing")).toBe(store.get("missing"))
    expect(store.get("missing").blocks).toEqual([])
  })

  it("returns a STABLE state reference between ingests, a NEW one after a change", () => {
    const store = createTranscriptStore()
    store.ingest({ terminalId: "t", event: userMsg("hi") })
    const s1 = store.get("t")
    const s2 = store.get("t")
    expect(s1).toBe(s2) // no change between reads → same ref (snapshot stability)
    store.ingest({ terminalId: "t", event: asstDelta("yo") })
    expect(store.get("t")).not.toBe(s1) // a fold happened → new ref
  })
})

describe("createTranscriptStore — subscribe / notify / dispose", () => {
  it("notifies the terminal's subscriber on ingest and bumps its version", () => {
    const store = createTranscriptStore()
    let calls = 0
    const dispose = store.subscribe("t1", () => {
      calls++
    })
    const v0 = store.getVersion("t1")
    store.ingest({ terminalId: "t1", event: userMsg("hi") })
    expect(calls).toBe(1)
    expect(store.getVersion("t1")).toBeGreaterThan(v0)
    dispose()
    store.ingest({ terminalId: "t1", event: asstDelta("more") })
    expect(calls).toBe(1) // disposed → no further notifications
  })

  it("only notifies subscribers of the SAME terminal", () => {
    const store = createTranscriptStore()
    let aCalls = 0
    let bCalls = 0
    store.subscribe("a", () => aCalls++)
    store.subscribe("b", () => bCalls++)
    store.ingest({ terminalId: "a", event: userMsg("x") })
    expect(aCalls).toBe(1)
    expect(bCalls).toBe(0)
  })

  it("supports multiple subscribers on one terminal and independent disposal", () => {
    const store = createTranscriptStore()
    let first = 0
    let second = 0
    const d1 = store.subscribe("t", () => first++)
    store.subscribe("t", () => second++)
    store.ingest({ terminalId: "t", event: userMsg("x") })
    expect(first).toBe(1)
    expect(second).toBe(1)
    d1()
    store.ingest({ terminalId: "t", event: asstDelta("y") })
    expect(first).toBe(1) // disposed
    expect(second).toBe(2)
  })
})

describe("createTranscriptStore — remove (GC)", () => {
  it("drops a terminal's state and stops notifying its listeners", () => {
    const store = createTranscriptStore()
    let calls = 0
    store.subscribe("t", () => calls++)
    store.ingest({ terminalId: "t", event: userMsg("hi") })
    expect(shape(store.get("t"))).toHaveLength(1)
    store.remove("t")
    expect(store.get("t").blocks).toEqual([]) // gone
    store.ingest({ terminalId: "t", event: userMsg("again") })
    // A post-remove ingest starts fresh; the OLD listener set was cleared so it is
    // not notified for the resurrected entry.
    expect(calls).toBe(1)
  })

  it("gc() drops every terminal not in the live set, keeps the live ones", () => {
    const store = createTranscriptStore()
    store.ingest({ terminalId: "keep", event: userMsg("stay") })
    store.ingest({ terminalId: "drop", event: userMsg("gone") })
    store.gc(new Set(["keep"]))
    expect(shape(store.get("keep"))).toEqual([{ kind: "user", text: "stay" }])
    expect(store.get("drop").blocks).toEqual([]) // GC'd
  })
})

describe("createTranscriptStore — seedHistory", () => {
  it("seeds history beneath live blocks and is idempotent (seeding twice does not double)", () => {
    const store = createTranscriptStore()
    // Live user turn arrived first (while unmounted), THEN we seed prior history.
    store.ingest({ terminalId: "t", event: userMsg("new turn") })
    const seeded = fold([userMsg("old q"), asstDelta("old answer"), result("old answer")])

    store.seedHistory("t", seeded)
    const afterFirst = shape(store.get("t"))
    expect(afterFirst).toEqual([
      { kind: "user", text: "old q" },
      { kind: "assistant", text: "old answer" },
      { kind: "result", text: undefined },
      { kind: "user", text: "new turn" },
    ])

    // Seeding again must be a no-op (guarded by a per-terminal seeded flag).
    store.seedHistory("t", seeded)
    expect(shape(store.get("t"))).toEqual(afterFirst)
  })

  it("seeds into an empty (never-live) terminal", () => {
    const store = createTranscriptStore()
    const seeded = fold([userMsg("old"), asstDelta("answer")])
    store.seedHistory("t", seeded)
    expect(shape(store.get("t"))).toEqual([
      { kind: "user", text: "old" },
      { kind: "assistant", text: "answer" },
    ])
  })

  it("gives merged blocks UNIQUE ids so React keys never collide", () => {
    const store = createTranscriptStore()
    store.ingest({ terminalId: "t", event: userMsg("live") })
    store.seedHistory("t", fold([userMsg("old"), asstDelta("answer")]))
    const ids = store.get("t").blocks.map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("keeps folding live events correctly after a seed (no id collision with new blocks)", () => {
    const store = createTranscriptStore()
    store.ingest({ terminalId: "t", event: userMsg("live") })
    store.seedHistory("t", fold([userMsg("old"), asstDelta("answer")]))
    store.ingest({ terminalId: "t", event: asstDelta("live reply") })
    const state = store.get("t")
    expect(new Set(state.blocks.map((b) => b.id)).size).toBe(state.blocks.length)
    expect(shape(state)).toEqual([
      { kind: "user", text: "old" },
      { kind: "assistant", text: "answer" },
      { kind: "user", text: "live" },
      { kind: "assistant", text: "live reply" },
    ])
  })
})

describe("mergeSeededHistory (pure)", () => {
  it("live empty → returns the seeded state unchanged", () => {
    const seeded = fold([userMsg("old"), asstDelta("answer")])
    const merged = mergeSeededHistory(seeded, emptyTranscript())
    expect(shape(merged)).toEqual(shape(seeded))
  })

  it("live non-empty → prepends seeded beneath live", () => {
    const seeded = fold([userMsg("old"), asstDelta("answer")])
    const live = fold([userMsg("new")])
    const merged = mergeSeededHistory(seeded, live)
    expect(shape(merged)).toEqual([
      { kind: "user", text: "old" },
      { kind: "assistant", text: "answer" },
      { kind: "user", text: "new" },
    ])
  })

  it("boundary dedupe: a seeded tail that duplicates the live head is dropped once", () => {
    // The rare overlap race: the live head block is the SAME as the seeded tail block
    // (same kind + content). Drop the duplicated seeded tail — never render it twice.
    const seeded = fold([userMsg("q"), asstDelta("shared reply")])
    const live = fold([asstDelta("shared reply"), result("shared reply")])
    const merged = mergeSeededHistory(seeded, live)
    expect(shape(merged)).toEqual([
      { kind: "user", text: "q" },
      { kind: "assistant", text: "shared reply" }, // exactly once (from live)
      { kind: "result", text: undefined },
    ])
  })

  it("NEVER discards live blocks (the line-244 regression)", () => {
    // The original bug discarded the ENTIRE seed if any live event folded first
    // (`prev.blocks.length === 0 ? seeded : prev`). The merge must keep BOTH: every
    // live block survives, and the seed rides beneath it.
    const seeded = fold([userMsg("history q"), asstDelta("history a")])
    const live = fold([userMsg("live q"), asstDelta("live a"), result("live a")])
    const merged = mergeSeededHistory(seeded, live)
    const texts = merged.blocks.map((b) => (b as { text?: string }).text)
    // All live content is present…
    expect(texts).toContain("live q")
    expect(texts).toContain("live a")
    // …and the seed rides beneath it (not discarded).
    expect(texts).toContain("history q")
    expect(texts).toContain("history a")
    // Live blocks are AFTER the seeded ones (seed merged BENEATH live).
    expect(shape(merged).slice(0, 2)).toEqual([
      { kind: "user", text: "history q" },
      { kind: "assistant", text: "history a" },
    ])
  })

  it("produces contiguous unique ids and a seq past the end", () => {
    const seeded = fold([userMsg("a"), asstDelta("b")])
    const live = fold([userMsg("c")])
    const merged = mergeSeededHistory(seeded, live)
    expect(merged.blocks.map((b) => b.id)).toEqual(["b0", "b1", "b2"])
    expect(merged.seq).toBe(3)
  })

  it("does not mutate its inputs", () => {
    const seeded = fold([userMsg("a")])
    const live = fold([userMsg("b")])
    const seededBefore = shape(seeded)
    const liveBefore = shape(live)
    mergeSeededHistory(seeded, live)
    expect(shape(seeded)).toEqual(seededBefore)
    expect(shape(live)).toEqual(liveBefore)
  })
})

// A type-only touch so an unused-import lint can't strip the TranscriptBlock import
// used by helpers above.
export type _Block = TranscriptBlock
