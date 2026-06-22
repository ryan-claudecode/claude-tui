import { describe, it, expect } from "vitest"
import {
  RecallService,
  deriveRecallIndex,
  scopeFilter,
  lexicalScorer,
  tokenize,
  type RecallScorer,
} from "./recall"
import type { WorkSession, Note } from "./sessions"

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
    expect(svc.summary("all", {})).toEqual({ sessions: 0, findings: 0, ruledOut: 0 })
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
