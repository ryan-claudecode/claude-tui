/**
 * CAPP-93 / U5 — renderer-local mirror of the workspace-memory promote wire shape.
 *
 * Deliberately NOT imported from `electron/services/workspaceMemory` (its canonical
 * home, U1): that module pulls in `node:fs`/`node:path`/`node:os` (+ `persist.ts`), and
 * importing it into the renderer drags those node-only modules into the web TS project
 * — which has no node types — breaking the renderer build. The renderer's TS project is
 * node-free by design (it imports cross-layer types only from the node-free
 * `streamProtocol.ts`). `PromoteEntry` is a plain IPC data shape, so a local mirror is
 * the correct boundary type. It MUST stay structurally compatible with the service's
 * `PromoteEntry` (the preload passes it straight through, typed `any[]`).
 */
export type FindingSource = "self" | "observer" | "user" | "agent"

export interface PromoteEntry {
  text: string
  originSessionId?: string
  originNoteId?: string
  createdAt?: number
  status?: "active" | "superseded"
  /** Origin `Note.supersededBy` (a session note id), rewritten on promote. */
  supersededBy?: string
  source?: FindingSource
}

/**
 * Pure view-model for the delete-time Keep flow's editable findings list (the step-2
 * list inside KillSessionModal). The modal fetches the dying session's
 * `getPromotableFindings(sessionId)` (a `PromoteEntry[]`) and snapshots it into
 * `PromoteRow[]` ONCE at open time, so subsequent in-session mutations (notes
 * added/superseded) never disturb what the user is reviewing. Every row is pre-checked
 * (default = promote ALL) and its `text` is independently editable.
 */
export interface PromoteRow {
  /** A stable per-row id for React keys + controlled-input identity (independent of
   *  the origin note id, which can be undefined for an authored finding). */
  rowId: string
  /** Whether this finding will be promoted on "Keep & delete" (pre-checked = true). */
  checked: boolean
  /** The (editable) finding text seeded from the origin note. */
  text: string
  /** The untouched origin entry — its provenance fields ride through on promote. */
  origin: PromoteEntry
}

/**
 * Snapshot the fetched promote candidates into editable rows. Every row starts
 * checked (promote ALL by default); the text is seeded from the origin. The rowId is
 * derived from the origin note id when present (stable + unique per note) and falls
 * back to the array index for an authored finding with no note id.
 */
export function snapshotPromoteRows(entries: PromoteEntry[]): PromoteRow[] {
  return entries.map((origin, i) => ({
    rowId: origin.originNoteId ?? `row-${i}`,
    checked: true,
    text: origin.text,
    origin,
  }))
}

/**
 * Map the current rows back to the `PromoteEntry[]` to promote: ONLY checked rows,
 * carrying each row's edited text but otherwise preserving the origin's provenance
 * (`originSessionId`/`originNoteId`/`createdAt`/`status`/`supersededBy`/`source`).
 *
 * Whitespace-only edits are dropped (a blank finding is not worth keeping) — this
 * also means a user can "remove" a finding by clearing its text OR unchecking it.
 *
 * Note on the supersede graph: a checked ruled-out finding rides its origin
 * `supersededBy` (the corrector's ORIGIN note id) through unchanged. The service's
 * `promoteFindings` rewrites that over the freshly-minted workspace twin ids and, if
 * the corrector was trimmed from this batch, keeps the claim `superseded` with
 * `supersededBy` dropped (it never resurrects a disproven claim). So this helper does
 * NOT need to reason about the graph — it just preserves the field.
 */
export function rowsToPromoteEntries(rows: PromoteRow[]): PromoteEntry[] {
  return rows
    .filter((r) => r.checked && r.text.trim().length > 0)
    .map((r) => ({ ...r.origin, text: r.text.trim() }))
}
