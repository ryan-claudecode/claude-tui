import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { LocalHistoryService, CURATED_SUBDIRS } from "./localHistory"
import { WorkspaceMemoryService } from "./workspaceMemory"

/**
 * CAPP-95 / D1 — LocalHistoryService gate. Hermetic: every service is given an
 * injected temp `rootDir` so nothing touches the real ~/.claude-tui. The history
 * repo gets a LOCAL git identity in init() so commits succeed without a global git
 * config (CI-safe).
 */

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ctui-lh-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Run git in the history repo for assertions (read-only probes). */
function git(repoDir: string, args: string[]) {
  return spawnSync("git", args, { cwd: repoDir, encoding: "utf8", windowsHide: true })
}

const repoDir = () => join(root, ".local-history")

describe("LocalHistoryService — init + snapshot", () => {
  it("init() creates the .local-history git repo with a local identity", () => {
    const svc = new LocalHistoryService({ rootDir: root })
    svc.init()
    expect(existsSync(join(repoDir(), ".git"))).toBe(true)
    const name = git(repoDir(), ["config", "user.name"]).stdout.trim()
    expect(name).toBe("Mission Control")
  })

  it("snapshot() creates a commit; a second no-change snapshot creates NO new commit", () => {
    // Seed a workspace-memory finding via the real service so the curated subset is non-empty.
    const mem = new WorkspaceMemoryService({ dir: join(root, "workspace-memory") })
    mem.addFinding("ws-1", "uses electron-vite", "user")

    const svc = new LocalHistoryService({ rootDir: root })
    svc.init() // baseline snapshot (commit #1)

    const countAfterInit = git(repoDir(), ["rev-list", "--count", "HEAD"]).stdout.trim()
    expect(Number(countAfterInit)).toBe(1)

    // No change since init → snapshot must skip the empty commit.
    const skipped = svc.snapshot("no-change")
    expect(skipped).toBeNull()
    expect(git(repoDir(), ["rev-list", "--count", "HEAD"]).stdout.trim()).toBe("1")

    // A real change → a new commit.
    mem.addFinding("ws-1", "second finding", "user")
    const hash = svc.snapshot("after change")
    expect(hash).toBeTruthy()
    expect(git(repoDir(), ["rev-list", "--count", "HEAD"]).stdout.trim()).toBe("2")
  })

  it("the untagged __untagged__.json bucket IS included in the snapshot", () => {
    const mem = new WorkspaceMemoryService({ dir: join(root, "workspace-memory") })
    mem.addFinding(null, "global cross-project finding", "user") // untagged bucket

    const svc = new LocalHistoryService({ rootDir: root })
    svc.init()

    const tracked = git(repoDir(), ["ls-files"]).stdout
    expect(tracked).toContain("workspace-memory/__untagged__.json")
  })

  it("snapshot mirrors the curated subdirs only", () => {
    const mem = new WorkspaceMemoryService({ dir: join(root, "workspace-memory") })
    mem.addFinding("ws-1", "a finding", "user")
    // A non-curated dir that must NOT be snapshotted.
    mkdirSync(join(root, "missions"), { recursive: true })
    writeFileSync(join(root, "missions", "m1.json"), "{}")

    const svc = new LocalHistoryService({ rootDir: root })
    svc.init()

    const tracked = git(repoDir(), ["ls-files"]).stdout
    expect(tracked).toContain("workspace-memory/")
    expect(tracked).not.toContain("missions/")
    expect(CURATED_SUBDIRS).toEqual(["workspace-memory", "sessions"])
  })
})

describe("LocalHistoryService — path separation / never-pushed invariant", () => {
  it("the .local-history repo has NO remote configured", () => {
    const svc = new LocalHistoryService({ rootDir: root })
    svc.init()
    const remotes = git(repoDir(), ["remote"]).stdout.trim()
    expect(remotes).toBe("")
  })
})

describe("LocalHistoryService — restore", () => {
  it("restores a deleted workspace-memory finding from a prior snapshot + reloads the cache", () => {
    const memDir = join(root, "workspace-memory")
    const mem = new WorkspaceMemoryService({ dir: memDir })
    const finding = mem.addFinding("ws-1", "important finding", "user")

    const svc = new LocalHistoryService({ rootDir: root })
    // Hook the reload so restore re-warms the live service's cache (as ipc.ts wires).
    svc.setReloadHooks({ onWorkspaceMemoryRestored: () => mem.reload() })
    svc.init() // snapshot WITH the finding present

    const snaps = svc.listSnapshots()
    expect(snaps.length).toBeGreaterThanOrEqual(1)
    const goodHash = snaps[0].hash

    // Delete the finding from the LIVE store.
    expect(mem.deleteFinding("ws-1", finding.id)).toBe(true)
    expect(mem.getMemory("ws-1").findings).toHaveLength(0)

    // Restore that single file from the snapshot.
    const res = svc.restore(goodHash, "workspace-memory/ws-1.json")
    expect(res.restored).toContain("workspace-memory/ws-1.json")

    // The finding is back in the LIVE store AND the service cache reflects it.
    const reloaded = mem.getMemory("ws-1")
    expect(reloaded.findings.map((f) => f.text)).toContain("important finding")
  })

  it("restoring the whole subset (no relPath) brings back all curated files", () => {
    const memDir = join(root, "workspace-memory")
    const mem = new WorkspaceMemoryService({ dir: memDir })
    mem.addFinding("ws-1", "finding one", "user")
    mem.addFinding(null, "untagged finding", "user")

    const svc = new LocalHistoryService({ rootDir: root })
    svc.setReloadHooks({ onWorkspaceMemoryRestored: () => mem.reload() })
    svc.init()
    const hash = svc.listSnapshots()[0].hash

    // Wipe both findings live.
    mem.reload()
    const f1 = mem.getMemory("ws-1").findings[0]
    mem.deleteFinding("ws-1", f1.id)
    const fu = mem.getMemory(null).findings[0]
    mem.deleteFinding(null, fu.id)

    const res = svc.restore(hash)
    expect(res.restored).toContain("workspace-memory/ws-1.json")
    expect(res.restored).toContain("workspace-memory/__untagged__.json")
    expect(mem.getMemory("ws-1").findings).toHaveLength(1)
    expect(mem.getMemory(null).findings).toHaveLength(1)
  })

  it("refuses to restore a non-curated path", () => {
    const mem = new WorkspaceMemoryService({ dir: join(root, "workspace-memory") })
    mem.addFinding("ws-1", "x", "user")
    const svc = new LocalHistoryService({ rootDir: root })
    svc.init()
    const hash = svc.listSnapshots()[0].hash
    const res = svc.restore(hash, "config.json")
    expect(res.restored).toHaveLength(0)
  })
})

describe("LocalHistoryService — sessions tier", () => {
  it("includes sessions/ in a snapshot and restores a deleted session file + fires the reload hook", () => {
    mkdirSync(join(root, "sessions"), { recursive: true })
    const sessFile = join(root, "sessions", "s-1.json")
    writeFileSync(sessFile, JSON.stringify({ id: "s-1", summary: "hard-won finding" }))

    const onSessionsRestored = vi.fn()
    const svc = new LocalHistoryService({ rootDir: root })
    svc.setReloadHooks({ onSessionsRestored })
    svc.init() // snapshot WITH the session present

    expect(git(repoDir(), ["ls-files"]).stdout).toContain("sessions/s-1.json")
    const hash = svc.listSnapshots()[0].hash

    rmSync(sessFile) // lose the live session file
    expect(existsSync(sessFile)).toBe(false)

    const res = svc.restore(hash, "sessions/s-1.json")
    expect(res.restored).toContain("sessions/s-1.json")
    expect(existsSync(sessFile)).toBe(true)
    expect(JSON.parse(readFileSync(sessFile, "utf8")).summary).toBe("hard-won finding")
    expect(onSessionsRestored).toHaveBeenCalled()
  })
})

describe("LocalHistoryService — restore safety", () => {
  it("rejects a `..` traversal path and writes NOTHING outside the curated store", () => {
    const mem = new WorkspaceMemoryService({ dir: join(root, "workspace-memory") })
    mem.addFinding("ws-1", "x", "user")
    const svc = new LocalHistoryService({ rootDir: root })
    svc.init()
    const hash = svc.listSnapshots()[0].hash

    const evil = join(root, "..", "ctui-lh-evil.json")
    const res = svc.restore(hash, "workspace-memory/../../ctui-lh-evil.json")
    expect(res.restored).toHaveLength(0)
    expect(res.failed).toContain("workspace-memory/../../ctui-lh-evil.json")
    expect(existsSync(evil)).toBe(false)
  })

  it("rejects a directory (tree) path, a blank hash, and a non-hex hash", () => {
    const mem = new WorkspaceMemoryService({ dir: join(root, "workspace-memory") })
    mem.addFinding("ws-1", "x", "user")
    const svc = new LocalHistoryService({ rootDir: root })
    svc.init()
    const hash = svc.listSnapshots()[0].hash

    expect(svc.restore(hash, "workspace-memory/").restored).toHaveLength(0) // dir, not a file
    expect(svc.restore("", "workspace-memory/ws-1.json").restored).toHaveLength(0) // blank hash
    expect(svc.restore("not-a-hash", "workspace-memory/ws-1.json").restored).toHaveLength(0)
  })
})

describe("LocalHistoryService — debounced auto-snapshot + flush", () => {
  it("scheduleSnapshot is a no-op before init, then coalesces a burst into ONE commit", async () => {
    const mem = new WorkspaceMemoryService({ dir: join(root, "workspace-memory") })
    mem.addFinding("ws-1", "seed", "user")
    const svc = new LocalHistoryService({ rootDir: root, debounceMs: 10 })

    // Before init: no-op (the repo doesn't exist yet).
    svc.scheduleSnapshot("too early")
    await new Promise((r) => setTimeout(r, 30))
    expect(existsSync(join(repoDir(), ".git"))).toBe(false)

    svc.init() // baseline commit (#1)
    expect(git(repoDir(), ["rev-list", "--count", "HEAD"]).stdout.trim()).toBe("1")

    // A burst of edits + schedules collapses to exactly ONE coalesced commit.
    mem.addFinding("ws-1", "burst a", "user")
    svc.scheduleSnapshot()
    mem.addFinding("ws-1", "burst b", "user")
    svc.scheduleSnapshot()
    await new Promise((r) => setTimeout(r, 40))
    expect(git(repoDir(), ["rev-list", "--count", "HEAD"]).stdout.trim()).toBe("2")
  })

  it("flush() captures a pending change synchronously (the on-quit safety)", () => {
    const mem = new WorkspaceMemoryService({ dir: join(root, "workspace-memory") })
    mem.addFinding("ws-1", "seed", "user")
    const svc = new LocalHistoryService({ rootDir: root, debounceMs: 60_000 })
    svc.init() // commit #1
    expect(git(repoDir(), ["rev-list", "--count", "HEAD"]).stdout.trim()).toBe("1")

    // Schedule a far-future debounced snapshot, then flush (as on quit) → committed now.
    mem.addFinding("ws-1", "late edit", "user")
    svc.scheduleSnapshot()
    svc.flush()
    expect(git(repoDir(), ["rev-list", "--count", "HEAD"]).stdout.trim()).toBe("2")
  })
})

describe("LocalHistoryService — listSnapshots", () => {
  it("returns commits newest-first with hash/date/message", () => {
    const mem = new WorkspaceMemoryService({ dir: join(root, "workspace-memory") })
    mem.addFinding("ws-1", "one", "user")
    const svc = new LocalHistoryService({ rootDir: root })
    svc.init()
    mem.addFinding("ws-1", "two", "user")
    svc.snapshot("second")

    const snaps = svc.listSnapshots()
    expect(snaps.length).toBe(2)
    expect(snaps[0].message).toContain("second")
    expect(snaps[0].hash).toMatch(/^[0-9a-f]{7,}$/)
    expect(snaps[0].date).toBeTruthy()
  })
})
