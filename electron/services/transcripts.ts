import { readdirSync, statSync } from "fs"
import { join } from "path"
import { encodeProjectDir } from "./terminals"

/**
 * A pending request to bind a freshly-spawned terminal to the Claude Code
 * transcript (`.jsonl`) it is about to start writing.
 */
interface Expectation {
  terminalId: string
  cwd: string
  /** Epoch ms when the terminal spawned — a transcript must be ≥ this (minus skew). */
  spawnedAt: number
}

/** Per-project-dir polling state: which terminals are waiting, and the snapshot
 *  of transcripts that already existed when the first of them registered. */
interface DirState {
  /** Encoded project dir name (Claude Code's `~/.claude/projects/<encoded>`). */
  encoded: string
  /** The on-disk transcript ids present when the dir's first expectation
   *  registered. A transcript in this baseline is never assigned — it belongs
   *  to a sibling terminal that booted before us. */
  baseline: Set<string>
  /** Pending expectations for this cwd, kept in registration (spawn) order so we
   *  can hand the oldest a newly-appeared transcript. */
  expectations: Expectation[]
}

/**
 * TranscriptAssigner — one shared poll loop that binds spawned terminals to the
 * Claude Code conversation transcripts they create.
 *
 * Replaces the old per-terminal 30s `setInterval` pollers (one per spawn, each
 * independently scanning the same project dir and racing siblings). Instead:
 *
 * - Terminals `expect(...)` when they spawn and `cancel(...)` when they die or
 *   capture an id.
 * - A SINGLE 1s loop scans each project dir that has ≥1 pending expectation.
 *   When a NEW `.jsonl` appears (not in that dir's baseline snapshot and not
 *   already claimed process-wide), it is assigned to the OLDEST pending
 *   expectation for that cwd whose `spawnedAt` ≤ the file's mtime (+skew).
 *   One file → one terminal, atomically, in one place — no cross-terminal race
 *   is possible by construction.
 * - There is NO give-up: an expectation lives until its terminal exits or
 *   captures an id. The shared loop idles (no timer) whenever nothing is pending,
 *   so a long-lived expectation leaks nothing.
 */
export class TranscriptAssigner {
  /** Keyed by encoded project dir name. */
  private dirs = new Map<string, DirState>()
  private timer: ReturnType<typeof setInterval> | null = null

  /**
   * @param projectsRoot  Root of Claude Code's project transcript dirs
   *   (production: `~/.claude/projects`; injectable for tests).
   * @param claimedConvoIds  Process-wide set of already-claimed transcript ids,
   *   shared (by reference) with TerminalService so a resumed terminal's
   *   pre-claim is visible here and an assigned id is visible to resumes.
   * @param onAssign  Called when a transcript is bound to a terminal.
   * @param pollMs  Poll interval (default 1000ms).
   */
  constructor(
    private readonly projectsRoot: string,
    private readonly claimedConvoIds: Set<string>,
    private readonly onAssign: (terminalId: string, ccConversationId: string) => void,
    private readonly pollMs = 1000,
  ) {}

  /**
   * Register a freshly-spawned terminal as awaiting its transcript. Snapshots the
   * dir's existing transcripts as the baseline the first time a cwd is seen, so
   * only a transcript that appears AFTER registration can be assigned.
   */
  expect(exp: Expectation): void {
    const encoded = encodeProjectDir(exp.cwd)
    let dir = this.dirs.get(encoded)
    if (!dir) {
      dir = { encoded, baseline: this.listIds(encoded), expectations: [] }
      this.dirs.set(encoded, dir)
    }
    dir.expectations.push({ ...exp })
    this.ensureRunning()
  }

  /**
   * Drop a terminal's pending expectation (it died, or already captured an id).
   * Cleans up the dir entry — and stops the shared loop — once nothing is pending.
   */
  cancel(terminalId: string): void {
    for (const [encoded, dir] of this.dirs) {
      const before = dir.expectations.length
      dir.expectations = dir.expectations.filter((e) => e.terminalId !== terminalId)
      if (dir.expectations.length !== before && dir.expectations.length === 0) {
        this.dirs.delete(encoded)
      }
    }
    this.stopIfIdle()
  }

  /** Stop everything (app teardown). */
  dispose(): void {
    this.dirs.clear()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** True while the shared poll loop is running (test/observability hook). */
  isRunning(): boolean {
    return this.timer !== null
  }

  /** Number of pending expectations across all dirs (test/observability hook). */
  pendingCount(): number {
    let n = 0
    for (const dir of this.dirs.values()) n += dir.expectations.length
    return n
  }

  private ensureRunning(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.pollMs)
  }

  private stopIfIdle(): void {
    if (this.timer && this.pendingCount() === 0) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** One poll pass: try to bind a new transcript in each dir that has waiters. */
  private tick(): void {
    for (const dir of [...this.dirs.values()]) {
      this.scanDir(dir)
    }
    this.stopIfIdle()
  }

  /**
   * Scan a single project dir for transcripts that are NOT in its baseline and
   * NOT already claimed, then assign each (oldest-mtime first) to the oldest
   * pending expectation whose spawnedAt ≤ the file's mtime (+skew). A file is
   * claimed the instant it's assigned so a sibling can't double-bind it.
   */
  private scanDir(dir: DirState): void {
    if (dir.expectations.length === 0) return
    const skewMs = 2000

    // Collect candidate transcripts: new (not baseline), unclaimed, with mtimes.
    const candidates: { id: string; mtime: number }[] = []
    let entries: string[]
    try {
      entries = readdirSync(join(this.projectsRoot, dir.encoded))
    } catch {
      return
    }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue
      const id = f.slice(0, -".jsonl".length)
      if (dir.baseline.has(id)) continue
      if (this.claimedConvoIds.has(id)) continue
      let mtime: number
      try {
        mtime = statSync(join(this.projectsRoot, dir.encoded, f)).mtimeMs
      } catch {
        continue
      }
      candidates.push({ id, mtime })
    }
    if (candidates.length === 0) return

    // Oldest transcript first; oldest pending expectation first. Pairing them in
    // ascending order preserves spawn-order ↔ creation-order: the first terminal
    // to spawn binds the first transcript to appear.
    candidates.sort((a, b) => a.mtime - b.mtime)
    dir.expectations.sort((a, b) => a.spawnedAt - b.spawnedAt)

    for (const cand of candidates) {
      if (dir.expectations.length === 0) break
      // The oldest pending expectation old enough to own this transcript.
      const idx = dir.expectations.findIndex((e) => cand.mtime >= e.spawnedAt - skewMs)
      if (idx === -1) continue
      const exp = dir.expectations[idx]
      this.claimedConvoIds.add(cand.id)
      dir.expectations.splice(idx, 1)
      this.onAssign(exp.terminalId, cand.id)
    }

    if (dir.expectations.length === 0) this.dirs.delete(dir.encoded)
  }

  private listIds(encoded: string): Set<string> {
    try {
      return new Set(
        readdirSync(join(this.projectsRoot, encoded))
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => f.slice(0, -".jsonl".length)),
      )
    } catch {
      return new Set()
    }
  }
}
