import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  WorkspaceMemoryService,
  SCHEMA_VERSION,
  type PromoteEntry,
  type WorkspaceMemoryRecord,
} from "./workspaceMemory"
import { RecallService } from "./recall"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ctui-wsmem-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Read a bucket file's payload (the unwrapped `data`). */
function readData(file: string): any {
  return JSON.parse(readFileSync(file, "utf-8")).data
}

describe("WorkspaceMemoryService — storage / round-trip", () => {
  it("persists a real-id record to <dir>/<id>.json in the versioned envelope", () => {
    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    svc.setInstructions("ws-1", "always use vitest")
    const finding = svc.addFinding("ws-1", "uses electron-vite", "user")

    const file = join(dir, "ws-1.json")
    expect(existsSync(file)).toBe(true)
    const onDisk = JSON.parse(readFileSync(file, "utf-8"))
    expect(onDisk.schemaVersion).toBe(SCHEMA_VERSION)
    expect(onDisk.data.workspaceId).toBe("ws-1")
    expect(onDisk.data.instructions).toBe("always use vitest")
    expect(onDisk.data.findings).toHaveLength(1)
    expect(onDisk.data.findings[0].id).toBe(finding.id)
    // no leftover tmp file
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it("a fresh service round-trips a real id from disk", () => {
    const a = new WorkspaceMemoryService({ dir, now: () => 1000 })
    a.setInstructions("ws-7", "north star")
    a.addFinding("ws-7", "finding A", "agent")

    const b = new WorkspaceMemoryService({ dir, now: () => 2000 })
    const loaded = b.getMemory("ws-7")
    expect(loaded.instructions).toBe("north star")
    expect(loaded.findings.map((f) => f.text)).toEqual(["finding A"])
  })

  it("persists + round-trips the UNTAGGED bucket to __untagged__.json", () => {
    const a = new WorkspaceMemoryService({ dir, now: () => 1000 })
    a.addFinding(null, "global finding", "user")

    const file = join(dir, "__untagged__.json")
    expect(existsSync(file)).toBe(true)
    expect(readData(file).findings[0].text).toBe("global finding")

    const b = new WorkspaceMemoryService({ dir, now: () => 2000 })
    expect(b.getMemory(null).findings.map((f) => f.text)).toEqual(["global finding"])
  })

  it("missing file → an empty record from getMemory (no throw)", () => {
    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    const rec = svc.getMemory("never-written")
    expect(rec.workspaceId).toBe("never-written")
    expect(rec.instructions).toBe("")
    expect(rec.findings).toEqual([])
  })

  it("forward-compat: a file written with schemaVersion 2 loads as-is (no throw)", () => {
    const future: WorkspaceMemoryRecord = {
      workspaceId: "ws-future",
      instructions: "from the future",
      findings: [],
      createdAt: 1,
      updatedAt: 1,
    }
    writeFileSync(
      join(dir, "ws-future.json"),
      JSON.stringify({ schemaVersion: 2, data: future }, null, 2),
    )
    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    expect(() => svc.getMemory("ws-future")).not.toThrow()
    expect(svc.getMemory("ws-future").instructions).toBe("from the future")
  })
})

describe("WorkspaceMemoryService — mutators persist + emit", () => {
  it("each mutator persists AND fires onMemoryChanged", () => {
    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    const events: string[] = []
    svc.onMemoryChanged((id) => events.push(id))

    svc.setInstructions("ws-1", "ctx")
    const f = svc.addFinding("ws-1", "a", "user")
    svc.editFinding("ws-1", f.id, "a-edited")
    svc.deleteFinding("ws-1", f.id)
    svc.promoteFindings("ws-1", [{ text: "p", originSessionId: "s1", originNoteId: "n1" }])

    // 5 mutators → 5 emits, all carrying the real workspace id
    expect(events).toEqual(["ws-1", "ws-1", "ws-1", "ws-1", "ws-1"])

    // on disk reflects the last state
    const data = readData(join(dir, "ws-1.json"))
    expect(data.instructions).toBe("ctx")
    expect(data.findings.map((x: any) => x.text)).toEqual(["p"])
  })

  it("the untagged bucket emits the sentinel stem as the changed id", () => {
    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    const events: string[] = []
    svc.onMemoryChanged((id) => events.push(id))
    svc.addFinding(null, "global", "agent")
    expect(events).toEqual(["__untagged__"])
  })

  it("unsubscribe stops further emits", () => {
    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    const events: string[] = []
    const off = svc.onMemoryChanged((id) => events.push(id))
    svc.addFinding("ws-1", "a", "user")
    off()
    svc.addFinding("ws-1", "b", "user")
    expect(events).toEqual(["ws-1"])
  })

  it("editFinding / deleteFinding return false for an unknown finding (no emit)", () => {
    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    const events: string[] = []
    svc.onMemoryChanged((id) => events.push(id))
    expect(svc.editFinding("ws-1", "nope", "x")).toBe(false)
    expect(svc.deleteFinding("ws-1", "nope")).toBe(false)
    expect(events).toEqual([])
  })

  it("addFinding stamps createdAt === promotedAt for authored findings", () => {
    const svc = new WorkspaceMemoryService({ dir, now: () => 4242 })
    const f = svc.addFinding("ws-1", "authored", "agent")
    expect(f.createdAt).toBe(4242)
    expect(f.promotedAt).toBe(4242)
    expect(f.source).toBe("agent")
    expect(f.status).toBe("active")
  })
})

describe("WorkspaceMemoryService — setPinned (CAPP-97)", () => {
  it("pins a finding, persists `pinned:true`, and survives a reload from disk", () => {
    const a = new WorkspaceMemoryService({ dir, now: () => 1000 })
    const f = a.addFinding("ws-1", "foundational rule", "user")
    expect(f.pinned).toBeUndefined()

    expect(a.setPinned("ws-1", f.id, true)).toBe(true)
    // On disk the key is present + true.
    const data = readData(join(dir, "ws-1.json"))
    expect(data.findings[0].pinned).toBe(true)

    // A fresh service round-trips the pin.
    const b = new WorkspaceMemoryService({ dir, now: () => 2000 })
    expect(b.getMemory("ws-1").findings[0].pinned).toBe(true)
  })

  it("unpinning DROPS the key entirely (clean file — additive-optional posture)", () => {
    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    const f = svc.addFinding("ws-1", "rule", "user")
    svc.setPinned("ws-1", f.id, true)
    svc.setPinned("ws-1", f.id, false)
    const data = readData(join(dir, "ws-1.json"))
    expect("pinned" in data.findings[0]).toBe(false)
  })

  it("is idempotent + always emits onMemoryChanged (so an open editor live-refreshes)", () => {
    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    const f = svc.addFinding("ws-1", "rule", "user")
    const events: string[] = []
    svc.onMemoryChanged((id) => events.push(id))
    // Setting the value it already has (false) still goes through persistAndEmit.
    expect(svc.setPinned("ws-1", f.id, false)).toBe(true)
    expect(svc.setPinned("ws-1", f.id, true)).toBe(true)
    expect(svc.setPinned("ws-1", f.id, true)).toBe(true)
    expect(events).toEqual(["ws-1", "ws-1", "ws-1"])
    expect(svc.getMemory("ws-1").findings[0].pinned).toBe(true)
  })

  it("returns false (no emit) for an unknown finding id", () => {
    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    svc.addFinding("ws-1", "rule", "user")
    const events: string[] = []
    svc.onMemoryChanged((id) => events.push(id))
    expect(svc.setPinned("ws-1", "ghost", true)).toBe(false)
    expect(events).toEqual([])
  })

  it("a pinned finding flows through RecallService.workspaceTierEntries as pinned:true", () => {
    const mem = new WorkspaceMemoryService({ dir, now: () => 1000 })
    const f = mem.addFinding("ws-1", "always run the gate", "user")
    mem.setPinned("ws-1", f.id, true)

    const recall = new RecallService(
      () => [],
      () => mem.listWorkspaceMemory(),
    )
    const entries = recall.workspaceTierEntries("ws-1")
    const hit = entries.find((e) => e.text === "always run the gate")
    expect(hit?.pinned).toBe(true)
  })
})

describe("WorkspaceMemoryService — lazy-load-before-mutate (no clobber)", () => {
  it("promoteFindings into a never-read on-disk workspace APPENDS, not overwrites", () => {
    // Pre-write a record straight to disk (a fresh service has never read it).
    const seeded: WorkspaceMemoryRecord = {
      workspaceId: "ws-1",
      instructions: "seed ctx",
      findings: [
        {
          id: "note-existing",
          text: "on-disk finding",
          createdAt: 5,
          source: "self",
          status: "active",
          promotedAt: 5,
        },
      ],
      createdAt: 5,
      updatedAt: 5,
    }
    writeFileSync(
      join(dir, "ws-1.json"),
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, data: seeded }, null, 2),
    )

    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    svc.promoteFindings("ws-1", [{ text: "promoted", originSessionId: "s9", originNoteId: "n9" }])

    const data = readData(join(dir, "ws-1.json"))
    expect(data.instructions).toBe("seed ctx") // preserved
    expect(data.findings.map((f: any) => f.text)).toEqual(["on-disk finding", "promoted"])
  })

  it("addFinding into a never-read on-disk workspace APPENDS, not overwrites", () => {
    const seeded: WorkspaceMemoryRecord = {
      workspaceId: "ws-2",
      instructions: "",
      findings: [
        {
          id: "note-keep",
          text: "keep me",
          createdAt: 5,
          source: "user",
          status: "active",
          promotedAt: 5,
        },
      ],
      createdAt: 5,
      updatedAt: 5,
    }
    writeFileSync(
      join(dir, "ws-2.json"),
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, data: seeded }, null, 2),
    )

    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    svc.addFinding("ws-2", "new one", "agent")

    const texts = readData(join(dir, "ws-2.json")).findings.map((f: any) => f.text)
    expect(texts).toEqual(["keep me", "new one"])
  })
})

describe("WorkspaceMemoryService — promoteFindings re-mint + supersede rewrite", () => {
  it("re-mints fresh ids at this tier (not the origin note ids)", () => {
    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    const entries: PromoteEntry[] = [
      { text: "a", originSessionId: "s1", originNoteId: "n-a", source: "self" },
    ]
    const [twin] = svc.promoteFindings("ws-1", entries)
    expect(twin.id).not.toBe("n-a")
    expect(twin.id).toMatch(/^note-/)
    expect(twin.originNoteId).toBe("n-a")
    expect(twin.originSessionId).toBe("s1")
    // createdAt copied through (here defaulted to now since none provided), promotedAt = now
    expect(twin.promotedAt).toBe(1000)
  })

  it("copies the origin createdAt as-is, distinct from promotedAt", () => {
    const svc = new WorkspaceMemoryService({ dir, now: () => 9999 })
    const [twin] = svc.promoteFindings("ws-1", [
      { text: "old", originSessionId: "s1", originNoteId: "n1", createdAt: 111 },
    ])
    expect(twin.createdAt).toBe(111)
    expect(twin.promotedAt).toBe(9999)
  })

  it("rewrites an in-batch supersededBy to the new workspace twin id", () => {
    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    // n-old was corrected by n-new in-session; both promoted in one batch.
    const entries: PromoteEntry[] = [
      { text: "wrong claim", originSessionId: "s1", originNoteId: "n-old", status: "superseded", supersededBy: "n-new" },
      { text: "the correction", originSessionId: "s1", originNoteId: "n-new", status: "active" },
    ]
    const [oldTwin, newTwin] = svc.promoteFindings("ws-1", entries)
    expect(oldTwin.status).toBe("superseded")
    // re-pointed to the WORKSPACE twin id, not the origin note id
    expect(oldTwin.supersededBy).toBe(newTwin.id)
    expect(oldTwin.supersededBy).not.toBe("n-new")
  })

  it("orphan corrector (trimmed from batch) stays superseded with supersededBy undefined", () => {
    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    // Only the superseded note is promoted; its corrector n-new was trimmed.
    const [twin] = svc.promoteFindings("ws-1", [
      { text: "wrong claim", originSessionId: "s1", originNoteId: "n-old", status: "superseded", supersededBy: "n-new" },
    ])
    expect(twin.status).toBe("superseded") // NOT downgraded to active
    expect(twin.supersededBy).toBeUndefined()
  })
})

describe("WorkspaceMemoryService — promoteFindings idempotency", () => {
  it("promoting the same (originSessionId, originNoteId) twice yields ONE finding (in-place update)", () => {
    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    const first = svc.promoteFindings("ws-1", [
      { text: "v1", originSessionId: "s1", originNoteId: "n1", status: "active" },
    ])
    const second = svc.promoteFindings("ws-1", [
      { text: "v2-edited", originSessionId: "s1", originNoteId: "n1", status: "superseded" },
    ])

    const rec = svc.getMemory("ws-1")
    expect(rec.findings).toHaveLength(1)
    // updated in place — same id, new text/status
    expect(second[0].id).toBe(first[0].id)
    expect(rec.findings[0].text).toBe("v2-edited")
    expect(rec.findings[0].status).toBe("superseded")
  })

  it("authored entries (no originNoteId) always mint fresh, even with identical text", () => {
    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    svc.promoteFindings("ws-1", [{ text: "same" }])
    svc.promoteFindings("ws-1", [{ text: "same" }])
    expect(svc.getMemory("ws-1").findings).toHaveLength(2)
  })

  it("idempotency is keyed on the PAIR — same noteId in a different session is distinct", () => {
    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    svc.promoteFindings("ws-1", [{ text: "a", originSessionId: "sA", originNoteId: "n1" }])
    svc.promoteFindings("ws-1", [{ text: "b", originSessionId: "sB", originNoteId: "n1" }])
    expect(svc.getMemory("ws-1").findings).toHaveLength(2)
  })
})

describe("WorkspaceMemoryService — listWorkspaceMemory", () => {
  it("returns in-memory cached buckets (real id + untagged stem)", () => {
    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    svc.addFinding("ws-1", "a", "user")
    svc.addFinding(null, "global", "agent")

    const all = svc.listWorkspaceMemory()
    const byId = new Map(all.map((m) => [m.workspaceId, m.findings]))
    expect(byId.get("ws-1")?.map((f) => f.text)).toEqual(["a"])
    expect(byId.get("__untagged__")?.map((f) => f.text)).toEqual(["global"])
  })
})

describe("WorkspaceMemoryService — cold-start cache warming (loadAll)", () => {
  it("a fresh service loads ALL existing bucket files (recall sees memory after restart, no touch needed)", () => {
    // Seed two buckets via one service instance...
    const a = new WorkspaceMemoryService({ dir, now: () => 1000 })
    a.addFinding("ws-1", "real ws finding", "user")
    a.addFinding(null, "global finding", "agent")

    // ...then a FRESH service over the same dir. Without loadAll, listWorkspaceMemory
    // would be empty until a bucket is touched — here nothing is touched on `b`.
    const b = new WorkspaceMemoryService({ dir, now: () => 2000 })
    const byId = new Map(b.listWorkspaceMemory().map((m) => [m.workspaceId, m.findings]))
    expect(byId.get("ws-1")?.map((f) => f.text)).toEqual(["real ws finding"])
    expect(byId.get("__untagged__")?.map((f) => f.text)).toEqual(["global finding"])
  })
})

describe("WorkspaceMemoryService — sentinel safety", () => {
  it("rejects a literal '__untagged__' workspaceId at every public method", () => {
    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    expect(() => svc.getMemory("__untagged__")).toThrow()
    expect(() => svc.setInstructions("__untagged__", "x")).toThrow()
    expect(() => svc.addFinding("__untagged__", "x", "user")).toThrow()
    expect(() => svc.editFinding("__untagged__", "id", "x")).toThrow()
    expect(() => svc.deleteFinding("__untagged__", "id")).toThrow()
    expect(() => svc.promoteFindings("__untagged__", [{ text: "x" }])).toThrow()
  })

  it("deleteForWorkspace REFUSES the untagged sentinel (no-op, no file touched)", () => {
    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    svc.addFinding(null, "global", "user")
    const file = join(dir, "__untagged__.json")
    expect(existsSync(file)).toBe(true)
    svc.deleteForWorkspace("__untagged__") // logs a warning, does nothing
    expect(existsSync(file)).toBe(true)
  })

  it("deleteForWorkspace unlinks a REAL id's file and drops the cache entry", () => {
    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    svc.addFinding("ws-9", "a", "user")
    const file = join(dir, "ws-9.json")
    expect(existsSync(file)).toBe(true)

    svc.deleteForWorkspace("ws-9")
    expect(existsSync(file)).toBe(false)
    // cache dropped → a subsequent read mints a fresh empty record
    expect(svc.getMemory("ws-9").findings).toEqual([])
  })

  it("deleteForWorkspace on a non-existent id is a safe no-op", () => {
    const svc = new WorkspaceMemoryService({ dir, now: () => 1000 })
    expect(() => svc.deleteForWorkspace("ghost")).not.toThrow()
  })
})
