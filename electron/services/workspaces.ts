import { spawn } from "child_process"
import { join } from "node:path"
import { homedir } from "node:os"
import { discoverWorkspaces, type DiscoveredManifest, type WorkspaceRepo } from "../workspace/discovery"
import type { TerminalService, TerminalInfo } from "./terminals"
import { loadVersioned, saveVersioned, type Migration } from "../persist"

/**
 * The durable workspace MODEL (WS-A). A workspace is a user-named grouping of
 * one-or-more directories (manifest-optional), identified by a stable registry
 * uuid. The registry (`~/.claude-tui/workspaces.json`) is the SOURCE OF TRUTH;
 * discovery is demoted to a seed/import path.
 *
 * The optional `seed*` fields exist only to keep two seams working without a
 * dedicated B/C/D strand:
 *  - `seedDir` — the absolute `workspace.json` manifest directory this entry was
 *    imported from. It is the STABLE de-dup key: a re-scan that re-encounters the
 *    same manifest dir updates the existing entry instead of creating a duplicate.
 *    Absent for entries created directly via `create()`.
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
  /** Absolute manifest dir this entry was seeded from (de-dup key); unset for
   *  hand-created workspaces. */
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

/**
 * Canonicalize a manifest dir for use as the seedDir de-dup key. On win32 the
 * drive letter's case is not significant (`c:\` and `C:\` are the same path),
 * yet `path.resolve` preserves whatever case the scan glob produced — so a
 * config spelling change between scans would otherwise mint a duplicate entry.
 * Upper-casing the leading `<letter>:` collapses those spellings to one key.
 * KNOWN LIMITATION: this does NOT resolve junctions/symlinks or `8.3` short
 * names — two genuinely different spellings of the same target still dup.
 */
export function canonSeedDir(dir: string): string {
  return process.platform === "win32"
    ? dir.replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`)
    : dir
}

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

  constructor(sessionService: TerminalService, opts: { file?: string; now?: () => number } = {}) {
    this.sessionService = sessionService
    this.file = opts.file ?? join(homedir(), ".claude-tui", "workspaces.json")
    this.now = opts.now ?? (() => Date.now())
    this.loadAll()
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
    if (this.activeWorkspaceId === id) this.activeWorkspaceId = null
    this.persist()
    return true
  }

  /** Set (or clear, with null) the active workspace. A non-existent id is
   *  ignored (returns false) so the active selection always resolves. */
  setActive(id: string | null): boolean {
    if (id !== null && !this.workspaces.has(id)) return false
    this.activeWorkspaceId = id
    this.persist()
    return true
  }

  getActive(): Workspace | null {
    return this.activeWorkspaceId ? this.workspaces.get(this.activeWorkspaceId) ?? null : null
  }

  getActiveId(): string | null {
    return this.activeWorkspaceId
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
    for (const ws of this.workspaces.values()) {
      if (ws.seedDir) bySeedDir.set(canonSeedDir(ws.seedDir), ws)
    }

    let changed = false
    for (const m of manifests) {
      const key = canonSeedDir(m.dir)
      const existing = bySeedDir.get(key)
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

  /** The directories a manifest contributes to a workspace: its repo paths if it
   *  declares any, otherwise the manifest dir itself. */
  private manifestDirs(m: DiscoveredManifest): string[] {
    const repoDirs = m.repos.map((r) => this.expandHome(r.path)).filter(Boolean)
    return repoDirs.length ? repoDirs : [m.dir]
  }

  private expandHome(p: string): string {
    return p.replace(/^~/, process.env.HOME ?? process.env.USERPROFILE ?? "")
  }

  // ── Legacy boot/launch path (kept working; WS-B will separate make-active
  //    from launch) ────────────────────────────────────────────────────────────

  /**
   * Boot a workspace by its position in `list()`. Index-addressing is retained
   * ONLY here for backward-compat with the renderer's current
   * `onSelectWorkspace(index)` wiring — the registry itself is uuid-addressed.
   * Opens editors for `open_on_boot` repos and spawns one session per repo (for
   * seeded/imported workspaces), or one session per `dirs[]` entry (for
   * hand-created workspaces with no manifest repos). WS-B replaces this with an
   * id-based make-active-vs-launch split.
   */
  activate(index: number): { workspace: string; sessions: TerminalInfo[] } | null {
    const ws = this.list()[index]
    if (!ws) return null

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
