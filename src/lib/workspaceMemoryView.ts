/**
 * CAPP-94 / U6 — renderer-local mirror of the workspace-memory data shapes + the
 * pure view-model helpers the WorkspaceMemoryPanel renders from.
 *
 * Why a LOCAL mirror (not an import from `electron/services/workspaceMemory`): that
 * module — the canonical home of these types (U1) — pulls in `node:fs`/`node:path`/
 * `node:os` (+ `persist.ts`), so importing it into the renderer drags node-only
 * modules into the web TS project (which has no node types) and breaks the renderer
 * build. The renderer's TS project is node-free by design (it imports cross-layer
 * types only from the node-free `streamProtocol.ts`). These are plain IPC data
 * shapes, so a local mirror is the correct boundary type — exactly the call U5 made
 * for `PromoteEntry` in `killSessionPromote.ts`. They MUST stay structurally
 * compatible with the service's types (the preload passes records through as `any`).
 */

export type FindingSource = "self" | "observer" | "user" | "agent"

/** Mirror of `WorkspaceFinding` (electron/services/workspaceMemory.ts). */
export interface WorkspaceFinding {
  id: string
  text: string
  /** The ORIGIN finding's createdAt; === promotedAt for an authored finding. */
  createdAt: number
  source: FindingSource
  /** "superseded" == ruled-out. */
  status: "active" | "superseded"
  /** Re-pointed to the workspace twin id within a promote batch; dropped when the
   *  corrector was trimmed (the claim stays superseded). */
  supersededBy?: string
  originSessionId?: string
  originNoteId?: string
  /** When the finding graduated/was authored (DISTINCT from createdAt — freshness). */
  promotedAt: number
}

/** Mirror of `WorkspaceMemoryRecord` (electron/services/workspaceMemory.ts). */
export interface WorkspaceMemoryRecord {
  workspaceId: string
  instructions: string
  findings: WorkspaceFinding[]
  createdAt: number
  updatedAt: number
}

/**
 * A compact human "age" for a timestamp ("just now", "5m ago", "3h ago", "2d ago",
 * "4w ago"). Pure (takes an explicit `now` so tests are deterministic). A non-finite
 * or zero/negative `ts` (an absent timestamp) yields "" so callers can omit it
 * cleanly. Negative deltas (a clock skew where `ts` is in the future) clamp to
 * "just now" rather than rendering a nonsensical negative age.
 */
export function formatAge(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return ""
  const deltaMs = now - ts
  if (deltaMs < 45_000) return "just now"
  const mins = Math.round(deltaMs / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(deltaMs / 3_600_000)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(deltaMs / 86_400_000)
  if (days < 7) return `${days}d ago`
  const weeks = Math.round(deltaMs / 604_800_000)
  return `${weeks}w ago`
}

/**
 * The one-line freshness signal for a finding: its created age and — only when it
 * meaningfully differs from createdAt (a promoted finding whose origin pre-dates the
 * promotion) — its promoted age. For an authored finding (createdAt === promotedAt)
 * the two ages collapse, so we render just "Added <age>". A promoted finding reads
 * "Found <createdAge> · promoted <promotedAge>".
 *
 * Pure; returns "" when there is no usable timestamp at all (so the row can omit the
 * freshness line entirely).
 */
export function findingFreshness(f: WorkspaceFinding, now: number = Date.now()): string {
  const createdAge = formatAge(f.createdAt, now)
  const promotedAge = formatAge(f.promotedAt, now)
  // Authored finding (or missing/equal stamps): a single "Added" age.
  const authoredLike =
    !f.originNoteId || !Number.isFinite(f.createdAt) || f.createdAt === f.promotedAt
  if (authoredLike) {
    return createdAge ? `Added ${createdAge}` : promotedAge ? `Added ${promotedAge}` : ""
  }
  // Promoted finding: show both the origin age and the promotion age.
  if (createdAge && promotedAge) return `Found ${createdAge} · promoted ${promotedAge}`
  if (promotedAge) return `Promoted ${promotedAge}`
  return createdAge ? `Found ${createdAge}` : ""
}

/**
 * Per-row view model for the panel's findings list. Resolves the corrector's text for
 * a superseded (ruled-out) finding from its `supersededBy` twin id — EXACTLY how
 * SessionOverviewPanel renders a ruled-out note's correction (off the supersede link).
 * A superseded finding whose corrector was trimmed (`supersededBy` undefined / not
 * found) renders a bare strikethrough with no correction — never a dangling arrow.
 */
export interface FindingRow {
  finding: WorkspaceFinding
  ruledOut: boolean
  /** The corrector finding's text, when resolvable; else undefined (bare strike). */
  correction?: string
  freshness: string
}

export function deriveFindingRows(
  findings: WorkspaceFinding[],
  now: number = Date.now(),
): FindingRow[] {
  const byId = new Map(findings.map((f) => [f.id, f]))
  return findings.map((finding) => {
    const ruledOut = finding.status === "superseded"
    const correction =
      ruledOut && finding.supersededBy ? byId.get(finding.supersededBy)?.text : undefined
    return { finding, ruledOut, correction, freshness: findingFreshness(finding, now) }
  })
}
