import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  SchedulerService,
  type SchedulerDeps,
  type RunEnd,
  type Recurrence,
  type Schedule,
} from "./scheduler"

// A recorded, drivable fake for every external effect. No real terminals /
// sessions / timers — the scheduler runs entirely against this.
interface FakeDeps extends SchedulerDeps {
  calls: {
    ensured: Array<{ scheduleId: string; name: string; workspaceId?: string; sessionId?: string }>
    spawned: Array<{ scheduleId: string; sessionId: string; name: string; model?: string; effort?: string; ultracode?: boolean }>
    prompts: Array<{ terminalId: string; prompt: string }>
    killed: string[]
    retired: Array<{ sessionId: string; terminalId: string }>
    attention: Array<{ sessionId: string; terminalId?: string; reason: string }>
  }
  emitEnd: (end: RunEnd) => void
  alive: Set<string>
  failSpawn: boolean
  failEnsure: boolean
  lastTerminalId: () => string | undefined
}

function makeFakeDeps(): FakeDeps {
  let runEndCb: ((e: RunEnd) => void) | null = null
  let nextTid = 0
  let lastTid: string | undefined
  const sessById = new Map<string, string>()
  const alive = new Set<string>()
  const calls: FakeDeps["calls"] = {
    ensured: [], spawned: [], prompts: [], killed: [], retired: [], attention: [],
  }
  const fake: FakeDeps = {
    alive,
    calls,
    failSpawn: false,
    failEnsure: false,
    lastTerminalId: () => lastTid,
    emitEnd: (e) => runEndCb?.(e),
    ensureSession: (o) => {
      calls.ensured.push(o)
      if (fake.failEnsure) return undefined
      if (o.sessionId) return o.sessionId
      const existing = sessById.get(o.scheduleId)
      if (existing) return existing
      const id = `sess-${o.scheduleId}`
      sessById.set(o.scheduleId, id)
      return id
    },
    spawnRun: (o) => {
      calls.spawned.push(o)
      if (fake.failSpawn) return undefined
      const tid = `term-${++nextTid}`
      lastTid = tid
      alive.add(tid)
      return tid
    },
    sendPrompt: (terminalId, prompt) => {
      calls.prompts.push({ terminalId, prompt })
      return true
    },
    killTerminal: (terminalId) => {
      calls.killed.push(terminalId)
      alive.delete(terminalId)
    },
    retireTerminal: (sessionId, terminalId) => {
      calls.retired.push({ sessionId, terminalId })
      alive.delete(terminalId)
    },
    isTerminalAlive: (terminalId) => alive.has(terminalId),
    onRunEnd: (cb) => {
      runEndCb = cb
      return () => { runEndCb = null }
    },
    raiseAttention: (o) => calls.attention.push(o),
  }
  return fake
}

const interval1: Recurrence = { kind: "interval", everyMinutes: 1 }

function baseInput(over: Partial<Parameters<SchedulerService["create"]>[0]> = {}) {
  return { name: "Fable watch", prompt: "check the web", recurrence: interval1, ...over }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scheduler-test-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("SchedulerService CRUD + persistence", () => {
  it("creates, derives nextRunAt, and persists a versioned file", () => {
    const svc = new SchedulerService(makeFakeDeps(), { dir, now: () => 1000 })
    const s = svc.create(baseInput())
    expect(s.enabled).toBe(true)
    expect(s.nextRunAt).toBe(new Date(1000 + 60_000).toISOString()) // +1 min
    expect(s.runHistory).toEqual([])
    const onDisk = JSON.parse(readFileSync(join(dir, `${s.id}.json`), "utf-8"))
    expect(onDisk.schemaVersion).toBe(1)
    expect(onDisk.data.name).toBe("Fable watch")
    // reloads in a fresh instance
    const svc2 = new SchedulerService(makeFakeDeps(), { dir })
    expect(svc2.get(s.id)?.prompt).toBe("check the web")
  })

  it("a disabled schedule has no nextRunAt", () => {
    const svc = new SchedulerService(makeFakeDeps(), { dir, now: () => 1000 })
    const s = svc.create(baseInput({ enabled: false }))
    expect(s.nextRunAt).toBeNull()
  })

  it("stamps workspaceId + spawn opts only when provided", () => {
    const svc = new SchedulerService(makeFakeDeps(), { dir })
    const tagged = svc.create(baseInput({ workspaceId: "ws-1", model: "sonnet", effort: "high", ultracode: true }))
    expect(tagged.workspaceId).toBe("ws-1")
    expect(tagged.model).toBe("sonnet")
    expect(tagged.effort).toBe("high")
    expect(tagged.ultracode).toBe(true)
    const untagged = svc.create(baseInput())
    const onDisk = JSON.parse(readFileSync(join(dir, `${untagged.id}.json`), "utf-8"))
    expect("workspaceId" in onDisk.data).toBe(false)
    expect("model" in onDisk.data).toBe(false)
  })

  it("lists newest-created first", () => {
    let t = 1000
    const svc = new SchedulerService(makeFakeDeps(), { dir, now: () => t })
    const a = svc.create(baseInput({ name: "a" }))
    t = 2000
    const b = svc.create(baseInput({ name: "b" }))
    expect(svc.list().map((s) => s.id)).toEqual([b.id, a.id])
  })

  it("update patches fields and re-derives nextRunAt on recurrence change", () => {
    let t = 1000
    const svc = new SchedulerService(makeFakeDeps(), { dir, now: () => t })
    const s = svc.create(baseInput())
    t = 5000
    const out = svc.update(s.id, { name: "renamed", recurrence: { kind: "interval", everyMinutes: 2 } })!
    expect(out.name).toBe("renamed")
    expect(out.nextRunAt).toBe(new Date(5000 + 120_000).toISOString())
  })

  it("disable then re-enable re-derives nextRunAt from now", () => {
    let t = 1000
    const svc = new SchedulerService(makeFakeDeps(), { dir, now: () => t })
    const s = svc.create(baseInput())
    svc.update(s.id, { enabled: false })
    t = 9000
    const out = svc.update(s.id, { enabled: true })!
    expect(out.enabled).toBe(true)
    expect(out.nextRunAt).toBe(new Date(9000 + 60_000).toISOString())
  })

  it("delete removes the file + emits removed; a fresh load does not resurrect it", () => {
    const svc = new SchedulerService(makeFakeDeps(), { dir })
    const s = svc.create(baseInput())
    const events: Array<{ type: string; id: string }> = []
    svc.onEvent((e) => events.push(e.type === "removed" ? { type: "removed", id: e.id } : { type: "updated", id: e.schedule.id }))
    expect(svc.delete(s.id)).toBe(true)
    expect(existsSync(join(dir, `${s.id}.json`))).toBe(false)
    expect(events).toEqual([{ type: "removed", id: s.id }])
    const reloaded = new SchedulerService(makeFakeDeps(), { dir })
    expect(reloaded.get(s.id)).toBeUndefined()
  })

  it("delete returns false for an unknown id", () => {
    const svc = new SchedulerService(makeFakeDeps(), { dir })
    expect(svc.delete("nope")).toBe(false)
  })
})

describe("SchedulerService tick — firing", () => {
  it("fires a due schedule: ensures session, spawns structured, delivers the prompt", () => {
    let t = 1000
    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir, now: () => t })
    const s = svc.create(baseInput({ model: "opus", ultracode: true }))
    t = 61_000 // now due
    svc.tick()
    expect(deps.calls.ensured).toHaveLength(1)
    expect(deps.calls.spawned).toHaveLength(1)
    expect(deps.calls.spawned[0]).toMatchObject({ sessionId: `sess-${s.id}`, name: "Fable watch", model: "opus", ultracode: true })
    expect(deps.calls.prompts).toEqual([{ terminalId: deps.lastTerminalId()!, prompt: "check the web" }])
    // No run record yet — a record lands only when the run ENDS.
    expect(svc.get(s.id)!.runHistory).toEqual([])
    // nextRunAt advanced from the fire time.
    expect(svc.get(s.id)!.nextRunAt).toBe(new Date(61_000 + 60_000).toISOString())
    // The session id is remembered on the schedule for reuse.
    expect(svc.get(s.id)!.sessionId).toBe(`sess-${s.id}`)
  })

  it("does not fire a disabled schedule", () => {
    let t = 1000
    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir, now: () => t })
    const s = svc.create(baseInput())
    svc.update(s.id, { enabled: false })
    t = 999_999
    svc.tick()
    expect(deps.calls.spawned).toHaveLength(0)
  })

  it("records ok + retires the run terminal when a run ends with a result", () => {
    let t = 1000
    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir, now: () => t })
    const s = svc.create(baseInput())
    svc.runNow(s.id)
    const tid = deps.lastTerminalId()!
    t = 4000
    deps.emitEnd({ terminalId: tid, kind: "result", isError: false, note: "found a hit" })
    const rec = svc.get(s.id)!.runHistory[0]
    expect(rec).toMatchObject({ status: "ok", note: "found a hit", terminalId: tid, sessionId: `sess-${s.id}`, durationMs: 3000 })
    expect(deps.calls.retired).toEqual([{ sessionId: `sess-${s.id}`, terminalId: tid }])
  })

  it("keepTerminal:true records ok WITHOUT retiring", () => {
    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir, now: () => 1000 })
    const s = svc.create(baseInput({ keepTerminal: true }))
    svc.runNow(s.id)
    deps.emitEnd({ terminalId: deps.lastTerminalId()!, kind: "result", isError: false })
    expect(svc.get(s.id)!.runHistory[0].status).toBe("ok")
    expect(deps.calls.retired).toHaveLength(0)
  })

  it("records error + raises attention when a run ends with an error result", () => {
    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir, now: () => 1000 })
    const s = svc.create(baseInput())
    svc.runNow(s.id)
    deps.emitEnd({ terminalId: deps.lastTerminalId()!, kind: "result", isError: true, note: "boom" })
    expect(svc.get(s.id)!.runHistory[0].status).toBe("error")
    expect(deps.calls.attention).toHaveLength(1)
    expect(deps.calls.attention[0].reason).toContain("ended with an error")
  })

  it("records error when the run terminal exits before completing", () => {
    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir, now: () => 1000 })
    const s = svc.create(baseInput())
    svc.runNow(s.id)
    const tid = deps.lastTerminalId()!
    deps.emitEnd({ terminalId: tid, kind: "exit" })
    const rec = svc.get(s.id)!.runHistory[0]
    expect(rec.status).toBe("error")
    // An exit already tore the terminal down — never retire it.
    expect(deps.calls.retired).toHaveLength(0)
    expect(deps.calls.attention).toHaveLength(1)
  })

  it("ignores a run-end for a terminal it isn't tracking", () => {
    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir, now: () => 1000 })
    const s = svc.create(baseInput())
    deps.emitEnd({ terminalId: "term-unknown", kind: "result" })
    expect(svc.get(s.id)!.runHistory).toEqual([])
  })
})

describe("SchedulerService overlap guard + concurrency cap", () => {
  it("skips-overlap when the previous run terminal is still alive (does not stack)", () => {
    let t = 1000
    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir, now: () => t })
    const s = svc.create(baseInput())
    t = 61_000
    svc.tick() // fires run 1 (term-1 alive, never ends)
    expect(deps.calls.spawned).toHaveLength(1)
    t = 121_000 // due again while term-1 is still alive
    svc.tick()
    expect(deps.calls.spawned).toHaveLength(1) // no second spawn
    expect(svc.get(s.id)!.runHistory[0].status).toBe("skipped-overlap")
    // nextRunAt still advanced so it doesn't spin.
    expect(svc.get(s.id)!.nextRunAt).toBe(new Date(121_000 + 60_000).toISOString())
  })

  it("proceeds once the previous run's terminal is gone", () => {
    let t = 1000
    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir, now: () => t })
    const s = svc.create(baseInput())
    t = 61_000
    svc.tick()
    const tid = deps.lastTerminalId()!
    deps.emitEnd({ terminalId: tid, kind: "result" }) // clears the run (retire removes it from alive)
    t = 121_000
    svc.tick()
    expect(deps.calls.spawned).toHaveLength(2)
  })

  it("caps machine-wide concurrent runs at maxConcurrent (over cap stays due)", () => {
    let t = 1000
    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir, now: () => t, maxConcurrent: 2 })
    const a = svc.create(baseInput({ name: "a" }))
    const b = svc.create(baseInput({ name: "b" }))
    const c = svc.create(baseInput({ name: "c" }))
    t = 61_000 // all three due, none of their runs will end
    svc.tick()
    expect(deps.calls.spawned).toHaveLength(2) // only two fired
    // The third stayed due (no record, nextRunAt still in the past).
    const third = svc.get(c.id)!
    expect(third.runHistory).toEqual([])
    expect(new Date(third.nextRunAt!).getTime()).toBeLessThanOrEqual(61_000)
    void a; void b
  })
})

describe("SchedulerService timeout reaper", () => {
  it("kills only the run terminal past maxRuntimeMs, records timeout, raises attention", () => {
    let t = 1000
    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir, now: () => t })
    const s = svc.create(baseInput({ maxRuntimeMs: 5000 }))
    svc.runNow(s.id)
    const tid = deps.lastTerminalId()!
    t = 6001 // > startedAt(1000) + 5000
    svc.tick()
    expect(deps.calls.killed).toContain(tid)
    const rec = svc.get(s.id)!.runHistory[0]
    expect(rec).toMatchObject({ status: "timeout", terminalId: tid })
    expect(deps.calls.attention).toHaveLength(1)
    expect(deps.calls.attention[0].reason).toContain("timed out")
    // No double-record from the kill's re-entrant exit signal.
    expect(svc.get(s.id)!.runHistory).toHaveLength(1)
  })
})

describe("SchedulerService fire failure paths", () => {
  it("records error when the session cannot be ensured", () => {
    const deps = makeFakeDeps()
    deps.failEnsure = true
    const svc = new SchedulerService(deps, { dir, now: () => 1000 })
    const s = svc.create(baseInput())
    svc.runNow(s.id)
    expect(deps.calls.spawned).toHaveLength(0)
    expect(svc.get(s.id)!.runHistory[0].status).toBe("error")
  })

  it("records error + raises attention when the run terminal cannot spawn", () => {
    const deps = makeFakeDeps()
    deps.failSpawn = true
    const svc = new SchedulerService(deps, { dir, now: () => 1000 })
    const s = svc.create(baseInput())
    svc.runNow(s.id)
    expect(svc.get(s.id)!.runHistory[0].status).toBe("error")
    expect(deps.calls.attention).toHaveLength(1)
  })
})

describe("SchedulerService runNow", () => {
  it("fires immediately regardless of due-ness", () => {
    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir, now: () => 1000 })
    const s = svc.create(baseInput()) // nextRunAt far in the future (not due)
    expect(svc.runNow(s.id)).toBe(true)
    expect(deps.calls.spawned).toHaveLength(1)
  })

  it("is overlap-guarded: refuses while a run is alive", () => {
    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir, now: () => 1000 })
    const s = svc.create(baseInput())
    svc.runNow(s.id)
    expect(svc.runNow(s.id)).toBe(false)
    expect(deps.calls.spawned).toHaveLength(1)
    expect(svc.get(s.id)!.runHistory[0].status).toBe("skipped-overlap")
  })

  it("returns false for an unknown id", () => {
    const svc = new SchedulerService(makeFakeDeps(), { dir })
    expect(svc.runNow("nope")).toBe(false)
  })
})

describe("SchedulerService launch catch-up", () => {
  function seedMissedSchedule(catchUp: boolean): { file: string; id: string } {
    // Create while "now" is early so nextRunAt lands in the past relative to the
    // later launch; persist to disk, then a fresh service loads it.
    const svc = new SchedulerService(makeFakeDeps(), { dir, now: () => 1000 })
    const s = svc.create(baseInput({ catchUp }))
    return { file: join(dir, `${s.id}.json`), id: s.id }
  }

  it("records skipped-missed (default) and re-derives nextRunAt from now", () => {
    const { id } = seedMissedSchedule(false)
    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir, now: () => 5_000_000 })
    svc.start()
    svc.stop()
    expect(deps.calls.spawned).toHaveLength(0)
    const s = svc.get(id)!
    expect(s.runHistory[0].status).toBe("skipped-missed")
    expect(new Date(s.nextRunAt!).getTime()).toBeGreaterThan(5_000_000)
  })

  it("catchUp:true fires EXACTLY ONE catch-up run", () => {
    const { id } = seedMissedSchedule(true)
    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir, now: () => 5_000_000 })
    svc.start()
    svc.stop()
    expect(deps.calls.spawned).toHaveLength(1)
    expect(svc.get(id)!.sessionId).toBe(`sess-${id}`)
  })
})

describe("SchedulerService event seam", () => {
  it("emits exactly one 'updated' per persist-routed mutation", () => {
    const svc = new SchedulerService(makeFakeDeps(), { dir })
    const s = svc.create(baseInput())
    const events: string[] = []
    svc.onEvent((e) => events.push(e.type))
    svc.update(s.id, { name: "x" })
    expect(events).toEqual(["updated"])
  })

  it("run-history caps at 50 (newest first)", () => {
    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir, now: () => 1000 })
    const s = svc.create(baseInput({ keepTerminal: true }))
    for (let i = 0; i < 60; i++) {
      svc.runNow(s.id)
      deps.emitEnd({ terminalId: deps.lastTerminalId()!, kind: "result", note: `run ${i}` })
    }
    const hist = svc.get(s.id)!.runHistory
    expect(hist).toHaveLength(50)
    expect(hist[0].note).toBe("run 59") // newest first
  })
})

// A tiny type-only guard so a Schedule shape drift surfaces here too.
const _shape: Schedule | undefined = undefined
void _shape
