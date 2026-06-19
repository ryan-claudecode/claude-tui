import { spawn } from "child_process"
import { join, isAbsolute } from "node:path"
import { homedir } from "node:os"
import { existsSync, statSync, writeFileSync } from "node:fs"
import { discoverWorkspaces, canonSeedDir, type DiscoveredManifest, type WorkspaceRepo } from "../workspace/discovery"
import type { TerminalService, TerminalInfo } from "./terminals"
import { loadVersioned, saveVersioned, type Migration } from "../persist"
import { logWarn } from "../log"

/**
 * The durable workspace MODEL (WS-A). A workspace is a user-named grouping of
 * one-or-more directories (manifest-optional), identified by a stable registry
 * uuid. The registry (`~/.claude-tui/workspaces.json`) is the SOURCE OF TRUTH;
 * discovery is demoted to a seed/import path.
 *
 * The optional `seed*` fields exist only to keep two seams working without a
 * dedicated B/C/D strand:
 *  - `seedDir` — the CANONICALIZED (`canonSeedDir`) manifest directory this entry
 *    is keyed by. It is the STABLE de-dup key: a re-scan that re-encounters the
 *    same manifest dir updates the existing entry instead of creating a duplicate.
 *    Set either when an entry is imported from a discovered manifest OR when a
 *    hand-created/added dir is scaffolded (WS-G) — in which case it is bound to the
 *    FIRST scaffolded dir NOT already owned as another workspace's `seedDir` (so no
 *    two entries share a seedDir key). Absent only when an entry has no eligible
 *    canonical dir to claim (every key was already taken); such entries still
 *    de-dup on rescan via `discover`'s `byListedDir` dir-match.
 *  - `seedRepos` / `seedEditor` — the manifest's richer repo metadata, retained so
 *    the legacy `activate()` boot path (open editors + spawn one session per repo)
 *    still works for imported workspaces. Not part of the public model surface.
 */
export interface Workspace {
  id: string
  name: string
  dirs: string[]
  color?: string
  createdAt: number
  updatedAt: number
  /** Canonicalized (`canonSeedDir`) manifest/scaffold dir this entry is keyed by
   *  (the de-dup key). Unique across the registry; unset only when no eligible
   *  canonical dir was free to claim. */
  seedDir?: string
  /** Manifest repo metadata, retained so `activate()` can still open editors +
   *  spawn per-repo sessions for imported workspaces. */
  seedRepos?: WorkspaceRepo[]
  seedEditor?: string
}

/**
 * The PUBLIC projection of a workspace — the registry-owned, user-facing fields
 * only. The internal `seed*` fields (`seedDir`/`seedRepos`/`seedEditor`) are
 * boot/import plumbing and MUST NOT leak across the MCP surface
 * (`list_workspaces` / `get_app_state`), so `listPublic()` returns this shape.
 */
export interface PublicWorkspace {
  id: string
  name: string
  dirs: string[]
  color?: string
  createdAt: number
  updatedAt: number
}

/**
 * WS-B — the service-level event seam for active-workspace changes. Callback-set
 * style, mirroring {@link MissionService.onEvent} (the `mission:updated` push):
 * `ipc.ts` registers a callback that forwards each event to the renderer over the
 * `workspace:active-changed` IPC channel. Keeping `BrowserWindow` out of this
 * service (no `setMainWindow`) keeps it testable — a test asserts the event by
 * subscribing directly, with no Electron window.
 *
 * `active` is the PUBLIC projection of the newly-active workspace, or `null` when
 * the active selection was cleared (or pointed at a deleted workspace). It is
 * NEVER the internal `Workspace` (with `seed*` fields) — the same no-leak posture
 * as `listPublic()`.
 */
export interface WorkspaceActiveChangedEvent {
  active: PublicWorkspace | null
}

/**
 * The on-disk registry payload. `activeWorkspaceId` lives as a TOP-LEVEL field
 * of this one cohesive durable store (NOT a separate file and NOT in the
 * versioned config) so the registry + the active selection load/save atomically
 * together and can't drift apart. WS-B will add the `workspace:active-changed`
 * event + the IPC/MCP surface on top of this persisted field.
 */
interface WorkspaceRegistry {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
}

/** Persistence schema version for workspaces.json. v1 = today's shape verbatim;
 *  starts at its OWN 1 (independent of the missions/sessions stores). */
const SCHEMA_VERSION = 1
const MIGRATIONS: Migration[] = []

/** Strip the internal `seed*` fields from a stored workspace, yielding the
 *  public, registry-owned projection. */
function toPublic(ws: Workspace): PublicWorkspace {
  return {
    id: ws.id,
    name: ws.name,
    dirs: ws.dirs,
    color: ws.color,
    createdAt: ws.createdAt,
    updatedAt: ws.updatedAt,
  }
}

// The single workspace-dir canonicalizer now lives in discovery.ts (so discovery
// can use it without a circular import). It's imported above for the registry's
// bind/lookup call sites; re-exported here for the existing test imports + any
// external caller that historically imported it from this module.
export { canonSeedDir }

/** Structural equality for the manifest-owned `seedRepos` metadata, so discovery
 *  only re-persists when the repo list genuinely changed (not on every boot). */
function sameRepos(a: WorkspaceRepo[] | undefined, b: WorkspaceRepo[] | undefined): boolean {
  const x = a ?? []
  const y = b ?? []
  if (x.length !== y.length) return false
  return x.every((r, i) => {
    const s = y[i]
    return r.name === s.name && r.path === s.path && r.open_on_boot === s.open_on_boot
  })
}

/**
 * Registry-backed, persisted workspace container service. Reworked from the
 * boot-only launcher: `loadAll()` on construction, every mutator persists, and
 * discovery SEEDS the registry instead of replacing it.
 */
export class WorkspaceService {
  private file: string
  private now: () => number
  private workspaces = new Map<string, Workspace>()
  private activeWorkspaceId: string | null = null
  private sessionService: TerminalService
  /** WS-B — active-changed subscribers (callback-set, like MissionService). */
  private activeListeners = new Set<(e: WorkspaceActiveChangedEvent) => void>()
  /**
   * WS-G (G3) — a user-visible notification seam (set in ipc.ts to
   * NotificationService.notify). Used to TOAST when scaffolding a `workspace.json`
   * manifest into a newly-added directory. Optional: undefined in most unit tests,
   * where scaffolding still happens (the file is written) but no toast fires.
   */
  private notify?: (message: string, level: "info" | "success" | "warning" | "error", title?: string) => void

  constructor(
    sessionService: TerminalService,
    opts: {
      file?: string
      now?: () => number
      notify?: (message: string, level: "info" | "success" | "warning" | "error", title?: string) => void
    } = {},
  ) {
    this.sessionService = sessionService
    this.file = opts.file ?? join(homedir(), ".claude-tui", "workspaces.json")
    this.now = opts.now ?? (() => Date.now())
    this.notify = opts.notify
    this.loadAll()
  }

  /** WS-G (G3) — wire the user-visible notification seam after construction
   *  (ipc.ts, once NotificationService exists). Mirrors TerminalService.setNotifier. */
  setNotifier(
    fn: (message: string, level: "info" | "success" | "warning" | "error", title?: string) => void,
  ): void {
    this.notify = fn
  }

  private loadAll(): void {
    // loadVersioned returns undefined for a missing OR corrupt file (it logs a
    // warning on corrupt JSON instead of swallowing it) — either way we start
    // from an empty registry rather than crashing construction.
    const reg = loadVersioned<WorkspaceRegistry>(this.file, SCHEMA_VERSION, MIGRATIONS)
    if (!reg || !Array.isArray(reg.workspaces)) return
    for (const ws of reg.workspaces) {
      if (!ws || typeof ws.id !== "string") continue
      // Normalize each admitted entry so a persisted/hand-edited record that is
      // missing fields can't crash a later mutator: `addDir`/`removeDir` assume
      // `dirs` is an array (`.includes`/`.filter`), and `list()` sorts on the
      // timestamps. Default the user-facing fields rather than rejecting the row.
      const t = this.now()
      this.workspaces.set(ws.id, {
        ...ws,
        name: typeof ws.name === "string" ? ws.name : "",
        dirs: Array.isArray(ws.dirs) ? ws.dirs : [],
        createdAt: typeof ws.createdAt === "number" ? ws.createdAt : t,
        updatedAt: typeof ws.updatedAt === "number" ? ws.updatedAt : t,
      })
    }
    // Only honor a persisted active id that still resolves to a real workspace.
    this.activeWorkspaceId =
      reg.activeWorkspaceId && this.workspaces.has(reg.activeWorkspaceId) ? reg.activeWorkspaceId : null
  }

  private persist(): void {
    const reg: WorkspaceRegistry = {
      workspaces: Array.from(this.workspaces.values()),
      activeWorkspaceId: this.activeWorkspaceId,
    }
    // Write-then-rename (in saveVersioned): a crash mid-write leaves the prior
    // valid registry intact rather than a truncated one.
    saveVersioned(this.file, SCHEMA_VERSION, reg)
  }

  /** Reuse the same id-minting scheme as MissionService — time + random suffix.
   *  No uuid dependency is added. */
  private mintId(): string {
    return `ws-${this.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  // ── Registry API ──────────────────────────────────────────────────────────

  list(): Workspace[] {
    return Array.from(this.workspaces.values()).sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Public, registry-owned projection of `list()` — strips the internal `seed*`
   *  boot/import fields so they don't leak across the MCP surface. */
  listPublic(): PublicWorkspace[] {
    return this.list().map(toPublic)
  }

  get(id: string): Workspace | undefined {
    return this.workspaces.get(id)
  }

  /** WS-B — public projection of the active workspace (or null), for the
   *  `getActiveWorkspace()` IPC + the `workspace:active-changed` payload. Never
   *  leaks the internal `seed*` fields (same posture as `listPublic`). */
  getActivePublic(): PublicWorkspace | null {
    const ws = this.getActive()
    return ws ? toPublic(ws) : null
  }

  /**
   * WS-B — subscribe to active-workspace changes. Returns an unsubscribe fn.
   * Mirrors {@link MissionService.onEvent}: `ipc.ts` registers one callback that
   * forwards every event to the renderer over `workspace:active-changed`.
   */
  onActiveChanged(cb: (e: WorkspaceActiveChangedEvent) => void): () => void {
    this.activeListeners.add(cb)
    return () => this.activeListeners.delete(cb)
  }

  /** Fan one active-changed event out to all subscribers (the public projection
   *  of the now-active workspace, or null). */
  private emitActiveChanged(): void {
    const e: WorkspaceActiveChangedEvent = { active: this.getActivePublic() }
    for (const cb of this.activeListeners) cb(e)
  }

  create(name: string, dirs: string[] = []): Workspace {
    const t = this.now()
    const ws: Workspace = {
      id: this.mintId(),
      name,
      dirs: [...dirs],
      createdAt: t,
      updatedAt: t,
    }
    this.workspaces.set(ws.id, ws)
    // WS-G (G3) — scaffold a workspace.json into each provided dir so the workspace
    // is self-documenting + re-discoverable, binding seedDir so a later rescan maps
    // the manifest back to THIS entry (no duplicate). Mutates ws.seedDir; persist after.
    for (const dir of ws.dirs) this.scaffoldManifest(ws, dir)
    this.persist()
    return ws
  }

  rename(id: string, name: string): Workspace | undefined {
    const ws = this.workspaces.get(id)
    if (!ws) return undefined
    ws.name = name
    ws.updatedAt = this.now()
    this.persist()
    return ws
  }

  addDir(id: string, dir: string): Workspace | undefined {
    const ws = this.workspaces.get(id)
    if (!ws) return undefined
    if (!ws.dirs.includes(dir)) {
      ws.dirs.push(dir)
      ws.updatedAt = this.now()
      // WS-G (G3) — scaffold a workspace.json into the newly-added dir (+ bind
      // seedDir for rescan-dedup). Mutates ws before the persist below.
      this.scaffoldManifest(ws, dir)
      this.persist()
    }
    return ws
  }

  removeDir(id: string, dir: string): Workspace | undefined {
    const ws = this.workspaces.get(id)
    if (!ws) return undefined
    const next = ws.dirs.filter((d) => d !== dir)
    if (next.length !== ws.dirs.length) {
      ws.dirs = next
      ws.updatedAt = this.now()
      this.persist()
    }
    return ws
  }

  delete(id: string): boolean {
    if (!this.workspaces.has(id)) return false
    this.workspaces.delete(id)
    // Clear the active selection if it pointed at the deleted workspace so a
    // stale id can't linger in the persisted store.
    const clearedActive = this.activeWorkspaceId === id
    if (clearedActive) this.activeWorkspaceId = null
    this.persist()
    // WS-B — deleting the active workspace IS an active change (it became null),
    // so notify the renderer just like setActive(null) would. A delete of a
    // non-active workspace leaves the active selection untouched → no emit.
    if (clearedActive) this.emitActiveChanged()
    return true
  }

  /**
   * Set (or clear, with null) the active workspace. A non-existent id is
   * ignored (returns false) so the active selection always resolves.
   *
   * WS-B — SELECTION-ONLY. This sets the active workspace, persists it, and emits
   * `workspace:active-changed`. It deliberately does NOT spawn editors or
   * sessions — selection ≠ launch. The boot/spawn behavior lives in `launch(id)`
   * (and the legacy index-based `activate(index)`), kept as a SEPARATE explicit
   * path so a make-active never has the side effect of opening windows.
   */
  setActive(id: string | null): boolean {
    if (id !== null && !this.workspaces.has(id)) return false
    // Skip the emit on a genuine no-op so a redundant re-select doesn't churn the
    // renderer (and never persists a write that changes nothing).
    if (this.activeWorkspaceId === id) return true
    this.activeWorkspaceId = id
    this.persist()
    this.emitActiveChanged()
    return true
  }

  getActive(): Workspace | null {
    return this.activeWorkspaceId ? this.workspaces.get(this.activeWorkspaceId) ?? null : null
  }

  getActiveId(): string | null {
    return this.activeWorkspaceId
  }

  /**
   * WS-G (G1) — the active workspace's PRIMARY directory (`dirs[0]`), resolved to an
   * absolute, existing path, or null. This is the spawn cwd seam: when a NEW work
   * session is created while a workspace is active and has ≥1 dir, its terminal(s)
   * spawn HERE so `claude` runs as if opened in that directory (sees its files + git).
   *
   * Returns null — meaning "keep the current default cwd behavior" — when there is no
   * active workspace, the active workspace has no dirs, or `dirs[0]` does not resolve
   * to an existing directory on disk (a stale/typo'd path must never silently spawn an
   * agent in a non-existent or wrong place; we fall back to the default instead).
   * `~`-prefixed dirs are expanded; a relative dir is rejected (we only ever spawn in
   * a known-absolute, verified directory).
   */
  getActiveWorkspaceDir(): string | null {
    const ws = this.getActive()
    const first = ws?.dirs?.[0]
    if (!first) return null
    const expanded = this.expandHome(first)
    if (!isAbsolute(expanded)) return null
    try {
      if (!statSync(expanded).isDirectory()) return null
    } catch {
      return null // missing / unreadable → fall back to default cwd
    }
    return expanded
  }

  // ── Discovery = seed/import (NOT source of truth) ───────────────────────────

  /**
   * Scan `scanPaths` for `workspace.json` manifests and SEED them into the
   * registry. A manifest is keyed by its canonicalized absolute dir
   * (`canonSeedDir(seedDir)`): if no entry already represents that dir, it
   * becomes a new registry entry (a full one-time seed); if one does, the seed
   * is SEED-ONCE for the user-owned fields.
   *
   * SEED-ONCE POLICY (zero data-loss — the registry is the source of truth):
   *  - `name` + `dirs` are USER-OWNED once an entry exists. Discovery NEVER
   *    refreshes them, so a user's rename()/addDir()/removeDir() on an imported
   *    workspace survives every subsequent boot/re-scan. (Pre-fix this branch
   *    overwrote them from the manifest, silently reverting user edits.)
   *  - `seedRepos` + `seedEditor` are MANIFEST-OWNED boot metadata (they drive
   *    the legacy `activate()` editor-spawn and are NOT user-editable via the
   *    registry API), so they MAY be refreshed — but ONLY when they actually
   *    differ from the stored value, so a steady-state re-discover (unchanged
   *    manifests) performs ZERO writes and never bumps `updatedAt`.
   *
   * So a re-scan NEVER duplicates a previously-seeded workspace and NEVER
   * clobbers user edits. Hand-created workspaces (no `seedDir`) are untouched.
   * A manifest disappearing from disk is deliberately IGNORED here — discovery
   * only adds/refreshes, never deletes; the registry is the source of truth, so
   * a vanished manifest leaves its registry entry intact (no auto-delete).
   * Persists once, and only if something actually changed.
   */
  discover(scanPaths: string[]): void {
    const manifests = discoverWorkspaces(scanPaths)
    const bySeedDir = new Map<string, Workspace>()
    // WS-G (G3) — belt-and-suspenders rescan-dedup. The PRIMARY de-dup key is
    // `seedDir` (one per entry). But a hand-created/edited workspace can list SEVERAL
    // scaffolded dirs while only the FIRST is bound as `seedDir`; a rescan would then
    // re-discover the OTHER scaffolded manifests, miss them in `bySeedDir`, and mint a
    // DUPLICATE. So we ALSO index every workspace's listed dirs (canonicalized) and
    // reconcile a manifest against an existing workspace that already lists that dir.
    const byListedDir = new Map<string, Workspace>()
    for (const ws of this.workspaces.values()) {
      if (ws.seedDir) bySeedDir.set(canonSeedDir(ws.seedDir), ws)
      for (const d of ws.dirs) {
        const k = canonSeedDir(this.expandHome(d))
        // First writer wins so an explicit seedDir owner is never shadowed.
        if (!byListedDir.has(k)) byListedDir.set(k, ws)
      }
    }

    let changed = false
    for (const m of manifests) {
      const key = canonSeedDir(m.dir)
      // Prefer the seedDir owner; fall back to any workspace already listing this dir.
      const existing = bySeedDir.get(key) ?? byListedDir.get(key)
      if (existing) {
        // Seed-once: leave user-owned name/dirs alone. Only refresh the
        // manifest-owned boot metadata, and only on a REAL delta — so an
        // unchanged manifest is a no-op (no persist, no updatedAt bump).
        if (!sameRepos(existing.seedRepos, m.repos) || existing.seedEditor !== m.editor) {
          existing.seedRepos = m.repos
          existing.seedEditor = m.editor
          existing.updatedAt = this.now()
          changed = true
        }
      } else {
        // New (unseen) manifest → full one-time seed.
        const t = this.now()
        const ws: Workspace = {
          id: this.mintId(),
          name: m.name,
          dirs: this.manifestDirs(m),
          createdAt: t,
          updatedAt: t,
          // Store the canonicalized dir so the de-dup key is stable across
          // reloads regardless of the drive-letter case a scan produced.
          seedDir: key,
          seedRepos: m.repos,
          seedEditor: m.editor,
        }
        this.workspaces.set(ws.id, ws)
        bySeedDir.set(key, ws)
        changed = true
      }
    }
    if (changed) this.persist()
  }

  /**
   * WS-F — the user-triggerable RE-SCAN. Re-runs the boot-time {@link discover}
   * against `scanPaths` (the live action behind the switcher's ⟳ refresh control +
   * the `rescan_workspaces` MCP tool), then returns the updated PUBLIC list so the
   * caller can re-render without a second read.
   *
   * It deliberately REUSES `discover` verbatim — same seed-once policy: a re-scan
   * SEEDS newly-added manifests, NEVER duplicates a previously-seeded workspace
   * (canonicalized seedDir de-dup key), and NEVER clobbers user edits
   * (name/dirs are user-owned). A vanished manifest is ignored (the registry is the
   * source of truth — discovery only adds/refreshes). So calling it boot-only vs.
   * on demand differs only in WHEN it runs, not WHAT it does. Returns `listPublic()`
   * (never the internal `seed*` fields).
   */
  rescan(scanPaths: string[]): PublicWorkspace[] {
    this.discover(scanPaths)
    return this.listPublic()
  }

  /** The directories a manifest contributes to a workspace: its repo paths if it
   *  declares any, otherwise the manifest dir itself. */
  private manifestDirs(m: DiscoveredManifest): string[] {
    const repoDirs = m.repos.map((r) => this.expandHome(r.path)).filter(Boolean)
    return repoDirs.length ? repoDirs : [m.dir]
  }

  private expandHome(p: string): string {
    return p.replace(/^~/, process.env.HOME ?? process.env.USERPROFILE ?? "")
  }

  // ── Scaffold (WS-G / G3) ────────────────────────────────────────────────────

  /** Does any workspace OTHER than `selfId` already own `key` (a canonicalized
   *  dir) as its `seedDir`? Used by the scaffold bind so two entries never share a
   *  seedDir de-dup key. Compares already-canonical keys (seedDir is stored
   *  canonicalized) so no re-canonicalization is needed here. */
  private seedDirOwnedByOther(selfId: string, key: string): boolean {
    for (const other of this.workspaces.values()) {
      if (other.id !== selfId && other.seedDir === key) return true
    }
    return false
  }

  /**
   * WS-G (G3) — write a minimal `workspace.json` manifest into `dir` so the
   * workspace is self-documenting + re-discoverable, and TOAST the user. The
   * manifest shape MUST match what {@link discoverWorkspaces} parses
   * (`{ name, alias?, editor?, repos? }`) so it round-trips through the seed-once
   * `discover`. We write the minimum valid manifest: the workspace `name` (alias =
   * "", editor = "code", repos = []), so a future rescan re-imports it cleanly.
   *
   * RESCAN-DUPLICATE PREVENTION (the trap): a hand-created workspace has NO seedDir,
   * so a later rescan would discover the scaffolded manifest, find no entry keyed by
   * that dir, and mint a DUPLICATE. We prevent it by BINDING this dir to the existing
   * entry — set `ws.seedDir` to the canonicalized scaffolded dir if the workspace has
   * none yet AND no OTHER workspace already owns that dir as ITS seedDir — so a rescan
   * maps the manifest back to THIS workspace WITHOUT two entries sharing a seedDir key.
   * (When the bind is skipped because of a collision, the `discover` belt-and-suspenders
   * dir-match still de-dups via `byListedDir`. For a multi-dir workspace only the first
   * eligible scaffold binds `seedDir`; the rest ride the dir-match. All layers keep
   * rescans duplicate-free.)
   *
   * NO-CLOBBER: if `dir` already has a `workspace.json` we skip the write entirely
   * (never overwrite a user's/another workspace's manifest) and do NOT toast a
   * "created" message. We STILL bind `seedDir` so the existing manifest reconciles to
   * this entry on rescan (no duplicate from a pre-existing manifest either).
   *
   * Best-effort + never throws: a bad/relative/missing dir or an unwritable path is
   * logged + skipped (the workspace is still created/updated — scaffolding is a
   * convenience, not a hard requirement).
   */
  private scaffoldManifest(ws: Workspace, dir: string): void {
    const target = this.expandHome(dir)
    if (!isAbsolute(target)) return // only ever scaffold into a known-absolute dir
    let isDir: boolean
    try {
      isDir = existsSync(target) && statSync(target).isDirectory()
    } catch {
      return
    }
    if (!isDir) return

    // Bind seedDir so a rescan reconciles the manifest back to THIS workspace
    // (rescan-duplicate prevention). Only bind once — the first eligible scaffolded
    // dir owns it — and never to a (canonical) dir another workspace already owns as
    // ITS seedDir, so two entries can't share a seedDir key (byListedDir still de-dups
    // the skipped case on rescan).
    if (!ws.seedDir) {
      const key = canonSeedDir(target)
      if (!this.seedDirOwnedByOther(ws.id, key)) ws.seedDir = key
    }

    const manifestPath = join(target, "workspace.json")
    // NO-CLOBBER: never overwrite an existing manifest (could be another workspace's
    // or a user-authored one). The seedDir bind above still makes it reconcile.
    if (existsSync(manifestPath)) return

    const manifest = {
      name: ws.name,
      alias: "",
      editor: "code",
      repos: [] as WorkspaceRepo[],
    }
    try {
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
      this.notify?.(`Created workspace.json in ${target}`, "success", "Workspace")
    } catch (err) {
      logWarn("workspaces", `could not scaffold workspace.json in ${target}: ${err}`)
    }
  }

  // ── Boot/launch path (SELECTION is separate — see setActive) ────────────────
  //
  // WS-B — the BOOT/SPAWN verb, deliberately split from `setActive` (selection).
  // `setActive(id)` only marks the active workspace + emits; it never opens
  // editors or spawns sessions. The launch behavior lives here:
  //   • `activate(index)` — LEGACY index-addressed entry point, retained UNCHANGED
  //     for the renderer's current `onSelectWorkspace(index)` → `activateWorkspace`
  //     wiring (the id-based renderer cutover is WS-D). Still spawns, as before.
  //   • `launch(id)` — the NEW id-addressed boot verb (the registry is
  //     uuid-addressed). Same spawn behavior, resolved by stable id.
  // Both delegate to the shared `launchWorkspace(ws)` body, so the index path is
  // byte-identical to before the split.

  /**
   * Boot a workspace by its position in `list()`. Index-addressing is retained
   * ONLY here for backward-compat with the renderer's current
   * `onSelectWorkspace(index)` wiring — the registry itself is uuid-addressed.
   * Opens editors for `open_on_boot` repos and spawns one session per repo (for
   * seeded/imported workspaces), or one session per `dirs[]` entry (for
   * hand-created workspaces with no manifest repos). This is the LAUNCH verb,
   * distinct from `setActive` (SELECTION). WS-D moves the renderer to id-based
   * `setActive` for selection, leaving launch as a separate explicit action.
   */
  activate(index: number): { workspace: string; sessions: TerminalInfo[] } | null {
    const ws = this.list()[index]
    if (!ws) return null
    return this.launchWorkspace(ws)
  }

  /**
   * WS-B — boot a workspace by its STABLE registry id (the uuid-addressed twin of
   * the legacy `activate(index)`). Spawns editors + sessions exactly like
   * `activate`; returns null for an unknown id. This is the LAUNCH path, kept
   * SEPARATE from `setActive(id)` (selection-only) so "make active" and "boot the
   * workspace" are two distinct, explicit operations.
   */
  launch(id: string): { workspace: string; sessions: TerminalInfo[] } | null {
    const ws = this.workspaces.get(id)
    if (!ws) return null
    return this.launchWorkspace(ws)
  }

  /** Shared spawn body for `activate(index)` and `launch(id)`: open editors for
   *  `open_on_boot` repos, then create one Claude session per manifest repo (for
   *  imported workspaces) or per `dirs[]` entry (for hand-created ones). */
  private launchWorkspace(ws: Workspace): { workspace: string; sessions: TerminalInfo[] } {
    const repos = ws.seedRepos ?? []
    const editorCmd = (ws.seedEditor ?? "code").toLowerCase()

    // Open editors for repos marked open_on_boot (imported workspaces only).
    for (const repo of repos) {
      if (repo.open_on_boot) {
        const editorRepoPath = this.expandHome(repo.path)
        spawn(editorCmd, ["--new-window", editorRepoPath], {
          detached: true,
          stdio: "ignore",
        }).unref()
      }
    }

    // Create Claude sessions: one per manifest repo if present, else one per dir.
    const created: TerminalInfo[] = []
    if (repos.length) {
      for (const repo of repos) {
        const info = this.sessionService.create(repo.name, this.expandHome(repo.path))
        created.push(info)
      }
    } else {
      for (const dir of ws.dirs) {
        const info = this.sessionService.create(ws.name, this.expandHome(dir))
        created.push(info)
      }
    }
    return { workspace: ws.name, sessions: created }
  }
}
