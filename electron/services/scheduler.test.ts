import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "fs"
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
    spawned: Array<{ scheduleId: string; sessionId: string; name: string; cwd?: string; workspaceId?: string; model?: string; effort?: string; ultracode?: boolean }>
    prompts: Array<{ terminalId: string; prompt: string }>
    killed: string[]
    retired: Array<{ sessionId: string; terminalId: string }>
    attention: Array<{ sessionId: string; terminalId?: string; reason: string }>
  }
  emitEnd: (end: RunEnd) => void
  alive: Set<string>
  failSpawn: boolean
  failEnsure: boolean
  failSendPrompt: boolean
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
    failSendPrompt: false,
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
      return !fake.failSendPrompt
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

  it("an empty-string model on update CLEARS the override (the edit-form round trip)", () => {
    const svc = new SchedulerService(makeFakeDeps(), { dir })
    const s = svc.create(baseInput({ model: "sonnet", effort: "high", cwd: "C:/repo" }))
    expect(svc.get(s.id)!.model).toBe("sonnet")
    const out = svc.update(s.id, { model: "", effort: "", cwd: "" })!
    expect(out.model).toBeUndefined()
    expect(out.effort).toBeUndefined()
    expect(out.cwd).toBeUndefined()
    // Cleared on disk too (undefined keys are dropped from the JSON).
    const onDisk = JSON.parse(readFileSync(join(dir, `${s.id}.json`), "utf-8"))
    expect("model" in onDisk.data).toBe(false)
    expect("effort" in onDisk.data).toBe(false)
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

  it("threads cwd + workspaceId through to spawnRun (the wiring resolves the folder chain)", () => {
    // The ipc.ts wiring resolves: explicit cwd → the SCHEDULE's workspace folder
    // (via resolveWorkspaceDir(workspaceId)) → home. The service's job is to hand
    // it BOTH values off the schedule — never the active selection.
    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir })
    const s = svc.create(baseInput({ cwd: "C:/repo", workspaceId: "ws-9" }))
    svc.runNow(s.id)
    expect(deps.calls.spawned[0]).toMatchObject({ cwd: "C:/repo", workspaceId: "ws-9" })
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

  it("a failed prompt delivery kills the spawned terminal — no 30-minute zombie", () => {
    const deps = makeFakeDeps()
    deps.failSendPrompt = true
    const svc = new SchedulerService(deps, { dir, now: () => 1000 })
    const s = svc.create(baseInput())
    expect(svc.runNow(s.id)).toBe(true)
    const tid = deps.lastTerminalId()!
    // The terminal that will never do anything is killed, the run recorded as
    // error, attention raised, and nextRunAt advanced.
    expect(deps.calls.killed).toContain(tid)
    const rec = svc.get(s.id)!.runHistory[0]
    expect(rec).toMatchObject({ status: "error", terminalId: tid })
    expect(rec.note).toContain("deliver")
    expect(deps.calls.attention).toHaveLength(1)
    expect(svc.get(s.id)!.nextRunAt).toBe(new Date(1000 + 60_000).toISOString())
    // NOT tracked in activeRuns: a subsequent runNow is not overlap-skipped.
    deps.failSendPrompt = false
    expect(svc.runNow(s.id)).toBe(true)
    expect(deps.calls.spawned).toHaveLength(2)
  })

  it("a THROWING spawnRun is contained: error record, nextRunAt advanced, attention — never a hot-loop", () => {
    // The production deps THROW (saveVersioned→writeFileSync on ENOSPC/EACCES;
    // createHeadless can throw) — the graceful-undefined branches alone are not
    // enough. A throw escaping fire() would leave nextRunAt un-advanced (the same
    // schedule re-throws every 30s forever) and abort the tick loop.
    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir, now: () => 1000 })
    const s = svc.create(baseInput())
    deps.spawnRun = () => {
      throw new Error("ENOSPC: no space left on device")
    }
    expect(() => svc.runNow(s.id)).not.toThrow()
    const rec = svc.get(s.id)!.runHistory[0]
    expect(rec.status).toBe("error")
    expect(rec.note).toContain("ENOSPC")
    expect(svc.get(s.id)!.nextRunAt).toBe(new Date(1000 + 60_000).toISOString())
    expect(deps.calls.attention).toHaveLength(1)
  })

  it("a THROWING ensureSession is contained the same way", () => {
    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir, now: () => 1000 })
    const s = svc.create(baseInput())
    deps.ensureSession = () => {
      throw new Error("EACCES: permission denied")
    }
    expect(() => svc.runNow(s.id)).not.toThrow()
    expect(svc.get(s.id)!.runHistory[0].status).toBe("error")
    expect(svc.get(s.id)!.nextRunAt).toBe(new Date(1000 + 60_000).toISOString())
  })

  it("a throw AFTER the run is registered untracks it and kills our own terminal (no ghost)", () => {
    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir, now: () => 1000 })
    const s = svc.create(baseInput())
    // Sabotage the FINAL persist of fire() (after activeRuns.set): plant a
    // directory where saveVersioned writes its `<id>.json.tmp`.
    mkdirSync(join(dir, `${s.id}.json.tmp`))
    expect(() => svc.runNow(s.id)).not.toThrow()
    const tid = deps.lastTerminalId()!
    // Cleaned up: our own spawned terminal killed, run untracked (a subsequent
    // runNow is NOT overlap-skipped), error recorded in-memory.
    expect(deps.calls.killed).toContain(tid)
    expect(svc.get(s.id)!.runHistory[0].status).toBe("error")
    rmSync(join(dir, `${s.id}.json.tmp`), { recursive: true, force: true })
    expect(svc.runNow(s.id)).toBe(true)
    expect(deps.calls.spawned).toHaveLength(2)
  })

  it("tick() is per-schedule throw-safe: one bad schedule cannot starve the others", () => {
    let t = 1000
    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir, now: () => t })
    const a = svc.create(baseInput({ name: "a" }))
    svc.runNow(a.id) // a now has a live run → its next tick path probes isTerminalAlive
    const b = svc.create(baseInput({ name: "b" }))
    // Poison a's overlap-guard probe. b's guard never probes a's run entries
    // (scheduleId filter), so only a's handling throws.
    deps.isTerminalAlive = () => {
      throw new Error("probe boom")
    }
    t = 61_000 // both due
    expect(() => svc.tick()).not.toThrow()
    // b still fired despite a's throwing probe.
    expect(deps.calls.spawned.filter((sp) => sp.name === "b")).toHaveLength(1)
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

  it("catchUp:true leaves the schedule DUE so the capped tick fires EXACTLY ONE catch-up run", () => {
    const { id } = seedMissedSchedule(true)
    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir, now: () => 5_000_000 })
    svc.start()
    svc.stop()
    // start() spawns NOTHING synchronously (boot safety: no fire before the IPC
    // handlers register, no bypass of the concurrency cap).
    expect(deps.calls.spawned).toHaveLength(0)
    // The overdue schedule was left DUE — the normal tick drains it.
    svc.tick()
    expect(deps.calls.spawned).toHaveLength(1)
    expect(svc.get(id)!.sessionId).toBe(`sess-${id}`)
    // EXACTLY one: fire() advanced nextRunAt from the fire time, so the next tick
    // is quiet (and the live run would overlap-guard it regardless).
    svc.tick()
    expect(deps.calls.spawned).toHaveLength(1)
  })

  it("multiple missed catchUp schedules DRAIN through the concurrency cap (no boot thundering-herd)", () => {
    // Three overdue catchUp schedules persisted from an earlier "session".
    const early = new SchedulerService(makeFakeDeps(), { dir, now: () => 1000 })
    const ids = ["a", "b", "c"].map((n) => early.create(baseInput({ name: n, catchUp: true })).id)

    const deps = makeFakeDeps()
    const svc = new SchedulerService(deps, { dir, now: () => 5_000_000, maxConcurrent: 2 })
    svc.start()
    svc.stop()
    expect(deps.calls.spawned).toHaveLength(0) // nothing synchronously at boot
    svc.tick()
    expect(deps.calls.spawned).toHaveLength(2) // capped at maxConcurrent
    // Finish both in-flight runs; the next tick drains the third (it stayed due).
    for (const tid of [...deps.alive]) deps.emitEnd({ terminalId: tid, kind: "result" })
    svc.tick()
    expect(deps.calls.spawned).toHaveLength(3)
    // Exactly-one-catch-up preserved: each schedule fired once.
    for (const id of ids) {
      expect(deps.calls.spawned.filter((sp) => sp.scheduleId === id)).toHaveLength(1)
      expect(new Date(svc.get(id)!.nextRunAt!).getTime()).toBeGreaterThan(5_000_000)
    }
  })

  it("catch-up is per-schedule throw-safe: one schedule's failing persist can't starve the rest", () => {
    // Two overdue catchUp:false schedules. Timestamps order their ids (and thus
    // the load/Map order): A (ts 1000) is processed BEFORE B (ts 2000), so a
    // non-throw-safe loop would abort on A and never reach B.
    const earlyA = new SchedulerService(makeFakeDeps(), { dir, now: () => 1000 })
    const idA = earlyA.create(baseInput({ name: "a" })).id
    const earlyB = new SchedulerService(makeFakeDeps(), { dir, now: () => 2000 })
    const idB = earlyB.create(baseInput({ name: "b" })).id

    // Sabotage A's persist: saveVersioned writes `<id>.json.tmp` first — plant a
    // DIRECTORY at that path so the write throws (deterministic, fs-level, exactly
    // the ENOSPC/EACCES class the production deps can hit).
    mkdirSync(join(dir, `${idA}.json.tmp`))

    const svc = new SchedulerService(makeFakeDeps(), { dir, now: () => 5_000_000 })
    expect(() => svc.start()).not.toThrow()
    svc.stop()
    // B was still processed despite A's throw.
    expect(svc.get(idB)!.runHistory[0]?.status).toBe("skipped-missed")
    // A's in-memory record was written before the persist throw (best-effort).
    expect(svc.get(idA)!.runHistory[0]?.status).toBe("skipped-missed")
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
