import { join } from "node:path"
import { homedir } from "node:os"
import { readdirSync, unlinkSync } from "node:fs"
import { loadVersioned, saveVersioned, type Migration } from "../persist"
import { logWarn } from "../log"

/**
 * Workspace Memory — the durable, workspace-level knowledge tier (CAPP-87 / U1).
 *
 * A `WorkspaceMemoryRecord` is a first-class store persisted WITH the workspace,
 * NOT with any session, so it survives ALL session deletion. One file per
 * workspace lives at `<dir>/<workspaceId>.json` via the same versioned envelope
 * the per-session store uses (`persist.ts`). The "untagged" / "All" bucket (a
 * null/undefined workspaceId) is keyed internally by a non-string sentinel and
 * lands in `__untagged__.json`.
 *
 * The bridge from live session findings is PROMOTION: `promoteFindings` copies a
 * session `Note` up to this tier with provenance, re-minting the id, rewriting the
 * supersede graph over the new ids, and de-duping idempotently on the
 * (originSessionId, originNoteId) pair.
 *
 * Mirrors the patterns the surrounding services use: an injected `{ dir, now }`
 * for hermetic tests (like `SessionService`), an in-memory `Map` cache with lazy
 * per-id load, and a callback-set change seam (`onMemoryChanged`, modeled on
 * `WorkspaceService.onActiveChanged`).
 */

/** Persistence schema version for a workspace-memory file. v1 = the shape below.
 *  Pinned greenfield with NO migrations — the types are the SUPERSET so later
 *  units never need a migration (mirrors `sessions.ts`'s v1/empty-MIGRATIONS posture). */
export const SCHEMA_VERSION = 1
export const MIGRATIONS: Migration[] = []

/**
 * Provenance of a workspace finding. PINNED SUPERSET so promote (which copies a
 * session Note's "self"|"observer" verbatim — see `sessions.ts` `Note.source`)
 * AND direct authoring ("user"/"agent") are both valid at v1 with no later
 * migration or coercion.
 */
export type FindingSource = "self" | "observer" | "user" | "agent"

export interface WorkspaceFinding {
  /** RE-MINTED at this tier using the sessions.ts mint scheme (`note-<now>-<rand>`). */
  id: string
  text: string
  /** The ORIGIN finding's createdAt copied as-is; === promotedAt for authored findings. */
  createdAt: number
  /** Copied through for promotions; "user"/"agent" for direct authoring. */
  source: FindingSource
  /** "superseded" == ruled-out, carried verbatim from the origin note. */
  status: "active" | "superseded"
  /** Re-pointed to the WORKSPACE twin id within a promote batch; dropped (undefined)
   *  when the corrector was trimmed from the batch (the claim stays superseded). */
  supersededBy?: string
  /** undefined for a user/agent-authored finding. */
  originSessionId?: string
  /** The origin session `Note.id` copied from — half of the de-dup key. */
  originNoteId?: string
  /** When the finding graduated/was authored (DISTINCT from createdAt — a freshness signal). */
  promotedAt: number
  /**
   * CAPP-96 / DECISION 7 — a foundational finding the owner has marked as never-evict.
   * Additive + OPTIONAL (default falsy === not pinned), so existing files load unchanged
   * and no migration is needed. The auto-load context builder ({@link buildInjectedContext})
   * honors it: a pinned finding is the ONLY thing never dropped under the 8 KB cap, because
   * `promotedAt`/`createdAt` are recency signals, not importance. Surfacing a pin TOGGLE in
   * the editor panel is a fast-follow; the field must exist now so truncation can honor it.
   */
  pinned?: boolean
}

export interface WorkspaceMemoryRecord {
  /** The real workspace id; the untagged bucket's record carries the sentinel stem
   *  internally only (it is normalized away before crossing the recall surface). */
  workspaceId: string
  /** Durable standing context/instructions — the workspace-tier analogue of a
   *  session summary. */
  instructions: string
  findings: WorkspaceFinding[]
  createdAt: number
  updatedAt: number
}

/** One promote candidate. Shape produced by `SessionService.getPromotableFindings`
 *  (a structural copy of the origin `Note` plus its session id). `text` is the only
 *  required field so a user can author a fresh finding through the same path. */
export interface PromoteEntry {
  text: string
  originSessionId?: string
  originNoteId?: string
  createdAt?: number
  status?: "active" | "superseded"
  /** Origin `Note.supersededBy` (a session note id), rewritten through the batch
   *  remap on promote. */
  supersededBy?: string
  source?: FindingSource
}

/**
 * The module-private sentinel for the untagged / "All" bucket. A `Symbol` so it can
 * NEVER collide with a real (string) workspaceId in the in-memory cache `Map`.
 */
const UNTAGGED = Symbol("untagged")
/** The filename STEM the untagged bucket maps to, AND the value the untagged bucket's
 *  record carries in its `workspaceId` field. A real workspaceId equal to this is
 *  rejected so it can never clobber (or be clobbered by) the untagged file. EXPORTED
 *  (CAPP-87 / U4) so RecallService can normalize an untagged entry's stem → `undefined`
 *  (the scope value) without hardcoding the literal. */
export const UNTAGGED_STEM = "__untagged__"

type BucketKey = string | typeof UNTAGGED

export class WorkspaceMemoryService {
  private dir: string
  private now: () => number
  /** In-memory cache; the untagged bucket is keyed by the {@link UNTAGGED} symbol. */
  private cache = new Map<BucketKey, WorkspaceMemoryRecord>()
  /** Change subscribers (callback-set, mirroring `WorkspaceService.onActiveChanged`). */
  private listeners = new Set<(workspaceId: string) => void>()

  constructor(opts: { dir?: string; now?: () => number } = {}) {
    this.dir = opts.dir ?? join(homedir(), ".claude-tui", "workspace-memory")
    this.now = opts.now ?? (() => Date.now())
    this.loadAll()
  }

  /**
   * Warm the in-memory cache from disk at construction — read EVERY bucket file in
   * `this.dir` into the cache. Without this, `listWorkspaceMemory()` (cache-only, by
   * design) would return nothing after an app restart until some bucket was touched,
   * so persisted workspace memory would be invisible to RecallService / the rail —
   * breaking the "durable, always present" promise. Mirrors how `SessionService`
   * loads all sessions on startup so `list()` is complete. Per-file failures are
   * isolated so one corrupt file can't break startup.
   */
  private loadAll(): void {
    let files: string[]
    try {
      files = readdirSync(this.dir)
    } catch {
      return // dir doesn't exist yet → nothing persisted
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue
      const stem = f.slice(0, -".json".length)
      const key: BucketKey = stem === UNTAGGED_STEM ? UNTAGGED : stem
      try {
        this.loadOrCreate(key)
      } catch (err) {
        logWarn("workspaceMemory", `failed to load ${f}: ${String(err)}`)
      }
    }
  }

  // ── key/file mapping ────────────────────────────────────────────────────────

  /**
   * Resolve a public `workspaceId | null | undefined` arg to the internal bucket
   * key. `null`/`undefined` → the untagged sentinel. A literal `"__untagged__"`
   * string is REJECTED (throws) so it can never be used to address — or collide
   * with — the untagged bucket's file.
   */
  private keyFor(workspaceId: string | null | undefined): BucketKey {
    if (workspaceId == null) return UNTAGGED
    if (workspaceId === UNTAGGED_STEM) {
      throw new Error(`workspaceId "${UNTAGGED_STEM}" is reserved for the untagged bucket`)
    }
    return workspaceId
  }

  /** Map a bucket key to its on-disk filename. The untagged sentinel → the reserved
   *  stem; a real id → `<id>.json`. Throws if a real id equals the reserved stem
   *  (defense-in-depth alongside {@link keyFor}). */
  private fileFor(key: BucketKey): string {
    if (key === UNTAGGED) return join(this.dir, `${UNTAGGED_STEM}.json`)
    if (key === UNTAGGED_STEM) {
      throw new Error(`workspaceId "${UNTAGGED_STEM}" is reserved for the untagged bucket`)
    }
    return join(this.dir, `${key}.json`)
  }

  /** The value stored in `record.workspaceId` for a given bucket key (the sentinel
   *  bucket stores the reserved stem internally; the derive step normalizes it away). */
  private storedId(key: BucketKey): string {
    return key === UNTAGGED ? UNTAGGED_STEM : key
  }

  private mintId(): string {
    return `note-${this.now()}-${Math.random().toString(36).slice(2, 6)}`
  }

  // ── lazy load-or-create ──────────────────────────────────────────────────────

  /**
   * Resolve the record for a bucket key, loading it from disk into the cache on a
   * miss, or minting a fresh empty record if no file exists. Used before EVERY
   * mutation so a write into a workspace whose file is on disk but was never read
   * APPENDS rather than clobbering.
   */
  private loadOrCreate(key: BucketKey): WorkspaceMemoryRecord {
    const cached = this.cache.get(key)
    if (cached) return cached

    const onDisk = loadVersioned<WorkspaceMemoryRecord>(this.fileFor(key), SCHEMA_VERSION, MIGRATIONS)
    if (onDisk) {
      // Normalize tolerantly so a hand-edited/partial file loads as a usable record.
      const record: WorkspaceMemoryRecord = {
        workspaceId: this.storedId(key),
        instructions: typeof onDisk.instructions === "string" ? onDisk.instructions : "",
        findings: Array.isArray(onDisk.findings) ? onDisk.findings : [],
        createdAt: typeof onDisk.createdAt === "number" ? onDisk.createdAt : this.now(),
        updatedAt: typeof onDisk.updatedAt === "number" ? onDisk.updatedAt : this.now(),
      }
      this.cache.set(key, record)
      return record
    }

    const t = this.now()
    const fresh: WorkspaceMemoryRecord = {
      workspaceId: this.storedId(key),
      instructions: "",
      findings: [],
      createdAt: t,
      updatedAt: t,
    }
    this.cache.set(key, fresh)
    return fresh
  }

  /** Persist a bucket's record then notify subscribers. The emitted id is the
   *  record's STORED id (the real id, or the sentinel stem for the untagged bucket). */
  private persistAndEmit(key: BucketKey, record: WorkspaceMemoryRecord): void {
    record.updatedAt = this.now()
    saveVersioned(this.fileFor(key), SCHEMA_VERSION, record)
    for (const cb of this.listeners) cb(record.workspaceId)
  }

  // ── public read ──────────────────────────────────────────────────────────────

  /** The workspace's memory record (lazy-loaded). A missing file → an empty record. */
  getMemory(workspaceId: string | null): WorkspaceMemoryRecord {
    return this.loadOrCreate(this.keyFor(workspaceId))
  }

  /** In-memory snapshot of every cached bucket's findings, for RecallService
   *  injection. Reads the cache ONLY (no disk re-read), matching the in-memory
   *  derive posture; the raw stored key (incl. the untagged stem) is fine here —
   *  the derive step normalizes it. */
  listWorkspaceMemory(): Array<{ workspaceId: string; findings: WorkspaceFinding[] }> {
    return Array.from(this.cache.values()).map((r) => ({
      workspaceId: r.workspaceId,
      findings: r.findings,
    }))
  }

  // ── public mutators ──────────────────────────────────────────────────────────

  /** Set the workspace's durable standing instructions/context. */
  setInstructions(workspaceId: string | null, text: string): WorkspaceMemoryRecord {
    const key = this.keyFor(workspaceId)
    const record = this.loadOrCreate(key)
    record.instructions = text
    this.persistAndEmit(key, record)
    return record
  }

  /** Author a fresh finding directly at this tier (no session provenance). */
  addFinding(workspaceId: string | null, text: string, source: "user" | "agent"): WorkspaceFinding {
    const key = this.keyFor(workspaceId)
    const record = this.loadOrCreate(key)
    const t = this.now()
    const finding: WorkspaceFinding = {
      id: this.mintId(),
      text,
      createdAt: t, // === promotedAt for authored findings
      source,
      status: "active",
      promotedAt: t,
    }
    record.findings.push(finding)
    this.persistAndEmit(key, record)
    return finding
  }

  /** Edit a finding's text. Returns false if the finding isn't found. */
  editFinding(workspaceId: string | null, findingId: string, text: string): boolean {
    const key = this.keyFor(workspaceId)
    const record = this.loadOrCreate(key)
    const finding = record.findings.find((f) => f.id === findingId)
    if (!finding) return false
    finding.text = text
    this.persistAndEmit(key, record)
    return true
  }

  /** Remove a finding. Returns false if the finding isn't found. */
  deleteFinding(workspaceId: string | null, findingId: string): boolean {
    const key = this.keyFor(workspaceId)
    const record = this.loadOrCreate(key)
    const idx = record.findings.findIndex((f) => f.id === findingId)
    if (idx === -1) return false
    record.findings.splice(idx, 1)
    this.persistAndEmit(key, record)
    return true
  }

  /**
   * Promote session findings up to workspace memory.
   *
   *  1. Re-mint a fresh workspace id for every entry, building an
   *     `originNoteId -> newFindingId` map for the batch.
   *  2. Rewrite each in-batch `supersededBy` (an origin note id) THROUGH the map to
   *     the new workspace twin id. If the corrector is NOT in the batch (the user
   *     trimmed it), KEEP `status:"superseded"` and set `supersededBy: undefined` —
   *     never downgrade to `active` (that would resurrect a disproven claim).
   *  3. Idempotency: before minting, if a finding with the same
   *     (originSessionId, originNoteId) pair already exists in the target record,
   *     UPDATE it in place (text/status/supersededBy/promotedAt) instead of adding a
   *     duplicate. Authored entries (no originNoteId) always mint fresh.
   *
   * Returns the resulting workspace findings (the updated/newly-minted twins), in
   * batch order.
   */
  promoteFindings(workspaceId: string | null, entries: PromoteEntry[]): WorkspaceFinding[] {
    const key = this.keyFor(workspaceId)
    const record = this.loadOrCreate(key)
    const t = this.now()

    // Pass 1 — mint ids + build the origin-note → new-id remap (for supersede rewrite).
    // Authored entries (no originNoteId) don't participate in the remap.
    const ids = entries.map(() => this.mintId())
    const remap = new Map<string, string>()
    entries.forEach((e, i) => {
      if (e.originNoteId) remap.set(e.originNoteId, ids[i])
    })

    const result: WorkspaceFinding[] = []
    entries.forEach((e, i) => {
      const status = e.status ?? "active"
      // Rewrite the supersede pointer through the batch remap. If superseded but the
      // corrector wasn't promoted in this batch, keep superseded with no pointer.
      const supersededBy =
        status === "superseded" && e.supersededBy ? remap.get(e.supersededBy) : undefined

      // Idempotency: a promoted (not authored) entry whose (originSessionId,
      // originNoteId) pair already exists is UPDATED in place, not duplicated.
      const existing =
        e.originNoteId != null
          ? record.findings.find(
              (f) => f.originSessionId === e.originSessionId && f.originNoteId === e.originNoteId,
            )
          : undefined

      if (existing) {
        existing.text = e.text
        existing.status = status
        existing.supersededBy = supersededBy
        existing.source = e.source ?? existing.source
        existing.promotedAt = t
        if (typeof e.createdAt === "number") existing.createdAt = e.createdAt
        result.push(existing)
      } else {
        const finding: WorkspaceFinding = {
          id: ids[i],
          text: e.text,
          createdAt: typeof e.createdAt === "number" ? e.createdAt : t,
          source: e.source ?? "self",
          status,
          ...(supersededBy ? { supersededBy } : {}),
          ...(e.originSessionId != null ? { originSessionId: e.originSessionId } : {}),
          ...(e.originNoteId != null ? { originNoteId: e.originNoteId } : {}),
          promotedAt: t,
        }
        record.findings.push(finding)
        result.push(finding)
      }
    })

    this.persistAndEmit(key, record)
    return result
  }

  /**
   * Delete one REAL workspace's memory file (and drop its cache entry). REFUSES the
   * untagged sentinel (logs a warning, no-ops) — the global "All" bucket is never
   * wiped through this path. NOT auto-invoked on workspace delete in v1 (memory is
   * left orphaned-but-recoverable); kept for a future explicit affordance + tests.
   */
  deleteForWorkspace(workspaceId: string): void {
    if (workspaceId == null || workspaceId === UNTAGGED_STEM) {
      logWarn("workspaceMemory", `refusing to delete the untagged memory bucket`)
      return
    }
    const key = this.keyFor(workspaceId) // also rejects the reserved stem defensively
    this.cache.delete(key)
    try {
      unlinkSync(this.fileFor(key))
    } catch {
      /* already gone — nothing to do */
    }
  }

  /**
   * Drop the in-memory cache and re-warm it from disk, then notify subscribers.
   * Used after a LocalHistory restore (CAPP-95 / D1) overwrites a bucket file
   * out-of-band: without this the service would keep serving the stale cached
   * record. Re-fires `onMemoryChanged` for every reloaded bucket so the recall
   * index invalidates and any open editor panel live-refreshes. The emitted id is
   * the record's STORED id (the untagged stem for the untagged bucket).
   */
  reload(): void {
    this.cache.clear()
    this.loadAll()
    // Emit once per (re)loaded bucket so subscribers refresh. A bucket whose file
    // was deleted by the restore simply won't be in the cache → no stale emit.
    for (const record of this.cache.values()) {
      for (const cb of this.listeners) cb(record.workspaceId)
    }
  }

  // ── change seam ────────────────────────────────────────────────────────────────

  /** Subscribe to memory changes. Returns an unsubscribe fn. Mirrors
   *  {@link WorkspaceService.onActiveChanged}: `ipc.ts` registers one callback that
   *  invalidates recall + pushes `workspace:memory-changed` to the renderer. */
  onMemoryChanged(cb: (workspaceId: string) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
}
