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

describe("WorkspaceService create/get/list", () => {
  it("create mints a uuid id + timestamps, persists, and appears in list/get", () => {
    const s = svc()
    const ws = s.create("Frontend", ["/repo/a", "/repo/b"])
    expect(ws.id).toMatch(/^ws-/)
    expect(ws.name).toBe("Frontend")
    expect(ws.dirs).toEqual(["/repo/a", "/repo/b"])
    expect(ws.createdAt).toBe(1000)
    expect(ws.updatedAt).toBe(1000)

    expect(s.get(ws.id)).toEqual(ws)
    expect(s.list().map((w) => w.id)).toEqual([ws.id])

    // persisted in the versioned envelope at the registry path
    const onDisk = JSON.parse(readFileSync(file, "utf-8"))
    expect(onDisk.schemaVersion).toBe(1)
    expect(onDisk.data.workspaces[0].name).toBe("Frontend")
    expect(onDisk.data.activeWorkspaceId).toBe(null)
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

describe("WorkspaceService mutators", () => {
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

  it("addDir appends (no duplicates) and removeDir removes, both persisting", () => {
    const s = svc()
    const ws = s.create("WS", ["/a"])
    s.addDir(ws.id, "/b")
    s.addDir(ws.id, "/b") // duplicate is a no-op
    expect(s.get(ws.id)?.dirs).toEqual(["/a", "/b"])
    s.removeDir(ws.id, "/a")
    expect(s.get(ws.id)?.dirs).toEqual(["/b"])
    // persisted across a reload
    expect(svc().get(ws.id)?.dirs).toEqual(["/b"])
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
        schemaVersion: 1,
        data: { workspaces: [], activeWorkspaceId: "stale-id" },
      }),
    )
    expect(svc().getActiveId()).toBeNull()
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
    expect(seeded.dirs).toEqual(["/repo/api"])

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

    // ensure the seed dir was the de-dup key (avoid unused-var lint, assert dir)
    expect(existsSync(join(wsDir, "workspace.json"))).toBe(true)
  })

  it("discovery is SEED-ONCE for user fields: a re-scan never reverts a rename", () => {
    // Seed-once policy (registry is the source of truth): once an entry exists,
    // discovery must NEVER overwrite the user-owned `name`, even if the manifest
    // on disk later disagrees. (Pre-fix this clobbered the rename on next boot.)
    const dir = join(root, "ws-renamed")
    seedManifest(dir, { name: "First", repos: [] })
    const pattern = join(root, "ws-*")
    const s = svc()
    s.discover([pattern])
    const id = s.list()[0].id
    expect(s.list()[0].name).toBe("First")

    // User renames the imported workspace via the registry API.
    s.rename(id, "UserName")

    // Re-scan the UNCHANGED manifest (still "First"): the name STAYS "UserName".
    s.discover([pattern])
    expect(s.list()).toHaveLength(1)
    expect(s.list()[0].id).toBe(id)
    expect(s.list()[0].name).toBe("UserName")

    // Even if the manifest is rewritten with a different name, discovery still
    // does not clobber the user-owned name.
    seedManifest(dir, { name: "Second", repos: [] })
    s.discover([pattern])
    expect(s.list()[0].name).toBe("UserName")

    // Survives a fresh load from disk too.
    expect(svc().get(id)?.name).toBe("UserName")
  })

  it("discovery preserves a user's addDir on a re-scan (dirs are user-owned)", () => {
    const dir = join(root, "ws-dirs")
    seedManifest(dir, { name: "Imported", repos: [{ name: "api", path: "/repo/api", open_on_boot: false }] })
    const pattern = join(root, "ws-*")
    const s = svc()
    s.discover([pattern])
    const id = s.list()[0].id
    expect(s.get(id)?.dirs).toEqual(["/repo/api"])

    // User adds a dir via the registry API.
    s.addDir(id, "/extra")
    expect(s.get(id)?.dirs).toEqual(["/repo/api", "/extra"])

    // Re-scan the unchanged manifest — the extra dir is PRESERVED, not reverted.
    s.discover([pattern])
    expect(s.get(id)?.dirs).toEqual(["/repo/api", "/extra"])
    expect(svc().get(id)?.dirs).toEqual(["/repo/api", "/extra"])
  })

  it("a brand-new manifest still seeds fully (name + dirs from the manifest)", () => {
    seedManifest(join(root, "ws-new"), {
      name: "Fresh",
      repos: [{ name: "web", path: "/repo/web", open_on_boot: false }],
    })
    const s = svc()
    s.discover([join(root, "ws-*")])
    expect(s.list()).toHaveLength(1)
    expect(s.list()[0].name).toBe("Fresh")
    expect(s.list()[0].dirs).toEqual(["/repo/web"])
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

    // A later boot with the identical manifest must not bump updatedAt nor
    // re-persist the registry file.
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

    // Change the manifest's editor — a manifest-owned field — and re-scan.
    clock = 7000
    seedManifest(dir, { name: "Ed", editor: "vim", repos: [] })
    s.discover([pattern])
    // updatedAt bumped because a manifest-owned field genuinely changed.
    expect(s.get(id)!.updatedAt).toBe(7000)
    expect(s.get(id)!.updatedAt).not.toBe(before)
  })

  it("canonSeedDir collapses drive-letter case on win32 (no-op elsewhere)", () => {
    if (process.platform === "win32") {
      expect(canonSeedDir("c:\\projects\\demo")).toBe("C:\\projects\\demo")
      expect(canonSeedDir("C:\\projects\\demo")).toBe("C:\\projects\\demo")
      // Same target, two spellings → one canonical key.
      expect(canonSeedDir("c:\\projects\\demo")).toBe(canonSeedDir("C:\\projects\\demo"))
    } else {
      // POSIX has no drive letter; the canonicalizer is an identity function.
      expect(canonSeedDir("/projects/demo")).toBe("/projects/demo")
    }
  })

  it("a re-scan whose seedDir spelling differs only by drive-letter case does NOT duplicate", () => {
    // The manifest dir `discover()` resolves uses whatever case the real temp
    // dir has. Hand-write an existing registry entry whose stored seedDir is the
    // OPPOSITE drive-letter case of that resolved dir, so the only thing letting
    // the re-scan match it is the canonicalized de-dup key.
    const wsDir = seedManifest(join(root, "ws-case"), { name: "Cased", repos: [] })
    const resolvedDir = resolve(wsDir)
    // Flip the drive-letter case of the stored seedDir (win32 only — POSIX has
    // no drive letter, so there the two spellings are identical and this still
    // exercises the in-place-update path).
    const flipped =
      process.platform === "win32"
        ? resolvedDir.replace(/^([A-Za-z]):/, (_m, d: string) =>
            d === d.toUpperCase() ? `${d.toLowerCase()}:` : `${d.toUpperCase()}:`,
          )
        : resolvedDir
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        data: {
          workspaces: [
            {
              id: "ws-pre",
              name: "Cased",
              dirs: [resolvedDir],
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
    // Still exactly one entry — the differently-cased seedDir matched the
    // canonical key instead of minting a duplicate.
    expect(s.list()).toHaveLength(1)
    expect(s.list()[0].id).toBe("ws-pre")
  })

  it("a manifest with no repos seeds its own dir as the workspace dir", () => {
    const dir = seedManifest(join(root, "ws-bare"), { name: "Bare", repos: [] })
    const s = svc()
    s.discover([join(root, "ws-*")])
    expect(s.list()[0].dirs).toEqual([dir])
  })

  it("hand-created workspaces are untouched by discovery", () => {
    const s = svc()
    const manual = s.create("Manual", ["/m"])
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

    // The internal model still carries the seed* boot fields...
    const internal = s.list()[0]
    expect(internal.seedDir).toBeDefined()
    expect(internal.seedRepos).toBeDefined()
    expect(internal.seedEditor).toBe("code")

    // ...but the public projection exposes ONLY the registry-owned fields.
    const pub = s.listPublic()[0] as unknown as Record<string, unknown>
    expect(Object.keys(pub).sort()).toEqual(
      ["color", "createdAt", "dirs", "id", "name", "updatedAt"].sort(),
    )
    expect("seedDir" in pub).toBe(false)
    expect("seedRepos" in pub).toBe(false)
    expect("seedEditor" in pub).toBe(false)
    expect(pub.name).toBe("Imported")
    expect(pub.dirs).toEqual(["/repo/api"])
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
    // First scan: one manifest on disk.
    seedManifest(join(root, "ws-one"), { name: "One", repos: [] })
    expect(s.rescan([pattern])).toHaveLength(1)

    // A NEW manifest appears on disk after boot — a re-scan seeds it live.
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

    // User renames + adds a dir via the registry API.
    s.rename(id, "UserName")
    s.addDir(id, "/extra")

    // Re-scan the SAME (unchanged) manifest — no duplicate, edits preserved.
    const after = s.rescan([pattern])
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(id)
    expect(after[0].name).toBe("UserName")
    expect(after[0].dirs).toEqual(["/repo/api", "/extra"])
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
      ["color", "createdAt", "dirs", "id", "name", "updatedAt"].sort(),
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
    // the service is still usable after a corrupt load
    const ws = s.create("Recovered")
    expect(s.get(ws.id)?.name).toBe("Recovered")
  })

  it("a legacy/garbled registry shape (workspaces not an array) loads as empty", () => {
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, data: { workspaces: "oops" } }))
    const s = svc()
    expect(s.list()).toEqual([])
    expect(s.getActiveId()).toBeNull()
  })

  it("normalizes a partial entry missing `dirs` so addDir/removeDir don't crash", () => {
    // A persisted/hand-edited entry with a valid id but no `dirs` array must
    // load as a usable workspace (dirs defaulted to []), not a landmine that
    // throws on the first mutator.
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        data: {
          workspaces: [{ id: "ws-partial" }],
          activeWorkspaceId: null,
        },
      }),
    )
    const s = svc()
    expect(s.get("ws-partial")?.dirs).toEqual([])
    // The first addDir succeeds instead of throwing on `undefined.includes`.
    expect(() => s.addDir("ws-partial", "/added")).not.toThrow()
    expect(s.get("ws-partial")?.dirs).toEqual(["/added"])
    // removeDir is likewise safe.
    expect(() => s.removeDir("ws-partial", "/added")).not.toThrow()
    expect(s.get("ws-partial")?.dirs).toEqual([])
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

  it("activate(index) spawns one session per dir for a hand-created workspace", () => {
    const s = svc()
    s.create("Manual", ["/d1", "/d2"])
    const result = s.activate(0)
    expect(result?.sessions).toHaveLength(2)
  })

  it("activate with an out-of-range index returns null", () => {
    expect(svc().activate(0)).toBeNull()
  })
})

// ── WS-B ─────────────────────────────────────────────────────────────────────
//
// A counting terminal fake whose `create` invocations are observable, so a test
// can assert SELECTION (setActive) does NOT spawn while LAUNCH does.
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
    const ws = s.create("Active", ["/d"])
    const events: Array<{ active: { id: string; name: string } | null }> = []
    s.onActiveChanged((e) => events.push(e as any))

    s.setActive(ws.id)
    expect(events).toHaveLength(1)
    expect(events[0].active?.id).toBe(ws.id)
    expect(events[0].active?.name).toBe("Active")
    // The payload is the PUBLIC projection — no internal seed* fields.
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
    s.setActive(ws.id) // no-op
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
    expect(events).toHaveLength(1) // no further events after unsubscribe
  })

  it("getActivePublic returns the public projection (no seed* leak) or null", () => {
    const s = svc()
    expect(s.getActivePublic()).toBeNull()
    const ws = s.create("Pub", ["/x"])
    s.setActive(ws.id)
    const pub = s.getActivePublic() as unknown as Record<string, unknown>
    expect(Object.keys(pub).sort()).toEqual(
      ["color", "createdAt", "dirs", "id", "name", "updatedAt"].sort(),
    )
    expect(pub.id).toBe(ws.id)
  })
})

describe("WorkspaceService WS-B selection vs launch split", () => {
  it("setActive (SELECTION) does NOT spawn any sessions", () => {
    const { terminals, createCalls } = countingTerminals()
    const s = new WorkspaceService(terminals, { file, now })
    const ws = s.create("Manual", ["/d1", "/d2"])
    s.setActive(ws.id)
    // Selection is pure: no editors, no sessions spawned.
    expect(createCalls()).toBe(0)
    expect(s.getActiveId()).toBe(ws.id)
  })

  it("launch(id) STILL spawns one session per dir (the boot verb)", () => {
    const { terminals, createCalls } = countingTerminals()
    const s = new WorkspaceService(terminals, { file, now })
    const ws = s.create("Manual", ["/d1", "/d2"])
    const result = s.launch(ws.id)
    expect(result?.workspace).toBe("Manual")
    expect(result?.sessions).toHaveLength(2)
    expect(createCalls()).toBe(2)
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
    const ws = s.create("Persisted", ["/p"])
    s.setActive(ws.id)
    expect(createCalls()).toBe(0)
    // A fresh service reads the same registry file.
    const reloaded = new WorkspaceService(fakeTerminals(), { file, now })
    expect(reloaded.getActiveId()).toBe(ws.id)
    expect(reloaded.getActivePublic()?.name).toBe("Persisted")
  })
})

describe("WorkspaceService WS-G (G1) getActiveWorkspaceDir", () => {
  it("returns the active workspace's primary dir (dirs[0]) when it exists on disk", () => {
    const d = join(root, "proj-a")
    mkdirSync(d, { recursive: true })
    const s = svc()
    const ws = s.create("A", [d, join(root, "proj-b")])
    s.setActive(ws.id)
    expect(s.getActiveWorkspaceDir()).toBe(d)
  })

  it("returns null when no workspace is active ('All' mode)", () => {
    const d = join(root, "proj-a")
    mkdirSync(d, { recursive: true })
    const s = svc()
    s.create("A", [d]) // created but NOT active
    expect(s.getActiveWorkspaceDir()).toBeNull()
  })

  it("returns null when the active workspace has no dirs", () => {
    const s = svc()
    const ws = s.create("Empty", [])
    s.setActive(ws.id)
    expect(s.getActiveWorkspaceDir()).toBeNull()
  })

  it("returns null when dirs[0] does not exist on disk (stale path → default cwd)", () => {
    const s = svc()
    const ws = s.create("Stale", [join(root, "does-not-exist")])
    s.setActive(ws.id)
    expect(s.getActiveWorkspaceDir()).toBeNull()
  })
})

describe("WorkspaceService WS-G (G3) workspace.json scaffold", () => {
  function manifestAt(dir: string) {
    return JSON.parse(readFileSync(join(dir, "workspace.json"), "utf-8"))
  }

  it("create() scaffolds a valid workspace.json into each provided dir + toasts", () => {
    const d = join(root, "scaf-a")
    mkdirSync(d, { recursive: true })
    const toasts: Array<{ message: string; level: string }> = []
    const s = new WorkspaceService(fakeTerminals(), {
      file,
      now,
      notify: (message, level) => toasts.push({ message, level }),
    })
    s.create("Billing", [d])

    // The manifest exists and matches the discovery schema ({ name, alias?, editor?, repos? }).
    expect(existsSync(join(d, "workspace.json"))).toBe(true)
    const m = manifestAt(d)
    expect(m.name).toBe("Billing")
    expect(m.editor).toBe("code")
    expect(Array.isArray(m.repos)).toBe(true)
    // Toasted the user.
    expect(toasts.some((t) => t.message.includes("workspace.json") && t.level === "success")).toBe(true)
  })

  it("addDir() scaffolds a workspace.json into the newly-added dir", () => {
    const s = svc()
    const ws = s.create("Svc", []) // dirless to start
    const d = join(root, "scaf-add")
    mkdirSync(d, { recursive: true })
    s.addDir(ws.id, d)
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
    s.create("DifferentName", [d])
    // The original manifest is untouched.
    expect(manifestAt(d)).toEqual(original)
    // No "Created workspace.json" toast for a skipped write.
    expect(toasts.some((t) => t.includes("Created workspace.json"))).toBe(false)
  })

  it("scaffolds nothing for a non-existent dir (best-effort, no throw)", () => {
    const d = join(root, "scaf-missing")
    const s = svc()
    expect(() => s.create("Ghost", [d])).not.toThrow()
    expect(existsSync(join(d, "workspace.json"))).toBe(false)
  })

  it("⚠ rescan AFTER a scaffold produces NO duplicate + keeps user edits (the trap)", () => {
    // Create a workspace with a dir → scaffolds workspace.json + binds seedDir.
    const d = join(root, "ws-scaf-dedup")
    mkdirSync(d, { recursive: true })
    const s = svc()
    const ws = s.create("Mine", [d])
    s.rename(ws.id, "MyRenamed") // a user edit that must survive

    // The scaffold wrote a manifest into d, which is now reachable by the scan glob.
    expect(existsSync(join(d, "workspace.json"))).toBe(true)

    // A rescan discovers the scaffolded manifest. Without the seedDir bind it would
    // mint a DUPLICATE; with it, it reconciles back to THIS entry.
    const after = s.rescan([join(root, "ws-scaf-dedup")])
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(ws.id)
    expect(after[0].name).toBe("MyRenamed") // user edit intact
    expect(after[0].dirs).toEqual([d])
  })

  it("rescan-after-scaffold is duplicate-free for a MULTI-dir workspace (discover dir-match)", () => {
    // Two dirs scaffold two manifests, but only the FIRST binds seedDir; the SECOND
    // must reconcile via discover's belt-and-suspenders listed-dir match (no dup).
    const d1 = join(root, "ws-multi-a")
    const d2 = join(root, "ws-multi-b")
    mkdirSync(d1, { recursive: true })
    mkdirSync(d2, { recursive: true })
    const s = svc()
    const ws = s.create("Multi", [d1, d2])
    expect(existsSync(join(d1, "workspace.json"))).toBe(true)
    expect(existsSync(join(d2, "workspace.json"))).toBe(true)

    const after = s.rescan([join(root, "ws-multi-*")])
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(ws.id)
    expect(after[0].dirs).toEqual([d1, d2])
  })
})
