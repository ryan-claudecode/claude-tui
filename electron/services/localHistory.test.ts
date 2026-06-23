import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs"
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
