import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { WorkspaceService } from "./workspaces"
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

  it("discovery refreshes a seeded entry's name in place on re-scan", () => {
    const dir = join(root, "ws-renamed")
    seedManifest(dir, { name: "First", repos: [] })
    const pattern = join(root, "ws-*")
    const s = svc()
    s.discover([pattern])
    const id = s.list()[0].id
    expect(s.list()[0].name).toBe("First")
    // rewrite the manifest with a new name, re-scan
    seedManifest(dir, { name: "Second", repos: [] })
    s.discover([pattern])
    expect(s.list()).toHaveLength(1)
    expect(s.list()[0].id).toBe(id)
    expect(s.list()[0].name).toBe("Second")
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
