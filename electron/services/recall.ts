import type { WorkSession, Note } from "./sessions"
import { UNTAGGED_STEM, type WorkspaceFinding } from "./workspaceMemory"

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

/** Synthetic session id stamped on every workspace-memory RecallEntry. It can never
 *  match a real WorkSession id, so a memory entry is invisible under `session` scope
 *  and never adds a phantom session to the cross-session digest (CAPP-87 / U4). */
export const WORKSPACE_MEMORY_SESSION_ID = "__workspace_memory__"
/** The display name a workspace-memory entry carries (the citation the rail/panel show). */
export const WORKSPACE_MEMORY_SESSION_NAME = "Workspace memory"

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
  /** CAPP-87 / U4 — `workspace-memory` is a promoted/authored finding from the durable
   *  workspace tier; it carries a synthetic sessionId and (for promotions) provenance. */
  source: "note" | "summary" | "workspace-memory"
  createdAt: number
  /** For a ruled-out note: the text of the note that corrected/superseded it. */
  correction?: string
  /** For a workspace-memory entry: the session the finding was promoted FROM (undefined
   *  for a user/agent-authored memory finding). Half of the (origin) de-dup key. */
  originSessionId?: string
  /** For a workspace-memory entry: the origin session `Note.id` it was promoted from —
   *  the other half of the (originSessionId, originNoteId) de-dup key. */
  originNoteId?: string
}

/** A ranked recall hit: the indexed entry plus its match score. */
export interface RecallHit extends RecallEntry {
  score: number
}

/** A cross-session digest for the Rail KNOWS section (CAPP-84). */
export interface RecallSummary {
  /** Number of work sessions that contributed at least one entry within scope. NEVER
   *  counts the synthetic workspace-memory "session" (that's a separate digest below). */
  sessions: number
  /** Total active findings (notes) within scope. Workspace-memory findings are excluded
   *  here — they're counted in {@link RecallSummary.workspaceMemory} instead. */
  findings: number
  /** Total ruled-out (superseded) findings within scope. Workspace-memory excluded. */
  ruledOut: number
  /** CAPP-87 / U4 — the durable workspace-memory tier's counts within scope. ALWAYS
   *  PRESENT (never omitted) so the digest shape is uniform; it's the second tier of the
   *  two-tier brain (memory ∪ live session findings), surfaced as its own rail group. */
  workspaceMemory: { findings: number; ruledOut: number }
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
 * A workspace-memory finding flattened with its OWNING bucket's workspaceId. A bare
 * {@link WorkspaceFinding} has no workspaceId of its own (it lives on the bucket
 * record), so `getIndex` attaches the bucket id when it flattens
 * `listWorkspaceMemory()`. `workspaceId` is still the raw STORED value (a real id or the
 * untagged stem) — `deriveRecallIndex` normalizes the stem → `undefined`.
 */
export type MemoryFinding = WorkspaceFinding & { workspaceId: string }

/**
 * Derive the flat recall index — a UNION of two durable tiers (CAPP-87 / U4):
 *   1. live SESSION findings (per non-empty summary + per note, active & superseded), and
 *   2. WORKSPACE-MEMORY findings (the promoted/authored durable tier).
 *
 * Counted EXACTLY ONCE. A finding promoted up to workspace memory leaves its origin
 * `Note` in place on disk, so naively the union would hold both. We de-dup so the
 * WORKSPACE twin WINS: the session-note pass skips any note whose
 * `(originSessionId, originNoteId)` pair matches a promoted memory finding. The key is
 * the PAIR (not a bare note id — two sessions in different workspaces can share a note
 * id; and not a content hash — the Keep flow lets users edit promoted text). This is a
 * SINGLE combined signature precisely because the note pass must already know the full
 * promoted-origin set (`promotedKeys`) to suppress correctly.
 *
 * Each memory finding emits one entry with a synthetic sessionId
 * ({@link WORKSPACE_MEMORY_SESSION_ID}) and `source: "workspace-memory"`. The bucket's
 * workspaceId rides ON each flattened finding (a `WorkspaceFinding` itself does not
 * carry one — it lives on the owning `WorkspaceMemoryRecord`; `getIndex` attaches it
 * when it flattens the buckets). The emitted `workspaceId` is the SCOPE value, not the
 * storage key: the untagged bucket's stem ({@link UNTAGGED_STEM}) is normalized to
 * `undefined` so `scopeFilter` matches an untagged caller (whose `workspaceId` is
 * `undefined`) — see C2 in the plan.
 *
 * Pure (no I/O), so the service re-derives it cheaply and tests assert it directly.
 */
export function deriveRecallIndex(
  sessions: WorkSession[],
  memoryFindings: MemoryFinding[] = [],
): RecallEntry[] {
  const entries: RecallEntry[] = []

  // The de-dup set: every promoted memory finding keyed on its origin PAIR. A live
  // session note matching one of these is suppressed from the index (the workspace
  // twin already carries it). Authored memory findings (no origin) don't participate.
  const promotedKeys = new Set(
    memoryFindings
      .filter((f) => f.originSessionId && f.originNoteId)
      .map((f) => `${f.originSessionId}|${f.originNoteId}`),
  )

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
      // De-dup: skip the live origin note when its (session, note) pair was promoted —
      // the durable workspace twin wins. Never deletes from disk; just omits from the
      // derived index so the same logical finding isn't counted twice.
      if (promotedKeys.has(`${s.id}|${n.id}`)) continue
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

  // Workspace-memory tier → one entry each. Within a single record the supersede graph
  // is closed over the workspace twin ids (rewritten on promote), so a superseded
  // finding's correction is its in-record corrector's text.
  const memById = new Map<string, MemoryFinding>(memoryFindings.map((f) => [f.id, f]))
  for (const f of memoryFindings) {
    // Normalize the untagged bucket's storage stem → undefined (the scope value), so an
    // untagged caller (workspaceId === undefined) matches under 'workspace' scope.
    const workspaceId = f.workspaceId === UNTAGGED_STEM ? undefined : f.workspaceId
    if (f.status === "superseded") {
      const correction = f.supersededBy ? memById.get(f.supersededBy)?.text : undefined
      entries.push({
        sessionId: WORKSPACE_MEMORY_SESSION_ID,
        sessionName: WORKSPACE_MEMORY_SESSION_NAME,
        workspaceId,
        text: f.text,
        status: "ruled-out",
        source: "workspace-memory",
        createdAt: f.createdAt,
        ...(correction ? { correction } : {}),
        ...(f.originSessionId != null ? { originSessionId: f.originSessionId } : {}),
        ...(f.originNoteId != null ? { originNoteId: f.originNoteId } : {}),
      })
    } else {
      entries.push({
        sessionId: WORKSPACE_MEMORY_SESSION_ID,
        sessionName: WORKSPACE_MEMORY_SESSION_NAME,
        workspaceId,
        text: f.text,
        status: "active",
        source: "workspace-memory",
        createdAt: f.createdAt,
        ...(f.originSessionId != null ? { originSessionId: f.originSessionId } : {}),
        ...(f.originNoteId != null ? { originNoteId: f.originNoteId } : {}),
      })
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
 *
 * CAPP-87 / U4 — workspace-memory (the durable tier) participates IDENTICALLY to notes:
 *  - 'session' → a memory entry's synthetic sessionId can never equal a real session id,
 *    so workspace memory is INVISIBLE under 'session' scope (deliberate).
 *  - 'workspace' (default) → a memory entry matches on its NORMALIZED workspaceId (the
 *    derive step turned the untagged stem into `undefined`), so an untagged caller sees
 *    only the untagged bucket's memory and a ws-A caller never sees the untagged bucket.
 *  - 'all' → memory is returnable cross-workspace, an explicit, documented opt-in.
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
  private listWorkspaceMemory: () => Array<{ workspaceId: string; findings: WorkspaceFinding[] }>
  private scorer: RecallScorer
  /** The derived index, or null when invalidated (re-built lazily on next read). */
  private index: RecallEntry[] | null = null

  /**
   * @param listSessions a callback returning the current WorkSession[] (injected,
   *   mirroring how SessionService takes getActiveWorkspaceId — so RecallService is
   *   decoupled from SessionService and trivially testable with synthetic input).
   * @param listWorkspaceMemory a callback returning the durable workspace-memory tier
   *   (CAPP-87 / U4) — the second source unioned into the index. Injected (not reached
   *   into directly) so the service stays decoupled + testable; defaults to none so the
   *   single-arg call sites and tests keep working.
   */
  constructor(
    listSessions: () => WorkSession[],
    listWorkspaceMemory: () => Array<{ workspaceId: string; findings: WorkspaceFinding[] }> = () => [],
    opts: RecallServiceOpts = {},
  ) {
    this.listSessions = listSessions
    this.listWorkspaceMemory = listWorkspaceMemory
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

  /** Lazily (re)derive + cache the UNION index from the current sessions AND the
   *  durable workspace-memory tier (flattened across every bucket, each finding tagged
   *  with its owning bucket's workspaceId so scoping works — a bare WorkspaceFinding
   *  has none of its own). */
  private getIndex(): RecallEntry[] {
    if (this.index === null) {
      const memoryFindings = this.listWorkspaceMemory().flatMap((m) =>
        m.findings.map((f) => ({ ...f, workspaceId: m.workspaceId })),
      )
      this.index = deriveRecallIndex(this.listSessions(), memoryFindings)
    }
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
   * Digests for the Rail KNOWS section — now TWO tiers (CAPP-87 / U4):
   *
   *  • CROSS-SESSION ("Across sessions"): counts of findings / ruled-out across OTHER
   *    sessions in scope (the caller's OWN session is EXCLUDED — its findings already
   *    show in the rail's "This session" digest, so counting them here would
   *    double-count), plus the most-recent cross-session ruled-out one-liner. When the
   *    workspace has only the caller's session this yields sessions:0 / findings:0, and
   *    `deriveKnowsRecall` correctly HIDES the cross-session group.
   *
   *  • WORKSPACE-MEMORY ({@link RecallSummary.workspaceMemory}, ALWAYS PRESENT): the
   *    durable tier's active / ruled-out counts in scope. A finding promoted FROM the
   *    caller's own session is excluded (its live note already shows in "This session"),
   *    but agent/user-authored memory and memory promoted from OTHER sessions are kept.
   *
   * The loop handles workspace-memory in a DEDICATED branch placed BEFORE the
   * self/origin `continue`, because that `continue` skips the whole iteration — the
   * memory counting could not live after it. The cross-session accumulation is guarded
   * `e.source !== "workspace-memory"`, so a synthetic memory entry never adds a phantom
   * session, never feeds the cross-session `findings`/`ruledOut`/`recentRuledOut`.
   *
   * 'workspace' is the natural default for the rail.
   */
  summary(
    scope: RecallScope = "workspace",
    caller: { sessionId?: string; workspaceId?: string } = {},
  ): RecallSummary {
    const scoped = scopeFilter(this.getIndex(), scope, caller)
    const sessionIds = new Set<string>()
    let findings = 0
    let ruledOut = 0
    let wmFindings = 0
    let wmRuledOut = 0
    let recent: RecallSummary["recentRuledOut"] | undefined
    for (const e of scoped) {
      if (e.source === "workspace-memory") {
        // Workspace-memory digest: exclude ONLY findings promoted FROM the caller's own
        // session (its live note already shows in "This session"); still count
        // agent/user-authored memory and memory promoted from OTHER sessions. This
        // branch never feeds sessionIds / findings / ruledOut / recentRuledOut.
        if (caller.sessionId && e.originSessionId === caller.sessionId) continue
        if (e.status === "ruled-out") wmRuledOut++
        else if (e.status === "active") wmFindings++
        continue
      }
      // ── cross-session ("other sessions") digest ──
      // Exclude the caller's own session — its knowledge already appears in the rail's
      // "This session" digest; counting it here would double-count. The originSessionId
      // guard catches the (rare) case of a non-memory entry carrying it.
      if (caller.sessionId && (e.sessionId === caller.sessionId || e.originSessionId === caller.sessionId)) continue
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
      workspaceMemory: { findings: wmFindings, ruledOut: wmRuledOut },
      ...(recent ? { recentRuledOut: recent } : {}),
    }
  }
}
