import type { WorkSession, Note } from "./sessions"

/**
 * CAPP-86 — "The Lexicon" foundational v1. RecallService is a READ-ONLY,
 * cross-session recall layer over the per-session knowledge already living in the
 * SessionService JSON files (summaries + the corrected findings ledger). It derives
 * an IN-MEMORY index from `listSessions()` — one entry per Note (active AND
 * superseded/ruled-out) plus per non-empty summary — and answers lexical "have we
 * learned this before?" queries across sessions and workspaces.
 *
 * Hard constraints (per the design doc): additive, ZERO new deps, ZERO persistence,
 * ZERO schema change. The index is derived (re-built lazily, invalidated on the
 * existing `worksession:updated` push), so it can never drift from or corrupt the
 * canonical files and survives a restart for free (re-derived on next load).
 *
 * The scorer is a small pluggable interface so a later LOCAL embedding pass
 * (Phase 2) is an ADDITIVE swap, not a rewrite.
 */

/** The scope a recall query runs over (the design doc's three coordinated surfaces). */
export type RecallScope = "session" | "workspace" | "all"

/**
 * One indexed unit of session knowledge. A `summary` entry has no `status` semantics
 * of its own (it's the rolling blurb); a `note` entry carries its ledger status, and
 * a `correction` (the forward-link text from the superseding note) when ruled-out.
 */
export interface RecallEntry {
  sessionId: string
  sessionName: string
  workspaceId?: string
  /** The searchable text — a note's text, or a session's summary. */
  text: string
  /** "active" | "ruled-out" for notes; "summary" for a session summary entry. */
  status: "active" | "ruled-out" | "summary"
  source: "note" | "summary"
  createdAt: number
  /** For a ruled-out note: the text of the note that corrected/superseded it. */
  correction?: string
}

/** A ranked recall hit: the indexed entry plus its match score. */
export interface RecallHit extends RecallEntry {
  score: number
}

/** A cross-session digest for the Rail KNOWS section (CAPP-84). */
export interface RecallSummary {
  /** Number of work sessions that contributed at least one entry within scope. */
  sessions: number
  /** Total active findings (notes) within scope. */
  findings: number
  /** Total ruled-out (superseded) findings within scope. */
  ruledOut: number
  /** The most-recently-created ruled-out one-liner within scope (with its correction), if any. */
  recentRuledOut?: { text: string; correction?: string; sessionName: string; createdAt: number }
}

/**
 * The pluggable scorer seam. `score(query, text)` returns a non-negative relevance
 * score (0 = no match). v1 ships {@link lexicalScorer}; a Phase-2 embedding scorer
 * is an additive swap of this single interface.
 */
export interface RecallScorer {
  score(query: string, text: string): number
}

/** Case-fold + split into word tokens (alphanumeric runs). Pure + dependency-free. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
}

/**
 * v1 lexical scorer — dependency-free. Combines a whole-query case-folded SUBSTRING
 * signal (strong, exact-phrase) with a TOKEN-OVERLAP signal (how many query tokens
 * appear in the text), normalized by the query's token count so longer queries don't
 * inflate scores. Returns 0 when nothing matches so the caller can drop it.
 */
export const lexicalScorer: RecallScorer = {
  score(query: string, text: string): number {
    const q = query.trim().toLowerCase()
    if (!q) return 0
    const haystack = text.toLowerCase()
    const queryTokens = tokenize(query)
    if (queryTokens.length === 0) return 0
    const textTokens = new Set(tokenize(text))

    let overlap = 0
    for (const t of queryTokens) if (textTokens.has(t)) overlap++
    const overlapScore = overlap / queryTokens.length // 0..1

    // Whole-query substring is the strongest signal (an exact phrase hit).
    const substringScore = haystack.includes(q) ? 1 : 0

    // Weight substring above token overlap; both contribute so a partial-token
    // match still ranks (just below an exact-phrase hit).
    return substringScore * 2 + overlapScore
  },
}

/**
 * Derive the flat recall index from a list of work sessions. One entry per
 * non-empty summary + one per note (active and superseded). A superseded note
 * carries the text of the note that corrected it (resolved via `supersededBy`),
 * mirroring `getContext`/`getOverview`'s ruled-out rendering. Pure (no I/O), so the
 * service can re-derive it cheaply and tests can assert it directly.
 */
export function deriveRecallIndex(sessions: WorkSession[]): RecallEntry[] {
  const entries: RecallEntry[] = []
  for (const s of sessions) {
    const base = { sessionId: s.id, sessionName: s.name, workspaceId: s.workspaceId }
    if (s.summary && s.summary.trim()) {
      entries.push({
        ...base,
        text: s.summary.trim(),
        status: "summary",
        source: "summary",
        // A summary has no createdAt of its own; use the session's updatedAt so it
        // ranks by recency alongside notes.
        createdAt: s.updatedAt,
      })
    }
    const byId = new Map<string, Note>(s.notes.map((n) => [n.id, n]))
    for (const n of s.notes) {
      if (n.status === "superseded") {
        const correction = n.supersededBy ? byId.get(n.supersededBy)?.text : undefined
        entries.push({
          ...base,
          text: n.text,
          status: "ruled-out",
          source: "note",
          createdAt: n.createdAt,
          ...(correction ? { correction } : {}),
        })
      } else {
        entries.push({ ...base, text: n.text, status: "active", source: "note", createdAt: n.createdAt })
      }
    }
  }
  return entries
}

/**
 * Filter an index to the requested scope, given the caller's identity. The DEFAULT
 * (enforced by callers) is 'workspace' so a finding from workspace A does NOT leak
 * into B unless 'all' is explicitly asked. Pure helper, exported for tests.
 *  - 'session'   → only the caller's own session (needs `callerSessionId`).
 *  - 'workspace' → only entries in the caller's workspace (needs `callerWorkspaceId`).
 *                  An UNTAGGED caller (no workspace, the "All" bucket) sees only
 *                  untagged entries — symmetric, no cross-workspace leak.
 *  - 'all'       → everything (explicit opt-in).
 */
export function scopeFilter(
  entries: RecallEntry[],
  scope: RecallScope,
  caller: { sessionId?: string; workspaceId?: string },
): RecallEntry[] {
  if (scope === "all") return entries
  if (scope === "session") {
    return caller.sessionId ? entries.filter((e) => e.sessionId === caller.sessionId) : []
  }
  // 'workspace' (default): match on workspaceId, treating undefined as the "All" bucket.
  return entries.filter((e) => (e.workspaceId ?? undefined) === (caller.workspaceId ?? undefined))
}

export interface RecallServiceOpts {
  /** Pluggable match scorer (default: {@link lexicalScorer}). Phase-2 swap point. */
  scorer?: RecallScorer
}

export class RecallService {
  private listSessions: () => WorkSession[]
  private scorer: RecallScorer
  /** The derived index, or null when invalidated (re-built lazily on next read). */
  private index: RecallEntry[] | null = null

  /**
   * @param listSessions a callback returning the current WorkSession[] (injected,
   *   mirroring how SessionService takes getActiveWorkspaceId — so RecallService is
   *   decoupled from SessionService and trivially testable with synthetic input).
   */
  constructor(listSessions: () => WorkSession[], opts: RecallServiceOpts = {}) {
    this.listSessions = listSessions
    this.scorer = opts.scorer ?? lexicalScorer
  }

  /**
   * Invalidate the cached index (the wiring layer calls this on every
   * `worksession:updated` push, so a new/changed note joins the searchable set on
   * its next query). Cheap — the rebuild is deferred to the next read.
   */
  invalidate(): void {
    this.index = null
  }

  /** Lazily (re)derive + cache the index from the current sessions. */
  private getIndex(): RecallEntry[] {
    if (this.index === null) this.index = deriveRecallIndex(this.listSessions())
    return this.index
  }

  /** Resolve a session's workspaceId from the live list (for identity→scope defaulting). */
  workspaceIdOf(sessionId: string | undefined): string | undefined {
    if (!sessionId) return undefined
    return this.listSessions().find((s) => s.id === sessionId)?.workspaceId
  }

  /**
   * Lexical cross-session recall. Returns ranked hits (score desc, then recency
   * desc) within `scope`. `caller` supplies the identity used by 'session'/
   * 'workspace' scoping; the MCP/IPC layer defaults `scope` to 'workspace'.
   */
  recall(
    query: string,
    scope: RecallScope,
    caller: { sessionId?: string; workspaceId?: string } = {},
    limit = 20,
  ): RecallHit[] {
    if (!query || !query.trim()) return []
    const scoped = scopeFilter(this.getIndex(), scope, caller)
    const hits: RecallHit[] = []
    for (const e of scoped) {
      const score = this.scorer.score(query, e.text)
      if (score > 0) hits.push({ ...e, score })
    }
    hits.sort((a, b) => (b.score - a.score) || (b.createdAt - a.createdAt))
    return hits.slice(0, limit)
  }

  /**
   * Cross-session digest for the Rail KNOWS section: counts of findings / ruled-out
   * across the contributing sessions in scope, plus the most-recent ruled-out
   * one-liner (with its correction). 'workspace' is the natural default for the rail.
   */
  summary(
    scope: RecallScope = "workspace",
    caller: { sessionId?: string; workspaceId?: string } = {},
  ): RecallSummary {
    const scoped = scopeFilter(this.getIndex(), scope, caller)
    const sessionIds = new Set<string>()
    let findings = 0
    let ruledOut = 0
    let recent: RecallSummary["recentRuledOut"] | undefined
    for (const e of scoped) {
      sessionIds.add(e.sessionId)
      if (e.source === "note" && e.status === "active") findings++
      else if (e.status === "ruled-out") {
        ruledOut++
        if (!recent || e.createdAt > recent.createdAt) {
          recent = {
            text: e.text,
            correction: e.correction,
            sessionName: e.sessionName,
            createdAt: e.createdAt,
          }
        }
      }
    }
    return {
      sessions: sessionIds.size,
      findings,
      ruledOut,
      ...(recent ? { recentRuledOut: recent } : {}),
    }
  }
}
