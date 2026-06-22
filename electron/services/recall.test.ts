import { describe, it, expect } from "vitest"
import {
  RecallService,
  deriveRecallIndex,
  scopeFilter,
  lexicalScorer,
  tokenize,
  WORKSPACE_MEMORY_SESSION_ID,
  WORKSPACE_MEMORY_SESSION_NAME,
  primerHitEligible,
  type RecallScorer,
  type MemoryFinding,
} from "./recall"
import type { WorkSession, Note } from "./sessions"
import { UNTAGGED_STEM, type WorkspaceFinding } from "./workspaceMemory"

/**
 * CAPP-86 — "The Lexicon" RecallService. Hermetic: synthetic WorkSession[] fed in
 * via the listSessions callback (no SessionService, no disk). Asserts ranked lexical
 * hits, ruled-out-with-correction surfacing, scope filtering (workspace default does
 * not leak), the summary() digest, and an empty corpus.
 */

let noteSeq = 0
function note(text: string, createdAt: number, opts: Partial<Note> = {}): Note {
  return {
    id: opts.id ?? `n-${++noteSeq}`,
    text,
    createdAt,
    source: opts.source ?? "self",
    status: opts.status ?? "active",
    ...(opts.supersededBy ? { supersededBy: opts.supersededBy } : {}),
  }
}

function session(over: Partial<WorkSession> & { id: string }): WorkSession {
  return {
    id: over.id,
    name: over.name ?? "Untitled session",
    status: over.status ?? "active",
    workspaceId: over.workspaceId,
    summary: over.summary ?? "",
    notes: over.notes ?? [],
    provisionalFindings: over.provisionalFindings ?? [],
    terminals: over.terminals ?? [],
    createdAt: over.createdAt ?? 0,
    updatedAt: over.updatedAt ?? 0,
  }
}

let wmSeq = 0
/** A memory finding (with its owning bucket's `workspaceId` attached, the shape
 *  `deriveRecallIndex` takes directly) for the union/de-dup tests. `workspaceId` is the
 *  STORED value (a real id, or UNTAGGED_STEM for the untagged bucket); the derive step
 *  normalizes the stem → undefined. */
function wmFinding(over: Partial<MemoryFinding> & { text: string }): MemoryFinding {
  const t = over.createdAt ?? 0
  return {
    id: over.id ?? `wm-${++wmSeq}`,
    text: over.text,
    workspaceId: over.workspaceId ?? "ws-a",
    createdAt: t,
    source: over.source ?? "self",
    status: over.status ?? "active",
    ...(over.supersededBy ? { supersededBy: over.supersededBy } : {}),
    ...(over.originSessionId != null ? { originSessionId: over.originSessionId } : {}),
    ...(over.originNoteId != null ? { originNoteId: over.originNoteId } : {}),
    promotedAt: over.promotedAt ?? t,
  }
}

/** Wrap a list of buckets as the `listWorkspaceMemory()` injection shape (the service
 *  re-attaches each bucket's workspaceId to its findings when flattening). The
 *  WorkspaceFinding[] here drop the test helper's `workspaceId` to match the real
 *  listWorkspaceMemory() return type. */
function memorySource(
  buckets: Array<{ workspaceId: string; findings: MemoryFinding[] }>,
): () => Array<{ workspaceId: string; findings: WorkspaceFinding[] }> {
  return () => buckets.map((b) => ({ workspaceId: b.workspaceId, findings: b.findings }))
}

describe("tokenize", () => {
  it("case-folds and splits on non-alphanumerics", () => {
    expect(tokenize("N+1 Query, in Auth!")).toEqual(["n", "1", "query", "in", "auth"])
  })
  it("returns [] for empty/symbol-only input", () => {
    expect(tokenize("   ")).toEqual([])
    expect(tokenize("!!!")).toEqual([])
  })
})

describe("lexicalScorer", () => {
  it("ranks an exact-phrase substring above a partial token overlap", () => {
    const exact = lexicalScorer.score("auth race condition", "the auth race condition is fixed")
    const partial = lexicalScorer.score("auth race condition", "auth is unrelated here")
    expect(exact).toBeGreaterThan(partial)
    expect(partial).toBeGreaterThan(0) // one token overlaps
  })
  it("returns 0 when nothing matches", () => {
    expect(lexicalScorer.score("tokenizer", "completely different text")).toBe(0)
  })
  it("returns 0 for a blank query", () => {
    expect(lexicalScorer.score("   ", "anything")).toBe(0)
  })
})

describe("deriveRecallIndex", () => {
  it("emits one entry per non-empty summary + one per note (active and superseded)", () => {
    const wrong = note("bug is in auth", 10, { id: "w1", status: "superseded", supersededBy: "fix1" })
    const fix = note("actually it's the list endpoint", 20, { id: "fix1" })
    const s = session({
      id: "s1",
      name: "Auth fix",
      workspaceId: "ws-a",
      summary: "Goal: fix the auth race.",
      notes: [wrong, fix],
    })
    const idx = deriveRecallIndex([s])
    // summary + 2 notes = 3 entries
    expect(idx).toHaveLength(3)
    const summary = idx.find((e) => e.source === "summary")!
    expect(summary.status).toBe("summary")
    expect(summary.text).toBe("Goal: fix the auth race.")
    const ruled = idx.find((e) => e.status === "ruled-out")!
    expect(ruled.text).toBe("bug is in auth")
    // ruled-out carries the correcting note's text (the forward link)
    expect(ruled.correction).toBe("actually it's the list endpoint")
    const active = idx.find((e) => e.status === "active")!
    expect(active.text).toBe("actually it's the list endpoint")
    // every entry carries the session identity
    for (const e of idx) {
      expect(e.sessionId).toBe("s1")
      expect(e.sessionName).toBe("Auth fix")
      expect(e.workspaceId).toBe("ws-a")
    }
  })

  it("skips a blank/whitespace-only summary", () => {
    const s = session({ id: "s1", summary: "   ", notes: [note("a finding", 1)] })
    const idx = deriveRecallIndex([s])
    expect(idx).toHaveLength(1)
    expect(idx[0].source).toBe("note")
  })

  it("leaves correction undefined when the superseding note is missing", () => {
    const orphan = note("ruled out, no fix linked", 1, { status: "superseded", supersededBy: "gone" })
    const idx = deriveRecallIndex([session({ id: "s1", notes: [orphan] })])
    expect(idx[0].status).toBe("ruled-out")
    expect(idx[0].correction).toBeUndefined()
  })
})

describe("scopeFilter", () => {
  const entries = deriveRecallIndex([
    session({ id: "s1", workspaceId: "ws-a", notes: [note("alpha", 1)] }),
    session({ id: "s2", workspaceId: "ws-b", notes: [note("beta", 1)] }),
    session({ id: "s3", workspaceId: undefined, notes: [note("untagged", 1)] }),
  ])

  it("'all' returns everything", () => {
    expect(scopeFilter(entries, "all", {}).length).toBe(3)
  })
  it("'session' returns only the caller's session", () => {
    const r = scopeFilter(entries, "session", { sessionId: "s2" })
    expect(r.map((e) => e.text)).toEqual(["beta"])
  })
  it("'session' with no caller session returns nothing", () => {
    expect(scopeFilter(entries, "session", {})).toEqual([])
  })
  it("'workspace' (default) does NOT leak across workspaces", () => {
    const r = scopeFilter(entries, "workspace", { workspaceId: "ws-a" })
    expect(r.map((e) => e.text)).toEqual(["alpha"])
  })
  it("'workspace' with an untagged caller sees only untagged entries (symmetric)", () => {
    const r = scopeFilter(entries, "workspace", { workspaceId: undefined })
    expect(r.map((e) => e.text)).toEqual(["untagged"])
  })
})

describe("RecallService.recall", () => {
  const corpus = () => [
    session({
      id: "s1",
      name: "Auth work",
      workspaceId: "ws-a",
      summary: "Investigating the auth race condition.",
      notes: [
        note("the N+1 query is the perf root cause", 100),
        note("auth bug is in the middleware", 50, { id: "wrong", status: "superseded", supersededBy: "right" }),
        note("the real auth bug is in the token refresh", 60, { id: "right" }),
      ],
    }),
    session({
      id: "s2",
      name: "Frontend",
      workspaceId: "ws-b",
      notes: [note("the auth modal flickers on remount", 70)],
    }),
  ]

  it("returns ranked hits (score desc, then recency) within the default workspace scope", () => {
    const svc = new RecallService(corpus)
    // caller is in ws-a → ws-b's frontend note must NOT surface (no leak)
    const hits = svc.recall("auth bug", "workspace", { sessionId: "s1", workspaceId: "ws-a" })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.workspaceId === "ws-a")).toBe(true)
    // the ws-b frontend note ("auth modal flickers") is excluded
    expect(hits.some((h) => h.text.includes("modal flickers"))).toBe(false)
    // top hit is a strong "auth bug" match
    expect(hits[0].text.toLowerCase()).toContain("auth")
  })

  it("surfaces a ruled-out hit WITH its correction", () => {
    const svc = new RecallService(corpus)
    const hits = svc.recall("middleware", "workspace", { workspaceId: "ws-a" })
    const ruled = hits.find((h) => h.status === "ruled-out")
    expect(ruled).toBeTruthy()
    expect(ruled!.text).toBe("auth bug is in the middleware")
    expect(ruled!.correction).toBe("the real auth bug is in the token refresh")
  })

  it("'all' scope reaches across workspaces (explicit opt-in)", () => {
    const svc = new RecallService(corpus)
    const hits = svc.recall("auth", "all", { workspaceId: "ws-a" })
    expect(hits.some((h) => h.workspaceId === "ws-b")).toBe(true)
  })

  it("returns [] for a blank query", () => {
    const svc = new RecallService(corpus)
    expect(svc.recall("   ", "all", {})).toEqual([])
  })

  it("returns [] for an empty corpus", () => {
    const svc = new RecallService(() => [])
    expect(svc.recall("anything", "all", {})).toEqual([])
  })

  it("re-derives the index after invalidate() so a new finding becomes searchable", () => {
    let sessions = [session({ id: "s1", workspaceId: "ws-a", notes: [note("first finding", 1)] })]
    const svc = new RecallService(() => sessions)
    expect(svc.recall("second", "all", {}).length).toBe(0)
    // mutate the underlying corpus + invalidate
    sessions = [
      session({ id: "s1", workspaceId: "ws-a", notes: [note("first finding", 1), note("second finding", 2)] }),
    ]
    svc.invalidate()
    expect(svc.recall("second", "all", {}).length).toBe(1)
  })

  it("uses a pluggable scorer (Phase-2 swap seam)", () => {
    // A scorer that only matches the literal word "magic".
    const onlyMagic: RecallScorer = { score: (_q, text) => (text.includes("magic") ? 1 : 0) }
    const svc = new RecallService(
      () => [session({ id: "s1", notes: [note("nothing here", 1), note("the magic word", 2)] })],
      () => [], // no workspace memory (second injected source, CAPP-87 / U4)
      { scorer: onlyMagic },
    )
    const hits = svc.recall("irrelevant query", "all", {})
    expect(hits.map((h) => h.text)).toEqual(["the magic word"])
  })
})

describe("RecallService.summary", () => {
  it("counts findings + ruled-out across contributing sessions and reports the most-recent ruled-out", () => {
    const svc = new RecallService(() => [
      session({
        id: "s1",
        name: "Auth work",
        workspaceId: "ws-a",
        summary: "running",
        notes: [
          note("active one", 10),
          note("old wrong", 5, { id: "w1", status: "superseded", supersededBy: "f1" }),
          note("the fix", 6, { id: "f1" }),
        ],
      }),
      session({
        id: "s2",
        name: "More auth",
        workspaceId: "ws-a",
        notes: [note("newer wrong path", 99, { id: "w2", status: "superseded", supersededBy: "f2" }), note("newer fix", 100, { id: "f2" })],
      }),
    ])
    const sum = svc.summary("workspace", { workspaceId: "ws-a" })
    expect(sum.sessions).toBe(2)
    // active notes: "active one", "the fix", "newer fix" = 3
    expect(sum.findings).toBe(3)
    // ruled-out: "old wrong", "newer wrong path" = 2
    expect(sum.ruledOut).toBe(2)
    // most-recent ruled-out (createdAt 99) with its correction
    expect(sum.recentRuledOut?.text).toBe("newer wrong path")
    expect(sum.recentRuledOut?.correction).toBe("newer fix")
    expect(sum.recentRuledOut?.sessionName).toBe("More auth")
  })

  it("does not leak across workspaces in the default scope", () => {
    const svc = new RecallService(() => [
      session({ id: "s1", workspaceId: "ws-a", notes: [note("a finding", 1)] }),
      session({ id: "s2", workspaceId: "ws-b", notes: [note("b finding", 1), note("b ruled", 2, { status: "superseded" })] }),
    ])
    const sum = svc.summary("workspace", { workspaceId: "ws-a" })
    expect(sum.sessions).toBe(1)
    expect(sum.findings).toBe(1)
    expect(sum.ruledOut).toBe(0)
    expect(sum.recentRuledOut).toBeUndefined()
  })

  it("returns zeroed counts for an empty corpus", () => {
    const svc = new RecallService(() => [])
    // CAPP-87 / U4 — workspaceMemory is ALWAYS present (uniform shape), zeroed when empty.
    expect(svc.summary("all", {})).toEqual({
      sessions: 0,
      findings: 0,
      ruledOut: 0,
      workspaceMemory: { findings: 0, ruledOut: 0 },
    })
  })

  it("EXCLUDES the caller's own session so the cross-session digest reflects only OTHER sessions", () => {
    const svc = new RecallService(() => [
      session({
        id: "sA",
        name: "Caller session",
        workspaceId: "ws-a",
        summary: "the caller's own running summary",
        notes: [
          note("caller active finding", 10),
          note("caller wrong path", 5, { id: "wA", status: "superseded", supersededBy: "fA" }),
          note("caller fix", 6, { id: "fA" }),
        ],
      }),
      session({
        id: "sB",
        name: "Other session",
        workspaceId: "ws-a",
        notes: [
          note("other active finding", 20),
          note("other wrong path", 99, { id: "wB", status: "superseded", supersededBy: "fB" }),
          note("other fix", 100, { id: "fB" }),
        ],
      }),
    ])
    // Caller is sA → only sB's knowledge should be counted.
    const sum = svc.summary("workspace", { sessionId: "sA", workspaceId: "ws-a" })
    expect(sum.sessions).toBe(1) // only the OTHER session contributes
    // sB active notes: "other active finding", "other fix" = 2 (NONE of sA's)
    expect(sum.findings).toBe(2)
    // sB ruled-out: "other wrong path" = 1 (NOT sA's "caller wrong path")
    expect(sum.ruledOut).toBe(1)
    // most-recent ruled-out is sB's, with its correction + session name
    expect(sum.recentRuledOut?.text).toBe("other wrong path")
    expect(sum.recentRuledOut?.correction).toBe("other fix")
    expect(sum.recentRuledOut?.sessionName).toBe("Other session")
  })

  it("yields sessions:0 / findings:0 when the caller is the ONLY session in scope (cross-session group hides)", () => {
    const svc = new RecallService(() => [
      session({
        id: "sOnly",
        name: "Lone session",
        workspaceId: "ws-a",
        summary: "lone summary",
        notes: [
          note("lone active finding", 10),
          note("lone wrong path", 5, { id: "wL", status: "superseded", supersededBy: "fL" }),
          note("lone fix", 6, { id: "fL" }),
        ],
      }),
    ])
    const sum = svc.summary("workspace", { sessionId: "sOnly", workspaceId: "ws-a" })
    expect(sum.sessions).toBe(0)
    expect(sum.findings).toBe(0)
    expect(sum.ruledOut).toBe(0)
    expect(sum.recentRuledOut).toBeUndefined()
  })
})

describe("RecallService.workspaceIdOf", () => {
  it("resolves a session's workspaceId (for identity→scope defaulting)", () => {
    const svc = new RecallService(() => [session({ id: "s1", workspaceId: "ws-x" })])
    expect(svc.workspaceIdOf("s1")).toBe("ws-x")
    expect(svc.workspaceIdOf("missing")).toBeUndefined()
    expect(svc.workspaceIdOf(undefined)).toBeUndefined()
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// CAPP-87 / U4 — the UNION of live session findings ∪ workspace memory, de-duped so
// each logical finding is counted EXACTLY ONCE on the (originSessionId, originNoteId)
// pair. These are the heart of U4: the exactly-once de-dup (both risks + collision),
// the untagged-key normalization, scope behavior, and the workspaceMemory digest.
// ────────────────────────────────────────────────────────────────────────────────

describe("deriveRecallIndex — union with workspace memory", () => {
  it("emits one entry per workspace-memory finding with the synthetic id + provenance", () => {
    const idx = deriveRecallIndex(
      [],
      [
        wmFinding({ text: "authored memory", workspaceId: "ws-a", source: "user" }),
        wmFinding({
          text: "promoted memory",
          workspaceId: "ws-a",
          originSessionId: "s9",
          originNoteId: "n9",
        }),
      ],
    )
    expect(idx).toHaveLength(2)
    for (const e of idx) {
      expect(e.source).toBe("workspace-memory")
      expect(e.sessionId).toBe(WORKSPACE_MEMORY_SESSION_ID)
      expect(e.sessionName).toBe(WORKSPACE_MEMORY_SESSION_NAME)
      expect(e.workspaceId).toBe("ws-a")
    }
    const promoted = idx.find((e) => e.text === "promoted memory")!
    expect(promoted.originSessionId).toBe("s9")
    expect(promoted.originNoteId).toBe("n9")
    const authored = idx.find((e) => e.text === "authored memory")!
    expect(authored.originSessionId).toBeUndefined()
    expect(authored.originNoteId).toBeUndefined()
  })

  it("a superseded memory finding carries its in-record corrector's text (and a bare strike when missing)", () => {
    const idx = deriveRecallIndex(
      [],
      [
        wmFinding({ id: "twin-wrong", text: "old memory claim", status: "superseded", supersededBy: "twin-fix" }),
        wmFinding({ id: "twin-fix", text: "the corrected memory claim" }),
        wmFinding({ id: "orphan", text: "superseded, corrector trimmed", status: "superseded" }),
      ],
    )
    const ruled = idx.find((e) => e.text === "old memory claim")!
    expect(ruled.status).toBe("ruled-out")
    expect(ruled.correction).toBe("the corrected memory claim")
    const orphan = idx.find((e) => e.text === "superseded, corrector trimmed")!
    expect(orphan.status).toBe("ruled-out")
    expect(orphan.correction).toBeUndefined() // bare strikethrough, no dangling arrow
  })

  it("DE-DUP by the (originSessionId|originNoteId) PAIR — a promoted-from-live finding appears EXACTLY once", () => {
    const live = session({
      id: "s1",
      workspaceId: "ws-a",
      notes: [note("the auth bug is in token refresh", 10, { id: "n1" })],
    })
    const idx = deriveRecallIndex(
      [live],
      [wmFinding({ text: "the auth bug is in token refresh", workspaceId: "ws-a", originSessionId: "s1", originNoteId: "n1" })],
    )
    // The live origin note is suppressed; only the workspace twin remains.
    const matches = idx.filter((e) => e.text === "the auth bug is in token refresh")
    expect(matches).toHaveLength(1)
    expect(matches[0].source).toBe("workspace-memory")
  })

  it("COLLISION — two sessions in DIFFERENT workspaces share a bare note id; only the PROMOTED origin is suppressed", () => {
    const sA = session({ id: "sA", workspaceId: "ws-a", notes: [note("shared note text A", 1, { id: "dup" })] })
    const sB = session({ id: "sB", workspaceId: "ws-b", notes: [note("shared note text B", 2, { id: "dup" })] })
    // Only sA's note was promoted (origin pair = sA|dup). sB|dup must NOT be suppressed.
    const idx = deriveRecallIndex(
      [sA, sB],
      [wmFinding({ text: "shared note text A", workspaceId: "ws-a", originSessionId: "sA", originNoteId: "dup" })],
    )
    // sB's live note survives (a bare-id key would have wrongly suppressed it).
    expect(idx.some((e) => e.sessionId === "sB" && e.text === "shared note text B")).toBe(true)
    // sA's live note is suppressed (the workspace twin wins); no live sA "dup" note left.
    expect(idx.some((e) => e.sessionId === "sA" && e.source === "note")).toBe(false)
    // The workspace twin is present.
    expect(idx.some((e) => e.source === "workspace-memory" && e.text === "shared note text A")).toBe(true)
  })

  it("an EDITED promotion still de-dups by the pair (not by content)", () => {
    const live = session({ id: "s1", workspaceId: "ws-a", notes: [note("original wording", 1, { id: "n1" })] })
    const idx = deriveRecallIndex(
      [live],
      // The promoted twin's text was edited in the Keep flow — pair still matches.
      [wmFinding({ text: "edited wording", workspaceId: "ws-a", originSessionId: "s1", originNoteId: "n1" })],
    )
    expect(idx.some((e) => e.source === "note")).toBe(false) // origin suppressed by pair
    expect(idx.filter((e) => e.text === "edited wording")).toHaveLength(1)
    expect(idx.some((e) => e.text === "original wording")).toBe(false)
  })

  it("untagged normalization — an untagged-bucket finding's emitted workspaceId is undefined (NOT the stem)", () => {
    const idx = deriveRecallIndex([], [wmFinding({ text: "global memory", workspaceId: UNTAGGED_STEM })])
    expect(idx).toHaveLength(1)
    expect(idx[0].workspaceId).toBeUndefined()
    // The sentinel stem must never reach the recall surface.
    expect(idx[0].workspaceId).not.toBe(UNTAGGED_STEM)
  })

  it("supersede-after-promote (best-effort): the twin remains AND the new in-session corrector also surfaces", () => {
    // n1 was promoted (pair s1|n1 → suppressed), then superseded in-session by a NEW note
    // n2. n2's id is not in promotedKeys, so BOTH the workspace twin AND n2 surface — the
    // ratified best-effort behavior (memory-wins-on-the-original; we don't chase the chain).
    const live = session({
      id: "s1",
      workspaceId: "ws-a",
      notes: [
        note("the original promoted claim", 5, { id: "n1", status: "superseded", supersededBy: "n2" }),
        note("the newer in-session correction", 6, { id: "n2" }),
      ],
    })
    const idx = deriveRecallIndex(
      [live],
      [wmFinding({ text: "the original promoted claim", workspaceId: "ws-a", originSessionId: "s1", originNoteId: "n1" })],
    )
    // The promoted origin note (n1) is suppressed by the pair...
    expect(idx.some((e) => e.source === "note" && e.text === "the original promoted claim")).toBe(false)
    // ...its workspace twin remains...
    expect(idx.some((e) => e.source === "workspace-memory" && e.text === "the original promoted claim")).toBe(true)
    // ...and the NEW corrector n2 (different id, not promoted) surfaces as a live note.
    expect(idx.some((e) => e.source === "note" && e.text === "the newer in-session correction")).toBe(true)
  })

  it("memory pass de-dups two twins sharing an origin pair across buckets (defensive exactly-once)", () => {
    // The same finding promoted into TWO buckets (a real ws + the untagged bucket). Only
    // reachable if the owning-workspace invariant is broken, but derive must count it once.
    const idx = deriveRecallIndex(
      [],
      [
        wmFinding({ id: "twinA", text: "duplicated twin", workspaceId: "ws-a", originSessionId: "s1", originNoteId: "n1" }),
        wmFinding({ id: "twinB", text: "duplicated twin", workspaceId: UNTAGGED_STEM, originSessionId: "s1", originNoteId: "n1" }),
      ],
    )
    expect(idx.filter((e) => e.text === "duplicated twin")).toHaveLength(1)
  })
})

describe("primerHitEligible (CAPP-87 / U4 §C7)", () => {
  it("excludes the caller's own live note", () => {
    expect(primerHitEligible({ sessionId: "sA" }, "sA")).toBe(false)
  })
  it("excludes a memory hit promoted FROM the caller (synthetic sessionId, originSessionId === caller)", () => {
    expect(primerHitEligible({ sessionId: WORKSPACE_MEMORY_SESSION_ID, originSessionId: "sA" }, "sA")).toBe(false)
  })
  it("KEEPS a memory hit promoted from ANOTHER session", () => {
    expect(primerHitEligible({ sessionId: WORKSPACE_MEMORY_SESSION_ID, originSessionId: "sB" }, "sA")).toBe(true)
  })
  it("KEEPS an authored memory hit (no originSessionId)", () => {
    expect(primerHitEligible({ sessionId: WORKSPACE_MEMORY_SESSION_ID }, "sA")).toBe(true)
  })
  it("KEEPS another session's live note", () => {
    expect(primerHitEligible({ sessionId: "sB" }, "sA")).toBe(true)
  })
})

describe("RecallService — union scope + digest (CAPP-87 / U4)", () => {
  const buildSvc = (
    sessions: WorkSession[],
    memory: Array<{ workspaceId: string; findings: MemoryFinding[] }>,
  ) => new RecallService(() => sessions, memorySource(memory))

  it("recall unions memory entries within the default workspace scope", () => {
    const svc = buildSvc(
      [session({ id: "s1", workspaceId: "ws-a", notes: [note("live finding about auth", 1)] })],
      [{ workspaceId: "ws-a", findings: [wmFinding({ text: "durable memory about auth", workspaceId: "ws-a", source: "user" })] }],
    )
    const hits = svc.recall("auth", "workspace", { workspaceId: "ws-a" })
    expect(hits.some((h) => h.source === "workspace-memory" && h.text === "durable memory about auth")).toBe(true)
    expect(hits.some((h) => h.source === "note" && h.text === "live finding about auth")).toBe(true)
  })

  it("'session' scope EXCLUDES workspace memory (synthetic id never matches a real session)", () => {
    const svc = buildSvc(
      [session({ id: "s1", workspaceId: "ws-a", notes: [note("session-only finding", 1)] })],
      [{ workspaceId: "ws-a", findings: [wmFinding({ text: "memory finding", workspaceId: "ws-a", source: "user" })] }],
    )
    const hits = svc.recall("finding", "session", { sessionId: "s1", workspaceId: "ws-a" })
    expect(hits.some((h) => h.source === "workspace-memory")).toBe(false)
    expect(hits.some((h) => h.text === "session-only finding")).toBe(true)
  })

  it("'workspace' scope: an untagged caller sees the untagged bucket; a ws-A caller does NOT", () => {
    const svc = buildSvc(
      [],
      [{ workspaceId: UNTAGGED_STEM, findings: [wmFinding({ text: "untagged global memory", workspaceId: UNTAGGED_STEM, source: "user" })] }],
    )
    // Untagged caller (workspaceId undefined) sees the untagged memory.
    const untaggedHits = svc.recall("memory", "workspace", { workspaceId: undefined })
    expect(untaggedHits.some((h) => h.text === "untagged global memory")).toBe(true)
    // A ws-A caller does NOT see the untagged bucket (no cross-workspace leak).
    const wsAHits = svc.recall("memory", "workspace", { workspaceId: "ws-a" })
    expect(wsAHits.some((h) => h.text === "untagged global memory")).toBe(false)
  })

  it("'all' scope returns memory cross-workspace (explicit documented opt-in)", () => {
    const svc = buildSvc(
      [],
      [
        { workspaceId: "ws-a", findings: [wmFinding({ text: "ws-a memory", workspaceId: "ws-a", source: "user" })] },
        { workspaceId: "ws-b", findings: [wmFinding({ text: "ws-b memory", workspaceId: "ws-b", source: "user" })] },
      ],
    )
    const hits = svc.recall("memory", "all", { workspaceId: "ws-a" })
    expect(hits.some((h) => h.text === "ws-a memory")).toBe(true)
    expect(hits.some((h) => h.text === "ws-b memory")).toBe(true)
  })

  it("summary(): the workspaceMemory digest counts active/ruled-out separately and never adds a phantom session", () => {
    const svc = buildSvc(
      [session({ id: "s1", workspaceId: "ws-a", notes: [note("a live active finding", 1)] })],
      [
        {
          workspaceId: "ws-a",
          findings: [
            wmFinding({ text: "memory active 1", workspaceId: "ws-a", source: "user" }),
            wmFinding({ text: "memory active 2", workspaceId: "ws-a", source: "agent" }),
            wmFinding({ id: "mw", text: "memory ruled out", workspaceId: "ws-a", status: "superseded" }),
          ],
        },
      ],
    )
    const sum = svc.summary("workspace", { sessionId: "sOther", workspaceId: "ws-a" })
    // The workspace-memory entries do NOT add a phantom session.
    expect(sum.sessions).toBe(1)
    expect(sum.findings).toBe(1) // only the live note
    expect(sum.ruledOut).toBe(0) // the memory ruled-out is NOT in the cross-session count
    expect(sum.workspaceMemory).toEqual({ findings: 2, ruledOut: 1 })
  })

  it("summary(): cross-session recentRuledOut NEVER picks a workspace-memory entry", () => {
    const svc = buildSvc(
      [
        session({
          id: "sOther",
          name: "Other session",
          workspaceId: "ws-a",
          notes: [note("session ruled out", 10, { id: "w", status: "superseded", supersededBy: "f" }), note("the fix", 11, { id: "f" })],
        }),
      ],
      [
        {
          workspaceId: "ws-a",
          // A memory ruled-out with a much NEWER createdAt — must NOT become recentRuledOut.
          findings: [wmFinding({ text: "memory ruled out NEWER", workspaceId: "ws-a", status: "superseded", createdAt: 9999 })],
        },
      ],
    )
    const sum = svc.summary("workspace", { workspaceId: "ws-a" })
    expect(sum.recentRuledOut?.text).toBe("session ruled out") // the session one, not memory
  })

  it("summary(): EXCLUDES a memory finding promoted FROM the caller's own session, keeps others", () => {
    const svc = buildSvc(
      [session({ id: "sA", workspaceId: "ws-a", notes: [] })],
      [
        {
          workspaceId: "ws-a",
          findings: [
            // Promoted FROM the caller (sA) → excluded from the memory digest.
            wmFinding({ text: "promoted from caller", workspaceId: "ws-a", originSessionId: "sA", originNoteId: "n1" }),
            // Promoted from ANOTHER session → kept.
            wmFinding({ text: "promoted from other", workspaceId: "ws-a", originSessionId: "sB", originNoteId: "n2" }),
            // Authored (no origin) → kept.
            wmFinding({ text: "authored memory", workspaceId: "ws-a", source: "user" }),
          ],
        },
      ],
    )
    const sum = svc.summary("workspace", { sessionId: "sA", workspaceId: "ws-a" })
    // Only the two non-caller-origin memory findings are counted.
    expect(sum.workspaceMemory).toEqual({ findings: 2, ruledOut: 0 })
  })

  it("summary(): workspaceMemory is ALWAYS present even with no memory in scope", () => {
    const svc = buildSvc([session({ id: "s1", workspaceId: "ws-a", notes: [note("x", 1)] })], [])
    const sum = svc.summary("workspace", { workspaceId: "ws-a" })
    expect(sum.workspaceMemory).toEqual({ findings: 0, ruledOut: 0 })
  })

  it("service path (getIndex → deriveRecallIndex) de-dups a promoted-from-live finding to EXACTLY one hit", () => {
    const svc = buildSvc(
      [session({ id: "s1", workspaceId: "ws-a", notes: [note("the shared auth finding", 1, { id: "n1" })] })],
      [{ workspaceId: "ws-a", findings: [wmFinding({ text: "the shared auth finding", workspaceId: "ws-a", originSessionId: "s1", originNoteId: "n1" })] }],
    )
    const matches = svc.recall("shared auth finding", "workspace", { workspaceId: "ws-a" }).filter((h) => h.text === "the shared auth finding")
    expect(matches).toHaveLength(1)
    // The memory hit carries the synthetic citation the rail/panel group on.
    expect(matches[0].source).toBe("workspace-memory")
    expect(matches[0].sessionId).toBe(WORKSPACE_MEMORY_SESSION_ID)
    expect(matches[0].sessionName).toBe(WORKSPACE_MEMORY_SESSION_NAME)
  })

  it("summary('all') aggregates the memory digest across buckets; 'workspace' scopes to the caller's", () => {
    const svc = buildSvc(
      [],
      [
        { workspaceId: "ws-a", findings: [wmFinding({ text: "a1", workspaceId: "ws-a", source: "user" })] },
        { workspaceId: "ws-b", findings: [wmFinding({ text: "b1", workspaceId: "ws-b", source: "user" }), wmFinding({ text: "b2", workspaceId: "ws-b", source: "user" })] },
      ],
    )
    // 'all' → both buckets aggregate (1 + 2 = 3).
    expect(svc.summary("all", { workspaceId: "ws-a" }).workspaceMemory).toEqual({ findings: 3, ruledOut: 0 })
    // 'workspace' → only the caller's own bucket (ws-a → 1).
    expect(svc.summary("workspace", { workspaceId: "ws-a" }).workspaceMemory).toEqual({ findings: 1, ruledOut: 0 })
  })
})
