import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, statSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { WorkspaceService, canonSeedDir } from "./workspaces"
import type { TerminalService, TerminalInfo } from "./terminals"

/**
 * Minimal fake TerminalService — WorkspaceService only ever calls `create()` on
 * it (from the legacy `activate` boot path). No real PTYs / claude spawns; every
 * test stays hermetic to its temp dir.
 */
function fakeTerminals(): TerminalService {
  let n = 0
  const fake = {
    create(name?: string, cwd?: string): TerminalInfo {
      n += 1
      return { id: `t-${n}`, name: name ?? "s", cwd: cwd ?? ".", state: "active" }
    },
  }
  return fake as unknown as TerminalService
}

let root: string
let file: string
let clock: number
const now = () => clock

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workspaces-test-"))
  file = join(root, "workspaces.json")
  clock = 1000
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function svc(): WorkspaceService {
  return new WorkspaceService(fakeTerminals(), { file, now })
}

describe("WorkspaceService create/get/list (WS-H single folder)", () => {
  it("create mints a uuid id + timestamps, persists, and appears in list/get", () => {
    const s = svc()
    const ws = s.create("Frontend", "/repo/a")
    expect(ws.id).toMatch(/^ws-/)
    expect(ws.name).toBe("Frontend")
    expect(ws.dir).toBe("/repo/a")
    expect(ws.createdAt).toBe(1000)
    expect(ws.updatedAt).toBe(1000)

    expect(s.get(ws.id)).toEqual(ws)
    expect(s.list().map((w) => w.id)).toEqual([ws.id])

    // persisted in the versioned envelope at the registry path (schemaVersion 2)
    const onDisk = JSON.parse(readFileSync(file, "utf-8"))
    expect(onDisk.schemaVersion).toBe(2)
    expect(onDisk.data.workspaces[0].name).toBe("Frontend")
    expect(onDisk.data.workspaces[0].dir).toBe("/repo/a")
    expect(onDisk.data.workspaces[0].dirs).toBeUndefined()
    expect(onDisk.data.activeWorkspaceId).toBe(null)
  })

  it("create with no folder leaves dir undefined", () => {
    const s = svc()
    const ws = s.create("Folderless")
    expect(ws.dir).toBeUndefined()
    expect(svc().get(ws.id)?.dir).toBeUndefined()
  })

  it("mints distinct ids for two workspaces", () => {
    const s = svc()
    const a = s.create("A")
    clock = 1001
    const b = s.create("B")
    expect(a.id).not.toBe(b.id)
    expect(s.list()).toHaveLength(2)
  })
})

describe("WorkspaceService mutators (WS-H setDir)", () => {
  it("rename updates name + bumps updatedAt + persists", () => {
    const s = svc()
    const ws = s.create("Old")
    clock = 2000
    const renamed = s.rename(ws.id, "New")
    expect(renamed?.name).toBe("New")
    expect(renamed?.updatedAt).toBe(2000)
    // survives a fresh load
    expect(svc().get(ws.id)?.name).toBe("New")
  })

  it("rename a missing id returns undefined", () => {
    expect(svc().rename("nope", "X")).toBeUndefined()
  })

  it("setDir sets the single folder, clears with null, no-ops on same, all persisting", () => {
    const s = svc()
    const ws = s.create("WS", "/a")
    clock = 2000
    expect(s.setDir(ws.id, "/b")?.dir).toBe("/b")
    expect(s.get(ws.id)?.updatedAt).toBe(2000)
    // a no-op (same folder) does NOT bump updatedAt
    clock = 3000
    s.setDir(ws.id, "/b")
    expect(s.get(ws.id)?.updatedAt).toBe(2000)
    // clear with null
    expect(s.setDir(ws.id, null)?.dir).toBeUndefined()
    // persisted across a reload
    expect(svc().get(ws.id)?.dir).toBeUndefined()
  })

  it("setDir a missing id returns undefined", () => {
    expect(svc().setDir("nope", "/x")).toBeUndefined()
  })

  it("delete removes the workspace + clears it from list and disk", () => {
    const s = svc()
    const ws = s.create("Doomed")
    expect(s.delete(ws.id)).toBe(true)
    expect(s.get(ws.id)).toBeUndefined()
    expect(s.list()).toHaveLength(0)
    expect(svc().list()).toHaveLength(0)
    // deleting a missing id is false
    expect(s.delete("nope")).toBe(false)
  })

  it("delete clears the active selection if it pointed at the deleted workspace", () => {
    const s = svc()
    const ws = s.create("Active")
    s.setActive(ws.id)
    s.delete(ws.id)
    expect(s.getActiveId()).toBeNull()
    expect(svc().getActiveId()).toBeNull()
  })
})

describe("WorkspaceService active selection", () => {
  it("setActive/getActive/getActiveId resolve the active workspace", () => {
    const s = svc()
    const ws = s.create("Active")
    expect(s.getActive()).toBeNull()
    expect(s.setActive(ws.id)).toBe(true)
    expect(s.getActiveId()).toBe(ws.id)
    expect(s.getActive()?.id).toBe(ws.id)
    // clearing with null
    expect(s.setActive(null)).toBe(true)
    expect(s.getActive()).toBeNull()
  })

  it("setActive with a non-existent id is ignored (returns false)", () => {
    const s = svc()
    expect(s.setActive("ghost")).toBe(false)
    expect(s.getActiveId()).toBeNull()
  })

  it("active-id persists across a fresh service load", () => {
    const s = svc()
    const ws = s.create("Persisted")
    s.setActive(ws.id)
    // a brand-new service instance reads the same file
    const reloaded = svc()
    expect(reloaded.getActiveId()).toBe(ws.id)
    expect(reloaded.getActive()?.name).toBe("Persisted")
  })

  it("a persisted active-id that no longer resolves is dropped on load", () => {
    // Hand-write a registry whose activeWorkspaceId references a deleted id.
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 2,
        data: { workspaces: [], activeWorkspaceId: "stale-id" },
      }),
    )
    expect(svc().getActiveId()).toBeNull()
  })
})

describe("WorkspaceService persistence migration (v1 dirs[] → v2 dir)", () => {
  it("migrates a legacy v1 record with dirs[] to dir = dirs[0], dropping dirs", () => {
    // A pre-WS-H v1 registry (schemaVersion 1, workspaces carry `dirs`).
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        data: {
          workspaces: [
            { id: "ws-legacy", name: "Legacy", dirs: ["/primary", "/secondary"], createdAt: 1, updatedAt: 2 },
          ],
          activeWorkspaceId: "ws-legacy",
        },
      }),
    )
    const s = svc()
    const ws = s.get("ws-legacy")
    expect(ws?.dir).toBe("/primary") // primary dir becomes the single folder
    expect((ws as any).dirs).toBeUndefined() // legacy array dropped
    expect(s.getActiveId()).toBe("ws-legacy")

    // The migration rewrote the file at schemaVersion 2 (read-repair).
    const onDisk = JSON.parse(readFileSync(file, "utf-8"))
    expect(onDisk.schemaVersion).toBe(2)
    expect(onDisk.data.workspaces[0].dir).toBe("/primary")
    expect(onDisk.data.workspaces[0].dirs).toBeUndefined()
  })

  it("migrates an empty legacy dirs[] to no folder (dir undefined)", () => {
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        data: {
          workspaces: [{ id: "ws-empty", name: "Empty", dirs: [], createdAt: 1, updatedAt: 2 }],
          activeWorkspaceId: null,
        },
      }),
    )
    const ws = svc().get("ws-empty")
    expect(ws?.dir).toBeUndefined()
    expect((ws as any).dirs).toBeUndefined()
  })

  it("a pre-versioning (envelope-less) v0 file with dirs[] migrates through to v2", () => {
    // An envelope-less file is read as version 0 and run through every migration.
    writeFileSync(
      file,
      JSON.stringify({
        workspaces: [{ id: "ws-v0", name: "V0", dirs: ["/v0dir"], createdAt: 1, updatedAt: 2 }],
        activeWorkspaceId: null,
      }),
    )
    const ws = svc().get("ws-v0")
    expect(ws?.dir).toBe("/v0dir")
    expect((ws as any).dirs).toBeUndefined()
    expect(JSON.parse(readFileSync(file, "utf-8")).schemaVersion).toBe(2)
  })
})

describe("WorkspaceService discovery seeding", () => {
  // Write a workspace.json manifest into a scanned dir.
  function seedManifest(dir: string, body: object): string {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "workspace.json"), JSON.stringify(body))
    return dir
  }

  it("discovery seeds the registry from a manifest and a re-scan does NOT duplicate", () => {
    const wsDir = seedManifest(join(root, "ws-proj"), {
      name: "Imported",
      editor: "code",
      repos: [{ name: "api", path: "/repo/api", open_on_boot: false }],
    })
    const pattern = join(root, "ws-*")

    const s = svc()
    s.discover([pattern])
    expect(s.list()).toHaveLength(1)
    const seeded = s.list()[0]
    expect(seeded.name).toBe("Imported")
    // WS-H: the seeded folder is the manifest's PRIMARY (first) repo dir.
    expect(seeded.dir).toBe("/repo/api")

    // re-scan the SAME manifest — must update in place, not duplicate
    clock = 5000
    s.discover([pattern])
    expect(s.list()).toHaveLength(1)
    expect(s.list()[0].id).toBe(seeded.id)

    // and a re-scan in a FRESH service (loaded from disk) also doesn't duplicate
    const reloaded = svc()
    expect(reloaded.list()).toHaveLength(1)
    reloaded.discover([pattern])
    expect(reloaded.list()).toHaveLength(1)
    expect(reloaded.list()[0].id).toBe(seeded.id)

    expect(existsSync(join(wsDir, "workspace.json"))).toBe(true)
  })

  it("a multi-repo manifest seeds ONLY its primary repo dir (single-folder model)", () => {
    seedManifest(join(root, "ws-multi"), {
      name: "Multi",
      repos: [
        { name: "api", path: "/repo/api", open_on_boot: false },
        { name: "web", path: "/repo/web", open_on_boot: false },
      ],
    })
    const s = svc()
    s.discover([join(root, "ws-*")])
    expect(s.list()[0].dir).toBe("/repo/api")
  })

  it("discovery is SEED-ONCE for user fields: a re-scan never reverts a rename", () => {
    const dir = join(root, "ws-renamed")
    seedManifest(dir, { name: "First", repos: [] })
    const pattern = join(root, "ws-*")
    const s = svc()
    s.discover([pattern])
    const id = s.list()[0].id
    expect(s.list()[0].name).toBe("First")

    s.rename(id, "UserName")

    s.discover([pattern])
    expect(s.list()).toHaveLength(1)
    expect(s.list()[0].id).toBe(id)
    expect(s.list()[0].name).toBe("UserName")

    seedManifest(dir, { name: "Second", repos: [] })
    s.discover([pattern])
    expect(s.list()[0].name).toBe("UserName")

    expect(svc().get(id)?.name).toBe("UserName")
  })

  it("discovery preserves a user's setDir on a re-scan (dir is user-owned)", () => {
    const dir = join(root, "ws-dirs")
    seedManifest(dir, { name: "Imported", repos: [{ name: "api", path: "/repo/api", open_on_boot: false }] })
    const pattern = join(root, "ws-*")
    const s = svc()
    s.discover([pattern])
    const id = s.list()[0].id
    expect(s.get(id)?.dir).toBe("/repo/api")

    // User changes the folder via the registry API.
    s.setDir(id, "/changed")
    expect(s.get(id)?.dir).toBe("/changed")

    // Re-scan the unchanged manifest — the user's folder is PRESERVED, not reverted.
    s.discover([pattern])
    expect(s.get(id)?.dir).toBe("/changed")
    expect(svc().get(id)?.dir).toBe("/changed")
  })

  it("a brand-new manifest still seeds fully (name + dir from the manifest)", () => {
    seedManifest(join(root, "ws-new"), {
      name: "Fresh",
      repos: [{ name: "web", path: "/repo/web", open_on_boot: false }],
    })
    const s = svc()
    s.discover([join(root, "ws-*")])
    expect(s.list()).toHaveLength(1)
    expect(s.list()[0].name).toBe("Fresh")
    expect(s.list()[0].dir).toBe("/repo/web")
  })

  it("a steady-state re-discover (unchanged manifests) does ZERO writes", () => {
    const dir = join(root, "ws-steady")
    seedManifest(dir, {
      name: "Steady",
      editor: "code",
      repos: [{ name: "api", path: "/repo/api", open_on_boot: false }],
    })
    const pattern = join(root, "ws-*")
    const s = svc()
    s.discover([pattern])
    const id = s.list()[0].id
    const updatedAt = s.get(id)!.updatedAt
    const mtimeBefore = statSync(file).mtimeMs

    clock = 999999
    s.discover([pattern])
    expect(s.get(id)!.updatedAt).toBe(updatedAt)
    expect(statSync(file).mtimeMs).toBe(mtimeBefore)
  })

  it("re-discover refreshes manifest-owned seedEditor on a REAL delta only", () => {
    const dir = join(root, "ws-editor")
    seedManifest(dir, { name: "Ed", editor: "code", repos: [] })
    const pattern = join(root, "ws-*")
    const s = svc()
    s.discover([pattern])
    const id = s.list()[0].id
    const before = s.get(id)!.updatedAt

    clock = 7000
    seedManifest(dir, { name: "Ed", editor: "vim", repos: [] })
    s.discover([pattern])
    expect(s.get(id)!.updatedAt).toBe(7000)
    expect(s.get(id)!.updatedAt).not.toBe(before)
  })

  it("canonSeedDir collapses drive-letter case on win32 (no-op elsewhere)", () => {
    if (process.platform === "win32") {
      expect(canonSeedDir("c:\\projects\\demo")).toBe("C:\\projects\\demo")
      expect(canonSeedDir("C:\\projects\\demo")).toBe("C:\\projects\\demo")
      expect(canonSeedDir("c:\\projects\\demo")).toBe(canonSeedDir("C:\\projects\\demo"))
    } else {
      expect(canonSeedDir("/projects/demo")).toBe("/projects/demo")
    }
  })

  it("a re-scan whose seedDir spelling differs only by drive-letter case does NOT duplicate", () => {
    const wsDir = seedManifest(join(root, "ws-case"), { name: "Cased", repos: [] })
    const resolvedDir = resolve(wsDir)
    const flipped =
      process.platform === "win32"
        ? resolvedDir.replace(/^([A-Za-z]):/, (_m, d: string) =>
            d === d.toUpperCase() ? `${d.toLowerCase()}:` : `${d.toUpperCase()}:`,
          )
        : resolvedDir
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 2,
        data: {
          workspaces: [
            {
              id: "ws-pre",
              name: "Cased",
              dir: resolvedDir,
              createdAt: 1,
              updatedAt: 1,
              seedDir: flipped,
              seedRepos: [],
              seedEditor: "code",
            },
          ],
          activeWorkspaceId: null,
        },
      }),
    )
    const s = svc()
    expect(s.list()).toHaveLength(1)
    s.discover([join(root, "ws-*")])
    expect(s.list()).toHaveLength(1)
    expect(s.list()[0].id).toBe("ws-pre")
  })

  it("a manifest with no repos seeds its own dir as the workspace folder", () => {
    const dir = seedManifest(join(root, "ws-bare"), { name: "Bare", repos: [] })
    const s = svc()
    s.discover([join(root, "ws-*")])
    expect(s.list()[0].dir).toBe(canonSeedDir(dir))
  })

  it("hand-created workspaces are untouched by discovery", () => {
    const s = svc()
    const manual = s.create("Manual", "/m")
    seedManifest(join(root, "ws-x"), { name: "Imported", repos: [] })
    s.discover([join(root, "ws-*")])
    expect(s.list()).toHaveLength(2)
    expect(s.get(manual.id)?.name).toBe("Manual")
  })

  it("listPublic strips the internal seed* fields (no leak across MCP)", () => {
    seedManifest(join(root, "ws-pub"), {
      name: "Imported",
      editor: "code",
      repos: [{ name: "api", path: "/repo/api", open_on_boot: true }],
    })
    const s = svc()
    s.discover([join(root, "ws-*")])

    const internal = s.list()[0]
    expect(internal.seedDir).toBeDefined()
    expect(internal.seedRepos).toBeDefined()
    expect(internal.seedEditor).toBe("code")

    const pub = s.listPublic()[0] as unknown as Record<string, unknown>
    expect(Object.keys(pub).sort()).toEqual(
      ["color", "createdAt", "dir", "id", "name", "updatedAt"].sort(),
    )
    expect("seedDir" in pub).toBe(false)
    expect("seedRepos" in pub).toBe(false)
    expect("seedEditor" in pub).toBe(false)
    expect(pub.name).toBe("Imported")
    expect(pub.dir).toBe("/repo/api")
  })
})

// ── WS-F — user-triggerable re-scan ────────────────────────────────────────────
describe("WorkspaceService WS-F rescan", () => {
  function seedManifest(dir: string, body: object): string {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "workspace.json"), JSON.stringify(body))
    return dir
  }

  it("rescan picks up a NEWLY-added manifest (seeds it) and returns the public list", () => {
    const pattern = join(root, "ws-*")
    const s = svc()
    seedManifest(join(root, "ws-one"), { name: "One", repos: [] })
    expect(s.rescan([pattern])).toHaveLength(1)

    seedManifest(join(root, "ws-two"), { name: "Two", repos: [] })
    const after = s.rescan([pattern])
    expect(after).toHaveLength(2)
    expect(after.map((w) => w.name).sort()).toEqual(["One", "Two"])
  })

  it("rescan does NOT duplicate an already-seeded workspace and preserves user edits", () => {
    const dir = join(root, "ws-edit")
    seedManifest(dir, { name: "Imported", repos: [{ name: "api", path: "/repo/api", open_on_boot: false }] })
    const pattern = join(root, "ws-*")
    const s = svc()
    s.rescan([pattern])
    const id = s.list()[0].id

    s.rename(id, "UserName")
    s.setDir(id, "/extra")

    const after = s.rescan([pattern])
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(id)
    expect(after[0].name).toBe("UserName")
    expect(after[0].dir).toBe("/extra")
  })

  it("rescan returns the PUBLIC projection (no seed* leak)", () => {
    seedManifest(join(root, "ws-pub"), {
      name: "Imported",
      editor: "code",
      repos: [{ name: "api", path: "/repo/api", open_on_boot: true }],
    })
    const s = svc()
    const list = s.rescan([join(root, "ws-*")])
    const pub = list[0] as unknown as Record<string, unknown>
    expect(Object.keys(pub).sort()).toEqual(
      ["color", "createdAt", "dir", "id", "name", "updatedAt"].sort(),
    )
    expect("seedDir" in pub).toBe(false)
    expect("seedRepos" in pub).toBe(false)
    expect("seedEditor" in pub).toBe(false)
  })
})

describe("WorkspaceService load resilience", () => {
  it("an empty/missing registry loads cleanly (empty list, no active)", () => {
    expect(existsSync(file)).toBe(false)
    const s = svc()
    expect(s.list()).toEqual([])
    expect(s.getActiveId()).toBeNull()
  })

  it("a garbled/corrupt registry file does NOT crash construction", () => {
    writeFileSync(file, "{ this is not valid json ]")
    let s!: WorkspaceService
    expect(() => {
      s = svc()
    }).not.toThrow()
    expect(s.list()).toEqual([])
    const ws = s.create("Recovered")
    expect(s.get(ws.id)?.name).toBe("Recovered")
  })

  it("a legacy/garbled registry shape (workspaces not an array) loads as empty", () => {
    writeFileSync(file, JSON.stringify({ schemaVersion: 2, data: { workspaces: "oops" } }))
    const s = svc()
    expect(s.list()).toEqual([])
    expect(s.getActiveId()).toBeNull()
  })

  it("tolerates a v2 entry that still carries a stray dirs[] (falls back to dirs[0])", () => {
    // A hand-edited v2 file that left a `dirs` array on a row: loadAll must coerce
    // it to the single `dir` (dirs[0]) and never retain the array.
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 2,
        data: {
          workspaces: [{ id: "ws-stray", name: "Stray", dirs: ["/fromdirs"], createdAt: 1, updatedAt: 1 }],
          activeWorkspaceId: null,
        },
      }),
    )
    const s = svc()
    expect(s.get("ws-stray")?.dir).toBe("/fromdirs")
    expect((s.get("ws-stray") as any).dirs).toBeUndefined()
    // The mutators are safe on this normalized entry.
    expect(() => s.setDir("ws-stray", "/new")).not.toThrow()
    expect(s.get("ws-stray")?.dir).toBe("/new")
  })

  it("normalizes a partial entry missing dir so setDir doesn't crash", () => {
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 2,
        data: {
          workspaces: [{ id: "ws-partial" }],
          activeWorkspaceId: null,
        },
      }),
    )
    const s = svc()
    expect(s.get("ws-partial")?.dir).toBeUndefined()
    expect(() => s.setDir("ws-partial", "/added")).not.toThrow()
    expect(s.get("ws-partial")?.dir).toBe("/added")
    expect(() => s.setDir("ws-partial", null)).not.toThrow()
    expect(s.get("ws-partial")?.dir).toBeUndefined()
  })
})

describe("WorkspaceService legacy activate path (kept working)", () => {
  it("activate(index) spawns one session per manifest repo for a seeded workspace", () => {
    mkdirSync(join(root, "ws-act"), { recursive: true })
    writeFileSync(
      join(root, "ws-act", "workspace.json"),
      JSON.stringify({
        name: "Boot",
        editor: "code",
        repos: [
          { name: "api", path: "/repo/api", open_on_boot: false },
          { name: "web", path: "/repo/web", open_on_boot: false },
        ],
      }),
    )
    const s = svc()
    s.discover([join(root, "ws-*")])
    const result = s.activate(0)
    expect(result?.workspace).toBe("Boot")
    expect(result?.sessions).toHaveLength(2)
  })

  it("activate(index) spawns one session in the folder for a hand-created workspace", () => {
    const s = svc()
    s.create("Manual", "/d1")
    const result = s.activate(0)
    expect(result?.sessions).toHaveLength(1)
  })

  it("activate(index) for a FOLDERLESS hand-created workspace spawns nothing", () => {
    const s = svc()
    s.create("Folderless")
    const result = s.activate(0)
    expect(result?.sessions).toHaveLength(0)
  })

  it("activate with an out-of-range index returns null", () => {
    expect(svc().activate(0)).toBeNull()
  })
})

// ── WS-B ─────────────────────────────────────────────────────────────────────
function countingTerminals(): { terminals: TerminalService; createCalls: () => number } {
  let n = 0
  const fake = {
    create(name?: string, cwd?: string): TerminalInfo {
      n += 1
      return { id: `t-${n}`, name: name ?? "s", cwd: cwd ?? ".", state: "active" }
    },
  }
  return { terminals: fake as unknown as TerminalService, createCalls: () => n }
}

describe("WorkspaceService WS-B active-changed event", () => {
  it("setActive emits workspace:active-changed with the new active public projection", () => {
    const s = svc()
    const ws = s.create("Active", "/d")
    const events: Array<{ active: { id: string; name: string } | null }> = []
    s.onActiveChanged((e) => events.push(e as any))

    s.setActive(ws.id)
    expect(events).toHaveLength(1)
    expect(events[0].active?.id).toBe(ws.id)
    expect(events[0].active?.name).toBe("Active")
    expect("seedDir" in (events[0].active as object)).toBe(false)
  })

  it("setActive(null) emits with a null payload (active cleared)", () => {
    const s = svc()
    const ws = s.create("Active")
    s.setActive(ws.id)
    const events: Array<{ active: unknown }> = []
    s.onActiveChanged((e) => events.push(e))
    s.setActive(null)
    expect(events).toHaveLength(1)
    expect(events[0].active).toBeNull()
  })

  it("a redundant setActive (same id) does NOT re-emit", () => {
    const s = svc()
    const ws = s.create("Active")
    s.setActive(ws.id)
    const events: unknown[] = []
    s.onActiveChanged((e) => events.push(e))
    s.setActive(ws.id)
    expect(events).toHaveLength(0)
  })

  it("setActive with a non-existent id does NOT emit (and returns false)", () => {
    const s = svc()
    const events: unknown[] = []
    s.onActiveChanged((e) => events.push(e))
    expect(s.setActive("ghost")).toBe(false)
    expect(events).toHaveLength(0)
  })

  it("deleting the ACTIVE workspace emits active-changed with null", () => {
    const s = svc()
    const ws = s.create("Active")
    s.setActive(ws.id)
    const events: Array<{ active: unknown }> = []
    s.onActiveChanged((e) => events.push(e))
    s.delete(ws.id)
    expect(events).toHaveLength(1)
    expect(events[0].active).toBeNull()
  })

  it("deleting a NON-active workspace does NOT emit active-changed", () => {
    const s = svc()
    const active = s.create("Active")
    const other = s.create("Other")
    s.setActive(active.id)
    const events: unknown[] = []
    s.onActiveChanged((e) => events.push(e))
    s.delete(other.id)
    expect(events).toHaveLength(0)
  })

  it("onActiveChanged returns an unsubscribe that stops further events", () => {
    const s = svc()
    const ws = s.create("A")
    const events: unknown[] = []
    const off = s.onActiveChanged((e) => events.push(e))
    s.setActive(ws.id)
    expect(events).toHaveLength(1)
    off()
    s.setActive(null)
    expect(events).toHaveLength(1)
  })

  it("getActivePublic returns the public projection (no seed* leak) or null", () => {
    const s = svc()
    expect(s.getActivePublic()).toBeNull()
    const ws = s.create("Pub", "/x")
    s.setActive(ws.id)
    const pub = s.getActivePublic() as unknown as Record<string, unknown>
    expect(Object.keys(pub).sort()).toEqual(
      ["color", "createdAt", "dir", "id", "name", "updatedAt"].sort(),
    )
    expect(pub.id).toBe(ws.id)
  })
})

describe("WorkspaceService WS-H setDir/rename emit active-changed for the active workspace", () => {
  it("setDir on the ACTIVE workspace emits active-changed with the new dir (public projection)", () => {
    const s = svc()
    const ws = s.create("Active")
    s.setActive(ws.id)
    const events: Array<{ active: { id: string; dir?: string } | null }> = []
    s.onActiveChanged((e) => events.push(e as any))
    s.setDir(ws.id, root) // a real dir so scaffolding succeeds; emit is unconditional on a real delta
    expect(events).toHaveLength(1)
    expect(events[0].active?.id).toBe(ws.id)
    expect(events[0].active?.dir).toBe(root)
    expect("seedDir" in (events[0].active as object)).toBe(false)
  })

  it("rename on the ACTIVE workspace emits active-changed with the new name (public projection)", () => {
    const s = svc()
    const ws = s.create("Old")
    s.setActive(ws.id)
    const events: Array<{ active: { id: string; name: string } | null }> = []
    s.onActiveChanged((e) => events.push(e as any))
    s.rename(ws.id, "New")
    expect(events).toHaveLength(1)
    expect(events[0].active?.id).toBe(ws.id)
    expect(events[0].active?.name).toBe("New")
    expect("seedDir" in (events[0].active as object)).toBe(false)
  })

  it("setDir/rename on a NON-active workspace does NOT emit active-changed", () => {
    const s = svc()
    const active = s.create("Active")
    const other = s.create("Other")
    s.setActive(active.id)
    const events: unknown[] = []
    s.onActiveChanged((e) => events.push(e))
    s.setDir(other.id, root)
    s.rename(other.id, "Renamed")
    expect(events).toHaveLength(0)
  })

  it("a no-op setDir/rename (same value) on the active workspace does NOT emit (churn guard)", () => {
    const s = svc()
    const ws = s.create("Same", root)
    s.setActive(ws.id)
    const events: unknown[] = []
    s.onActiveChanged((e) => events.push(e))
    s.setDir(ws.id, root) // unchanged dir
    s.rename(ws.id, "Same") // unchanged name
    expect(events).toHaveLength(0)
  })
})

describe("WorkspaceService WS-B selection vs launch split", () => {
  it("setActive (SELECTION) does NOT spawn any sessions", () => {
    const { terminals, createCalls } = countingTerminals()
    const s = new WorkspaceService(terminals, { file, now })
    const ws = s.create("Manual", "/d1")
    s.setActive(ws.id)
    expect(createCalls()).toBe(0)
    expect(s.getActiveId()).toBe(ws.id)
  })

  it("launch(id) STILL spawns one session in the folder (the boot verb)", () => {
    const { terminals, createCalls } = countingTerminals()
    const s = new WorkspaceService(terminals, { file, now })
    const ws = s.create("Manual", "/d1")
    const result = s.launch(ws.id)
    expect(result?.workspace).toBe("Manual")
    expect(result?.sessions).toHaveLength(1)
    expect(createCalls()).toBe(1)
  })

  it("launch(id) spawns one session per manifest repo for a seeded workspace", () => {
    mkdirSync(join(root, "ws-launch"), { recursive: true })
    writeFileSync(
      join(root, "ws-launch", "workspace.json"),
      JSON.stringify({
        name: "Boot",
        editor: "code",
        repos: [
          { name: "api", path: "/repo/api", open_on_boot: false },
          { name: "web", path: "/repo/web", open_on_boot: false },
        ],
      }),
    )
    const { terminals, createCalls } = countingTerminals()
    const s = new WorkspaceService(terminals, { file, now })
    s.discover([join(root, "ws-*")])
    const id = s.list()[0].id
    const result = s.launch(id)
    expect(result?.workspace).toBe("Boot")
    expect(result?.sessions).toHaveLength(2)
    expect(createCalls()).toBe(2)
  })

  it("launch(id) with an unknown id returns null and spawns nothing", () => {
    const { terminals, createCalls } = countingTerminals()
    const s = new WorkspaceService(terminals, { file, now })
    expect(s.launch("ghost")).toBeNull()
    expect(createCalls()).toBe(0)
  })

  it("setActive persists + survives a reload (selection is durable, no spawn)", () => {
    const { terminals, createCalls } = countingTerminals()
    const s = new WorkspaceService(terminals, { file, now })
    const ws = s.create("Persisted", "/p")
    s.setActive(ws.id)
    expect(createCalls()).toBe(0)
    const reloaded = new WorkspaceService(fakeTerminals(), { file, now })
    expect(reloaded.getActiveId()).toBe(ws.id)
    expect(reloaded.getActivePublic()?.name).toBe("Persisted")
  })
})

describe("WorkspaceService WS-G/H (G1) getActiveWorkspaceDir", () => {
  it("returns the active workspace's folder (dir) when it exists on disk", () => {
    const d = join(root, "proj-a")
    mkdirSync(d, { recursive: true })
    const s = svc()
    const ws = s.create("A", d)
    s.setActive(ws.id)
    expect(s.getActiveWorkspaceDir()).toBe(d)
  })

  it("returns null when no workspace is active ('All' mode)", () => {
    const d = join(root, "proj-a")
    mkdirSync(d, { recursive: true })
    const s = svc()
    s.create("A", d) // created but NOT active
    expect(s.getActiveWorkspaceDir()).toBeNull()
  })

  it("returns null when the active workspace has no folder", () => {
    const s = svc()
    const ws = s.create("Empty")
    s.setActive(ws.id)
    expect(s.getActiveWorkspaceDir()).toBeNull()
  })

  it("returns null when dir does not exist on disk (stale path → default cwd)", () => {
    const s = svc()
    const ws = s.create("Stale", join(root, "does-not-exist"))
    s.setActive(ws.id)
    expect(s.getActiveWorkspaceDir()).toBeNull()
  })
})

describe("WorkspaceService WS-G/H (G3) workspace.json scaffold", () => {
  function manifestAt(dir: string) {
    return JSON.parse(readFileSync(join(dir, "workspace.json"), "utf-8"))
  }

  it("create() scaffolds a valid workspace.json into the provided folder + toasts", () => {
    const d = join(root, "scaf-a")
    mkdirSync(d, { recursive: true })
    const toasts: Array<{ message: string; level: string }> = []
    const s = new WorkspaceService(fakeTerminals(), {
      file,
      now,
      notify: (message, level) => toasts.push({ message, level }),
    })
    s.create("Billing", d)

    expect(existsSync(join(d, "workspace.json"))).toBe(true)
    const m = manifestAt(d)
    expect(m.name).toBe("Billing")
    expect(m.editor).toBe("code")
    expect(Array.isArray(m.repos)).toBe(true)
    expect(toasts.some((t) => t.message.includes("workspace.json") && t.level === "success")).toBe(true)
  })

  it("setDir() scaffolds a workspace.json into the newly-set folder", () => {
    const s = svc()
    const ws = s.create("Svc") // folderless to start
    const d = join(root, "scaf-set")
    mkdirSync(d, { recursive: true })
    s.setDir(ws.id, d)
    expect(existsSync(join(d, "workspace.json"))).toBe(true)
    expect(manifestAt(d).name).toBe("Svc")
  })

  it("does NOT clobber a pre-existing workspace.json (skips write, no toast)", () => {
    const d = join(root, "scaf-existing")
    mkdirSync(d, { recursive: true })
    const original = { name: "Hand authored", custom: true }
    writeFileSync(join(d, "workspace.json"), JSON.stringify(original))
    const toasts: string[] = []
    const s = new WorkspaceService(fakeTerminals(), {
      file,
      now,
      notify: (message) => toasts.push(message),
    })
    s.create("DifferentName", d)
    expect(manifestAt(d)).toEqual(original)
    expect(toasts.some((t) => t.includes("Created workspace.json"))).toBe(false)
  })

  it("scaffolds nothing for a non-existent dir (best-effort, no throw)", () => {
    const d = join(root, "scaf-missing")
    const s = svc()
    expect(() => s.create("Ghost", d)).not.toThrow()
    expect(existsSync(join(d, "workspace.json"))).toBe(false)
  })

  it("⚠ rescan AFTER a scaffold produces NO duplicate + keeps user edits (the trap)", () => {
    const d = join(root, "ws-scaf-dedup")
    mkdirSync(d, { recursive: true })
    const s = svc()
    const ws = s.create("Mine", d)
    s.rename(ws.id, "MyRenamed") // a user edit that must survive

    expect(existsSync(join(d, "workspace.json"))).toBe(true)

    const after = s.rescan([join(root, "ws-scaf-dedup")])
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(ws.id)
    expect(after[0].name).toBe("MyRenamed")
    expect(after[0].dir).toBe(d)
  })

  it("⚠ rescan-after-scaffold for a FORWARD-SLASH dir spelling produces NO duplicate (the canonicalization blocker)", () => {
    const d = join(root, "ws-fwd-slash")
    mkdirSync(d, { recursive: true })
    const fwd = d.replace(/\\/g, "/")
    const s = svc()
    const ws = s.create("FwdSlash", fwd)
    s.rename(ws.id, "FwdRenamed")
    expect(existsSync(join(d, "workspace.json"))).toBe(true)

    const after = s.rescan([join(root, "ws-fwd-slash")])
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(ws.id)
    expect(after[0].name).toBe("FwdRenamed")
  })

  it("⚠ rescan-after-scaffold for a TRAILING-SLASH dir spelling produces NO duplicate", () => {
    const d = join(root, "ws-trail-slash")
    mkdirSync(d, { recursive: true })
    const trailing = d + "\\"
    const s = svc()
    const ws = s.create("TrailSlash", trailing)
    s.rename(ws.id, "TrailRenamed")
    expect(existsSync(join(d, "workspace.json"))).toBe(true)

    const after = s.rescan([join(root, "ws-trail-slash")])
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(ws.id)
    expect(after[0].name).toBe("TrailRenamed")
  })

  it("scaffold does NOT bind a seedDir already owned by ANOTHER workspace (no shared key)", () => {
    const d = join(root, "ws-shared-dir")
    mkdirSync(d, { recursive: true })
    const s = svc()
    const a = s.create("Owner", d)
    const b = s.create("Second", d)
    const internalA = s.get(a.id)!
    const internalB = s.get(b.id)!
    expect(internalA.seedDir).toBe(canonSeedDir(d))
    expect(internalB.seedDir).not.toBe(canonSeedDir(d))
    expect(internalB.seedDir).toBeUndefined()
  })
})
