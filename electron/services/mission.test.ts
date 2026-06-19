import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { MissionService, detectUsageLimit, type SessionDriver, type WorktreeLike } from "./mission"
import type { MergeResult } from "./worktree"
import { TerminalService, type ProcLike, type SpawnProc } from "./terminals"

/**
 * A REAL TerminalService wired with a no-op headless spawn seam (no child
 * process) and the structured engine on — so MissionService.dispatch spawns an
 * actual HEADLESS worker through create()→createHeadless. Used to prove the
 * BO-4a getActivity() inclusion end-to-end: the reaper reads the REAL
 * getActivity(), which now surfaces structured terminals.
 */
function makeStructuredDriver(): TerminalService {
  const spawnProc: SpawnProc = () => {
    const noop = () => {}
    const proc: ProcLike = { pid: 4321, onStdout: noop, onStderr: noop, onExit: noop, write: noop, kill: noop }
    return proc
  }
  const svc = new TerminalService({ spawnProc })
  svc.setEngine("structured")
  return svc
}

function fakeDriver(overrides: Partial<SessionDriver> = {}): SessionDriver {
  return {
    create: (name, cwd) => ({
      id: `s-${Math.random().toString(36).slice(2, 6)}`,
      name: name ?? "s",
      cwd: cwd ?? ".",
      state: "active",
    }),
    write: () => {},
    waitForIdle: async () => ({ idle: true, timedOut: false }),
    getActivity: () => [],
    getOutput: () => "",
    kill: () => true,
    ...overrides,
  }
}

/**
 * A scriptable FAKE WorktreeService — no real git. It records every call so a
 * test can assert the lifecycle, and lets each method's result be overridden so
 * we can drive the clean-merge path AND the conflict path deterministically. Real
 * git behavior is covered separately in worktree.test.ts; here we only verify how
 * MissionService DRIVES the worktree seam.
 */
interface FakeWorktree extends WorktreeLike {
  calls: Array<{ op: string; args: unknown }>
  /** Override merge's result for the next/all calls (default clean ok). */
  mergeResult: MergeResult
  /** Override isGitRepo (default true — most isolated tests run "in a repo"). */
  gitRepo: boolean
}

function makeFakeWorktree(overrides: Partial<WorktreeLike> = {}): FakeWorktree {
  const wt: FakeWorktree = {
    calls: [],
    mergeResult: { ok: true },
    gitRepo: true,
    isGitRepo(cwd) {
      this.calls.push({ op: "isGitRepo", args: { cwd } })
      return this.gitRepo
    },
    headSha(cwd) {
      this.calls.push({ op: "headSha", args: { cwd } })
      return "base000sha"
    },
    create(args) {
      this.calls.push({ op: "create", args })
      return { path: args.path, branch: args.branch }
    },
    commitAll(worktreePath, message) {
      this.calls.push({ op: "commitAll", args: { worktreePath, message } })
      return { ok: true }
    },
    diff(worktreePath, base) {
      this.calls.push({ op: "diff", args: { worktreePath, base } })
      return `--- diff for ${worktreePath} vs ${base} ---`
    },
    merge(args) {
      this.calls.push({ op: "merge", args })
      return this.mergeResult
    },
    remove(args) {
      this.calls.push({ op: "remove", args })
      return { ok: true }
    },
    reapOrphans(repoCwd, keepBranches) {
      this.calls.push({ op: "reapOrphans", args: { repoCwd, keepBranches } })
      return { removed: [] }
    },
    ...overrides,
  }
  return wt
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mission-test-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("MissionService create/get/list", () => {
  it("creates a planning mission and persists it", () => {
    const svc = new MissionService(fakeDriver(), { dir })
    const m = svc.create("build itself", "/repo")
    expect(m.goal).toBe("build itself")
    expect(m.cwd).toBe("/repo")
    expect(m.status).toBe("planning")
    expect(m.autonomy).toBe("hands-off")
    expect(m.tasks).toEqual([])
    // reloads from disk in a fresh instance
    const svc2 = new MissionService(fakeDriver(), { dir })
    expect(svc2.get(m.id)?.goal).toBe("build itself")
    // persisted in the versioned envelope
    const onDisk = JSON.parse(readFileSync(join(dir, `${m.id}.json`), "utf-8"))
    expect(onDisk.schemaVersion).toBe(1)
    expect(onDisk.data.goal).toBe("build itself")
  })

  it("loads a LEGACY (pre-versioning, envelope-less) mission file and rewrites it as v1", () => {
    // Simulate a user's existing on-disk mission written before schema
    // versioning: raw Mission JSON with no { schemaVersion, data } envelope.
    const legacy = {
      id: "legacy-mission",
      goal: "ship the thing",
      cwd: "/repo",
      autonomy: "hands-off",
      status: "running",
      tasks: [],
      workers: [],
      eventLog: [],
      createdAt: 1000,
      updatedAt: 1000,
    }
    const file = join(dir, "legacy-mission.json")
    writeFileSync(file, JSON.stringify(legacy, null, 2))

    // loadAll() runs in the constructor — backward compat: the legacy file loads
    const svc = new MissionService(fakeDriver(), { dir, now: () => 2000 })
    expect(svc.get("legacy-mission")?.goal).toBe("ship the thing")
    // read-repair: file rewritten in the v1 envelope on load
    const onDisk = JSON.parse(readFileSync(file, "utf-8"))
    expect(onDisk.schemaVersion).toBe(1)
    expect(onDisk.data.id).toBe("legacy-mission")
  })

  it("defaults autonomy and respects an override", () => {
    const svc = new MissionService(fakeDriver(), { dir })
    expect(svc.create("g", "/r", "checkpoints").autonomy).toBe("checkpoints")
  })

  it("status() with no id returns most-recently-updated non-terminal mission", () => {
    const svc = new MissionService(fakeDriver(), { dir, now: () => 1000 })
    const a = svc.create("a", "/r")
    const svc2 = new MissionService(fakeDriver(), { dir, now: () => 2000 })
    const b = svc2.create("b", "/r")
    expect(svc2.status()?.id).toBe(b.id)
    svc2.finish(b.id)
    expect(svc2.status()?.id).toBe(a.id) // b terminal, falls back to a
  })
})

describe("MissionService plan", () => {
  it("adds tasks and flips planning -> running", () => {
    const svc = new MissionService(fakeDriver(), { dir })
    const m = svc.create("g", "/r")
    const out = svc.plan(m.id, [{ title: "t1" }, { title: "t2", detail: "d" }])!
    expect(out.status).toBe("running")
    expect(out.tasks.map((t) => t.title)).toEqual(["t1", "t2"])
    expect(out.tasks.every((t) => t.status === "pending" && t.attempts === 0)).toBe(true)
    expect(out.tasks[1].detail).toBe("d")
  })
  it("returns undefined for unknown mission", () => {
    const svc = new MissionService(fakeDriver(), { dir })
    expect(svc.plan("nope", [{ title: "x" }])).toBeUndefined()
  })
})

describe("MissionService dispatch/await", () => {
  it("dispatch creates a worker, injects prompt, marks in-progress", () => {
    const writes: Array<{ id: string; data: string }> = []
    const svc = new MissionService(
      fakeDriver({
        create: () => ({ id: "w1", name: "w", cwd: "/r", state: "active" }),
        write: (id, data) => writes.push({ id, data }),
      }),
      { dir, enterDelayMs: 0, seedDelayMs: 0, now: () => 1000 },
    )
    const m = svc.create("g", "/r")
    svc.plan(m.id, [{ title: "do thing" }])
    const taskId = svc.get(m.id)!.tasks[0].id
    const res = svc.dispatch(m.id, taskId, "please do thing")!
    expect(res.sessionId).toBe("w1")
    const task = svc.get(m.id)!.tasks[0]
    expect(task.status).toBe("in-progress")
    expect(task.assignedTo).toBe("w1")
    expect(task.attempts).toBe(1)
    expect(task.dispatchedAt).toBe(1000) // now + seedDelayMs(0)
    expect(svc.get(m.id)!.workers).toContainEqual({ sessionId: "w1", currentTaskId: taskId, startedAt: 1000 })
    // Prompt text and Enter are sent as separate writes so the TUI submits it.
    expect(writes).toEqual([{ id: "w1", data: "please do thing" }, { id: "w1", data: "\r" }])
  })

  it("await passes the task's dispatchedAt as the idle floor (boot race)", async () => {
    let seenNotBefore: number | undefined = -1
    const svc = new MissionService(
      fakeDriver({
        create: () => ({ id: "w1", name: "w", cwd: "/r", state: "active" }),
        waitForIdle: async (_id, opts) => { seenNotBefore = opts.notBefore; return { idle: true, timedOut: false } },
        getOutput: () => "done",
      }),
      { dir, seedDelayMs: 5000, now: () => 1000 },
    )
    const m = svc.create("g", "/r")
    svc.plan(m.id, [{ title: "t" }])
    const taskId = svc.get(m.id)!.tasks[0].id
    svc.dispatch(m.id, taskId, "go")
    await svc.await(m.id, taskId)
    // notBefore must be the prompt-land time (now + seedDelayMs), so a worker
    // still showing its pre-prompt welcome screen isn't read as finished.
    expect(seenNotBefore).toBe(6000)
  })

  it("dispatch is idempotent for an in-progress task (no orphaned worker)", () => {
    let creates = 0
    const svc = new MissionService(
      fakeDriver({ create: () => { creates++; return { id: `w${creates}`, name: "w", cwd: "/r", state: "active" } } }),
      { dir, seedDelayMs: 0 },
    )
    const m = svc.create("g", "/r")
    svc.plan(m.id, [{ title: "t" }])
    const taskId = svc.get(m.id)!.tasks[0].id
    const first = svc.dispatch(m.id, taskId, "go")!
    const second = svc.dispatch(m.id, taskId, "go")!
    expect(second.sessionId).toBe(first.sessionId)
    expect(creates).toBe(1)
    expect(svc.get(m.id)!.workers.length).toBe(1)
    expect(svc.get(m.id)!.tasks[0].attempts).toBe(1)
  })

  it("await returns worker output once idle", async () => {
    const svc = new MissionService(
      fakeDriver({
        create: () => ({ id: "w1", name: "w", cwd: "/r", state: "active" }),
        waitForIdle: async () => ({ idle: true, timedOut: false }),
        getOutput: () => "worker result text",
      }),
      { dir },
    )
    const m = svc.create("g", "/r")
    svc.plan(m.id, [{ title: "t" }])
    const taskId = svc.get(m.id)!.tasks[0].id
    svc.dispatch(m.id, taskId, "go")
    const out = await svc.await(m.id, taskId)
    expect(out).toEqual({ idle: true, timedOut: false, output: "worker result text" })
    expect(svc.get(m.id)!.tasks[0].status).toBe("review")
  })
})

describe("MissionService resolve/stop", () => {
  it("resolve done records result and frees the worker", () => {
    const killed: string[] = []
    const svc = new MissionService(
      fakeDriver({ create: () => ({ id: "w1", name: "w", cwd: "/r", state: "active" }), kill: (id) => { killed.push(id); return true } }),
      { dir },
    )
    const m = svc.create("g", "/r")
    svc.plan(m.id, [{ title: "t" }])
    const taskId = svc.get(m.id)!.tasks[0].id
    svc.dispatch(m.id, taskId, "go")
    const out = svc.resolve(m.id, taskId, "done", "looks good")!
    const task = out.tasks[0]
    expect(task.status).toBe("done")
    expect(task.result).toBe("looks good")
    expect(out.workers.find((w) => w.sessionId === "w1")?.currentTaskId).toBeUndefined()
  })

  it("logEvent appends to the audit trail", () => {
    const svc = new MissionService(fakeDriver(), { dir })
    const m = svc.create("g", "/r")
    const before = svc.get(m.id)!.eventLog.length
    svc.logEvent(m.id, "info", "hello")
    const ev = svc.get(m.id)!.eventLog
    expect(ev.length).toBe(before + 1)
    expect(ev[ev.length - 1]).toMatchObject({ kind: "info", text: "hello" })
  })

  it("stop kills workers + conductor and marks stopped", () => {
    const killed: string[] = []
    const svc = new MissionService(fakeDriver({ kill: (id) => { killed.push(id); return true } }), { dir })
    const m = svc.create("g", "/r")
    m.workers.push({ sessionId: "w1" })
    m.conductorSessionId = "c1"
    const out = svc.stop(m.id)!
    expect(out.status).toBe("stopped")
    expect(killed.sort()).toEqual(["c1", "w1"])
  })
})

describe("MissionService supervisor — conductor", () => {
  it("spawns a conductor for a running mission that has none", () => {
    const created: Array<{ name?: string; cwd?: string }> = []
    const writes: Array<{ id: string; data: string }> = []
    const svc = new MissionService(
      fakeDriver({
        create: (name, cwd) => { created.push({ name, cwd }); return { id: "c1", name: name ?? "", cwd: cwd ?? "", state: "active" } },
        write: (id, data) => writes.push({ id, data }),
        getActivity: () => [{ id: "c1", name: "c", state: "active", idleMs: 0 }],
      }),
      { dir, seedDelayMs: 0 },
    )
    const m = svc.create("g", "/r")
    svc.plan(m.id, [{ title: "t" }])
    svc.tick()
    expect(svc.get(m.id)!.conductorSessionId).toBe("c1")
    expect(created.length).toBe(1)
  })

  it("spawns a conductor for a planning mission so it can decompose the goal", () => {
    const created: Array<{ name?: string; cwd?: string }> = []
    const svc = new MissionService(
      fakeDriver({
        create: (name, cwd) => { created.push({ name, cwd }); return { id: "c1", name: name ?? "", cwd: cwd ?? "", state: "active" } },
        getActivity: () => [{ id: "c1", name: "c", state: "active", idleMs: 0 }],
      }),
      { dir, seedDelayMs: 0 },
    )
    const m = svc.create("g", "/r") // status "planning", no plan() call
    svc.tick()
    expect(svc.get(m.id)!.conductorSessionId).toBe("c1")
    expect(created.length).toBe(1)
  })

  it("respawns the conductor if its session has died", () => {
    let nextId = 1
    const svc = new MissionService(
      fakeDriver({
        create: () => ({ id: `c${nextId++}`, name: "c", cwd: "/r", state: "active" }),
        getActivity: () => [], // no live sessions -> conductor considered dead
      }),
      { dir, seedDelayMs: 0 },
    )
    const m = svc.create("g", "/r")
    svc.plan(m.id, [{ title: "t" }])
    svc.tick() // spawns c1
    const first = svc.get(m.id)!.conductorSessionId
    svc.tick() // c1 absent from activity -> respawn c2
    const second = svc.get(m.id)!.conductorSessionId
    expect(first).toBe("c1")
    expect(second).toBe("c2")
  })

  it("does not spawn a conductor for paused/done/stopped missions", () => {
    let count = 0
    const svc = new MissionService(fakeDriver({ create: () => { count++; return { id: `c${count}`, name: "c", cwd: "/r", state: "active" } } }), { dir, seedDelayMs: 0 })
    const m = svc.create("g", "/r")
    svc.plan(m.id, [{ title: "t" }])
    svc.finish(m.id)
    svc.tick()
    expect(count).toBe(0)
  })
})

describe("MissionService supervisor — stalled workers", () => {
  it("kills a worker idle beyond the threshold and frees its task", () => {
    const killed: string[] = []
    let t = 0
    const svc = new MissionService(
      fakeDriver({
        create: () => ({ id: "w1", name: "w", cwd: "/r", state: "active" }),
        getActivity: () => [
          { id: "c1", name: "c", state: "active", idleMs: 0 },
          { id: "w1", name: "w", state: "idle", idleMs: 11 * 60_000 }, // 11 min idle
        ],
        kill: (id) => { killed.push(id); return true },
      }),
      { dir, seedDelayMs: 0, workerStallMs: 10 * 60_000, now: () => t },
    )
    const m = svc.create("g", "/r")
    svc.plan(m.id, [{ title: "t" }])
    const taskId = svc.get(m.id)!.tasks[0].id
    svc.dispatch(m.id, taskId, "go")            // assigns w1 at t=0, status in-progress
    svc.get(m.id)!.conductorSessionId = "c1"    // pretend conductor exists
    t = 11 * 60_000                             // worker now old enough to clear boot grace
    svc.tick()
    expect(killed).toContain("w1")
    const task = svc.get(m.id)!.tasks[0]
    expect(task.status).toBe("pending")
    expect(task.assignedTo).toBeUndefined()
    expect(svc.get(m.id)!.workers.some((w) => w.sessionId === "w1")).toBe(false)
  })

  it("does not reap a just-spawned worker still within the boot grace", () => {
    const killed: string[] = []
    let t = 0
    const svc = new MissionService(
      fakeDriver({
        create: () => ({ id: "w1", name: "w", cwd: "/r", state: "active" }),
        // Worker hasn't appeared in activity yet (just spawned) — the old
        // "absent => stalled" rule would have killed it immediately.
        getActivity: () => [{ id: "c1", name: "c", state: "active", idleMs: 0 }],
        kill: (id) => { killed.push(id); return true },
      }),
      { dir, seedDelayMs: 0, workerStallMs: 10 * 60_000, now: () => t },
    )
    const m = svc.create("g", "/r")
    svc.plan(m.id, [{ title: "t" }])
    const taskId = svc.get(m.id)!.tasks[0].id
    svc.dispatch(m.id, taskId, "go")
    svc.get(m.id)!.conductorSessionId = "c1"
    t = 5000 // 5s later — within the 15s boot grace
    svc.tick()
    expect(killed).not.toContain("w1")
    expect(svc.get(m.id)!.tasks[0].status).toBe("in-progress")
  })

  it("does NOT reap a healthy HEADLESS worker — getActivity() now includes structured terminals (BO-4a)", () => {
    let t = 0
    const driver = makeStructuredDriver()
    // A live headless conductor so ensureConductor() doesn't churn during tick().
    const conductor = driver.createHeadless("c", "/r")
    const svc = new MissionService(driver, { dir, seedDelayMs: 0, workerStallMs: 10 * 60_000, now: () => t })
    const m = svc.create("g", "/r")
    svc.get(m.id)!.conductorSessionId = conductor.id
    svc.plan(m.id, [{ title: "t" }])
    const taskId = svc.get(m.id)!.tasks[0].id
    svc.dispatch(m.id, taskId, "go") // spawns a REAL headless worker via create()→createHeadless
    const workerId = svc.get(m.id)!.workers[0].sessionId

    // The inclusion the reaper depends on: the structured worker IS in getActivity.
    expect(driver.isHeadless(workerId)).toBe(true)
    expect(driver.getActivity().some((a) => a.id === workerId)).toBe(true)

    // Advance PAST the boot grace. Pre-BO-4a the headless worker was ABSENT from
    // getActivity(), so the "absent => stalled" rule reaped it here; now it's
    // present + freshly active, so it survives and keeps its task.
    t = 11 * 60_000
    svc.tick()
    expect(svc.get(m.id)!.tasks[0].status).toBe("in-progress")
    expect(svc.get(m.id)!.workers.some((w) => w.sessionId === workerId)).toBe(true)
  })
})

describe("detectUsageLimit", () => {
  it("flags usage-limit messages", () => {
    expect(detectUsageLimit("Claude usage limit reached. Try again later.").limited).toBe(true)
    expect(detectUsageLimit("5-hour limit reached").limited).toBe(true)
    expect(detectUsageLimit("normal output").limited).toBe(false)
  })

  it("does not false-positive on the Conductor seed prompt echo", () => {
    // The seed instructs the Conductor about pausing; that echoed text must not
    // be mistaken for an actual limit (this used to pause missions instantly).
    const seedEcho =
      "If the model becomes unavailable and you cannot continue, call mission_pause. " +
      "Drive the mission and mind the usage."
    expect(detectUsageLimit(seedEcho).limited).toBe(false)
  })
})

describe("MissionService pause/resume", () => {
  it("pause sets status + resumeAt; resume clears it", () => {
    const svc = new MissionService(fakeDriver(), { dir, now: () => 1000 })
    const m = svc.create("g", "/r")
    svc.plan(m.id, [{ title: "t" }])
    svc.pause(m.id, 5000)
    expect(svc.get(m.id)!.status).toBe("paused")
    expect(svc.get(m.id)!.resumeAt).toBe(5000)
    svc.resume(m.id)
    expect(svc.get(m.id)!.status).toBe("running")
    expect(svc.get(m.id)!.resumeAt).toBeUndefined()
  })

  it("tick auto-resumes a paused mission once resumeAt passes", () => {
    let t = 1000
    const svc = new MissionService(fakeDriver({ getActivity: () => [] }), { dir, now: () => t, seedDelayMs: 0 })
    const m = svc.create("g", "/r")
    svc.plan(m.id, [{ title: "x" }])
    svc.pause(m.id, 4000)
    t = 3000; svc.tick()
    expect(svc.get(m.id)!.status).toBe("paused")
    t = 4001; svc.tick()
    expect(svc.get(m.id)!.status).toBe("running")
  })

  it("tick pauses a running mission when a session hits a usage limit", () => {
    let t = 1000
    const svc = new MissionService(
      fakeDriver({
        getActivity: () => [{ id: "c1", name: "c", state: "idle", idleMs: 0 }],
        getOutput: () => "Claude usage limit reached",
      }),
      { dir, now: () => t, seedDelayMs: 0, usageBackoffMs: 60_000 },
    )
    const m = svc.create("g", "/r")
    svc.plan(m.id, [{ title: "x" }])
    svc.get(m.id)!.conductorSessionId = "c1"
    svc.tick()
    expect(svc.get(m.id)!.status).toBe("paused")
    expect(svc.get(m.id)!.resumeAt).toBe(1000 + 60_000)
  })
})

describe("MissionService event seam", () => {
  /** Collect every emitted event for assertions. */
  function recorder(svc: MissionService) {
    const events: Array<{ type: string; id: string; status?: string }> = []
    const off = svc.onEvent((e) => {
      if (e.type === "updated") events.push({ type: "updated", id: e.mission.id, status: e.mission.status })
      else events.push({ type: "removed", id: e.id })
    })
    return { events, off }
  }

  it("emits exactly one 'updated' per persist-routed mutation, carrying the full mission", () => {
    const svc = new MissionService(fakeDriver(), { dir, seedDelayMs: 0, enterDelayMs: 0 })
    const m = svc.create("g", "/r") // create persists, but subscribe AFTER to count cleanly
    const { events } = recorder(svc)

    svc.plan(m.id, [{ title: "a" }, { title: "b" }])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "updated", id: m.id, status: "running" })
    // Snapshot is the full Mission (tasks ride along).
    let captured: any
    svc.onEvent((e) => { if (e.type === "updated") captured = e.mission })
    svc.logEvent(m.id, "info", "x")
    expect(captured.tasks).toHaveLength(2)
    expect(Array.isArray(captured.eventLog)).toBe(true)
  })

  it("fires once for create", () => {
    const events: string[] = []
    const svc = new MissionService(fakeDriver(), { dir, seedDelayMs: 0 })
    svc.onEvent((e) => events.push(e.type))
    svc.create("g", "/r")
    expect(events).toEqual(["updated"])
  })

  it("emits once each for plan / dispatch / resolve / pause / resume / stop", () => {
    const svc = new MissionService(fakeDriver(), { dir, seedDelayMs: 0, enterDelayMs: 0 })
    const m = svc.create("g", "/r")
    const { events } = recorder(svc)

    svc.plan(m.id, [{ title: "a" }])
    const taskId = svc.get(m.id)!.tasks[0].id
    svc.dispatch(m.id, taskId, "do it")
    svc.resolve(m.id, taskId, "failed", "nope") // failed → mission blocked, single persist
    svc.pause(m.id, 9999)
    svc.resume(m.id)
    svc.stop(m.id)

    // One emission per mutation — no double-fire from nested persists.
    expect(events.filter((e) => e.type === "updated")).toHaveLength(6)
    expect(events.map((e) => e.status)).toEqual([
      "running",  // plan
      "running",  // dispatch
      "blocked",  // resolve (sole task failed)
      "paused",   // pause
      "running",  // resume
      "stopped",  // stop
    ])
  })

  it("await emits only when the worker goes idle (persist gated on idle)", async () => {
    const idle = new MissionService(fakeDriver(), { dir, seedDelayMs: 0, enterDelayMs: 0 })
    const m = idle.create("g", "/r")
    idle.plan(m.id, [{ title: "a" }])
    const taskId = idle.get(m.id)!.tasks[0].id
    idle.dispatch(m.id, taskId, "p")
    const { events } = recorder(idle)
    await idle.await(m.id, taskId)
    expect(events).toHaveLength(1) // task → review persisted once
    expect(events[0]).toMatchObject({ type: "updated", status: "running" })

    const busy = new MissionService(
      fakeDriver({ waitForIdle: async () => ({ idle: false, timedOut: true }) }),
      { dir, seedDelayMs: 0, enterDelayMs: 0 },
    )
    const m2 = busy.create("g", "/r")
    busy.plan(m2.id, [{ title: "a" }])
    const t2 = busy.get(m2.id)!.tasks[0].id
    busy.dispatch(m2.id, t2, "p")
    const r2 = recorder(busy)
    await busy.await(m2.id, t2)
    expect(r2.events).toHaveLength(0) // not idle → no persist → no emission
  })

  it("unsubscribe stops delivery", () => {
    const svc = new MissionService(fakeDriver(), { dir, seedDelayMs: 0 })
    const m = svc.create("g", "/r")
    const { events, off } = recorder(svc)
    svc.logEvent(m.id, "info", "one")
    off()
    svc.logEvent(m.id, "info", "two")
    expect(events).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// WW-2 — worktree-isolated workers + diff-review merge gate
// All tests use the scriptable FAKE WorktreeService (no real git). The whole
// feature is opt-in: every non-isolated assertion is a REGRESSION guard proving
// the default flow is untouched.
// ---------------------------------------------------------------------------

describe("MissionService WW-2 — non-isolated regression (default path untouched)", () => {
  it("a non-isolated mission NEVER touches the worktree seam", () => {
    const wt = makeFakeWorktree()
    const svc = new MissionService(
      fakeDriver({ create: () => ({ id: "w1", name: "w", cwd: "/r", state: "active" }) }),
      { dir, worktree: wt, seedDelayMs: 0, enterDelayMs: 0 },
    )
    const m = svc.create("g", "/r") // isolateWorkers defaults to false
    expect(svc.get(m.id)!.isolateWorkers).toBeUndefined()
    svc.plan(m.id, [{ title: "t" }])
    const taskId = svc.get(m.id)!.tasks[0].id
    svc.dispatch(m.id, taskId, "go")
    svc.resolve(m.id, taskId, "done", "ok")
    svc.stop(m.id)
    // Not a single worktree op happened.
    expect(wt.calls).toEqual([])
  })

  it("non-isolated resolve-done marks done + completes the mission exactly as before", () => {
    const wt = makeFakeWorktree()
    const svc = new MissionService(
      fakeDriver({ create: () => ({ id: "w1", name: "w", cwd: "/r", state: "active" }) }),
      { dir, worktree: wt, seedDelayMs: 0 },
    )
    const m = svc.create("g", "/r")
    svc.plan(m.id, [{ title: "t" }])
    const taskId = svc.get(m.id)!.tasks[0].id
    svc.dispatch(m.id, taskId, "go")
    const out = svc.resolve(m.id, taskId, "done", "looks good")!
    expect(out.tasks[0].status).toBe("done")
    expect(out.status).toBe("done") // sole task done → mission complete
    expect(wt.calls).toEqual([])
  })

  it("dispatch spawns the worker in the SHARED mission cwd (not a worktree)", () => {
    const wt = makeFakeWorktree()
    let spawnedCwd: string | undefined
    const svc = new MissionService(
      fakeDriver({ create: (_n, cwd) => { spawnedCwd = cwd; return { id: "w1", name: "w", cwd: cwd ?? "", state: "active" } } }),
      { dir, worktree: wt, seedDelayMs: 0 },
    )
    const m = svc.create("g", "/repo")
    svc.plan(m.id, [{ title: "t" }])
    const taskId = svc.get(m.id)!.tasks[0].id
    svc.dispatch(m.id, taskId, "go")
    expect(spawnedCwd).toBe("/repo")
  })
})

describe("MissionService WW-2 — create/plan isolation flag + git refusal", () => {
  it("create with isolate_workers=true on a git repo sets the flag", () => {
    const wt = makeFakeWorktree({ isGitRepo: () => true })
    const svc = new MissionService(fakeDriver(), { dir, worktree: wt })
    const m = svc.create("g", "/repo", "hands-off", true)
    expect(m.isolateWorkers).toBe(true)
  })

  it("create with isolate on a NON-git cwd is refused (throws, no silent downgrade)", () => {
    const wt = makeFakeWorktree({ isGitRepo: () => false })
    const svc = new MissionService(fakeDriver(), { dir, worktree: wt })
    expect(() => svc.create("g", "/not-a-repo", "hands-off", true)).toThrow(/not a git repository/i)
  })

  it("plan can enable isolation; refuses on a non-git cwd", () => {
    const wt = makeFakeWorktree()
    const svc = new MissionService(fakeDriver(), { dir, worktree: wt })
    const m = svc.create("g", "/repo")
    wt.gitRepo = true
    expect(svc.plan(m.id, [{ title: "t" }], true)!.isolateWorkers).toBe(true)
    const m2 = svc.create("g2", "/repo")
    wt.gitRepo = false
    expect(() => svc.plan(m2.id, [{ title: "t" }], true)).toThrow(/not a git repository/i)
  })
})

describe("MissionService WW-2 — isolated dispatch creates a worktree + spawns into it", () => {
  it("dispatch creates a worktree, stores its path/branch/baseRef, spawns the worker there", () => {
    const wt = makeFakeWorktree()
    let spawnedCwd: string | undefined
    const svc = new MissionService(
      fakeDriver({ create: (_n, cwd) => { spawnedCwd = cwd; return { id: "w1", name: "w", cwd: cwd ?? "", state: "active" } } }),
      { dir, worktree: wt, seedDelayMs: 0 },
    )
    const m = svc.create("g", "/repo", "hands-off", true)
    svc.plan(m.id, [{ title: "do thing" }])
    const taskId = svc.get(m.id)!.tasks[0].id
    svc.dispatch(m.id, taskId, "go")

    const task = svc.get(m.id)!.tasks[0]
    expect(task.status).toBe("in-progress")
    expect(task.worktreePath).toBe(join("/repo", ".claude-tui", "worktrees", m.id, taskId))
    expect(task.branch).toMatch(/^claudetui\/mission\//)
    expect(task.baseRef).toBe("base000sha")
    // The worker spawned INTO the worktree, not the shared mission cwd.
    expect(spawnedCwd).toBe(task.worktreePath)
    // The worktree was created against the dispatch-time HEAD.
    const createCall = wt.calls.find((c) => c.op === "create")!
    expect((createCall.args as { base: string }).base).toBe("HEAD")
  })

  it("a worktree-create FAILURE leaves the task pending, spawns no worker", () => {
    let creates = 0
    const wt = makeFakeWorktree({ create: () => null })
    const svc = new MissionService(
      fakeDriver({ create: () => { creates++; return { id: "w1", name: "w", cwd: "/r", state: "active" } } }),
      { dir, worktree: wt, seedDelayMs: 0 },
    )
    const m = svc.create("g", "/repo", "hands-off", true)
    svc.plan(m.id, [{ title: "t" }])
    const taskId = svc.get(m.id)!.tasks[0].id
    const res = svc.dispatch(m.id, taskId, "go")
    expect(res).toBeUndefined()
    expect(creates).toBe(0)
    const task = svc.get(m.id)!.tasks[0]
    expect(task.status).toBe("pending")
    expect(task.assignedTo).toBeUndefined()
    expect(task.worktreePath).toBeUndefined()
  })
})

describe("MissionService WW-2 — resolve-done forks to awaiting-review (no auto-finish)", () => {
  it("resolve-done on an isolated task commits, captures the diff, parks at awaiting-review", () => {
    const wt = makeFakeWorktree()
    const svc = new MissionService(
      fakeDriver({ create: () => ({ id: "w1", name: "w", cwd: "/r", state: "active" }) }),
      { dir, worktree: wt, seedDelayMs: 0 },
    )
    const m = svc.create("g", "/repo", "hands-off", true)
    svc.plan(m.id, [{ title: "do thing" }])
    const taskId = svc.get(m.id)!.tasks[0].id
    svc.dispatch(m.id, taskId, "go")
    const out = svc.resolve(m.id, taskId, "done", "worker says done")!

    const task = out.tasks[0]
    expect(task.status).toBe("awaiting-review") // NOT done
    expect(out.status).toBe("running")          // mission NOT complete
    expect(task.diff).toContain("diff for")
    // commitAll ran with the wip message, diff captured vs the stored baseRef.
    const commit = wt.calls.find((c) => c.op === "commitAll")!
    expect((commit.args as { message: string }).message).toBe("wip: do thing")
    const diff = wt.calls.find((c) => c.op === "diff")!
    expect((diff.args as { base: string }).base).toBe("base000sha")
    // The worker is freed but no merge happened yet.
    expect(out.workers.find((w) => w.sessionId === "w1")?.currentTaskId).toBeUndefined()
    expect(wt.calls.some((c) => c.op === "merge")).toBe(false)
  })

  it("resolve-FAILED on an isolated task discards the worktree, then records failed", () => {
    const wt = makeFakeWorktree()
    const svc = new MissionService(
      fakeDriver({ create: () => ({ id: "w1", name: "w", cwd: "/r", state: "active" }) }),
      { dir, worktree: wt, seedDelayMs: 0 },
    )
    const m = svc.create("g", "/repo", "hands-off", true)
    svc.plan(m.id, [{ title: "t" }])
    const taskId = svc.get(m.id)!.tasks[0].id
    svc.dispatch(m.id, taskId, "go")
    const branch = svc.get(m.id)!.tasks[0].branch
    const out = svc.resolve(m.id, taskId, "failed", "broke")!
    const task = out.tasks[0]
    expect(task.status).toBe("failed")
    expect(task.worktreePath).toBeUndefined()
    const remove = wt.calls.find((c) => c.op === "remove")!
    expect((remove.args as { deleteBranch?: string }).deleteBranch).toBe(branch)
    // Sole task failed → mission blocked (completion recompute still runs).
    expect(out.status).toBe("blocked")
  })
})

describe("MissionService WW-2 — approve / reject", () => {
  function isolatedAwaitingReview(wt: FakeWorktree) {
    const svc = new MissionService(
      fakeDriver({ create: () => ({ id: "w1", name: "w", cwd: "/r", state: "active" }) }),
      { dir, worktree: wt, seedDelayMs: 0 },
    )
    const m = svc.create("g", "/repo", "hands-off", true)
    svc.plan(m.id, [{ title: "t" }])
    const taskId = svc.get(m.id)!.tasks[0].id
    svc.dispatch(m.id, taskId, "go")
    svc.resolve(m.id, taskId, "done")
    return { svc, missionId: m.id, taskId }
  }

  it("approveTask CLEAN merge → task done, worktree removed, mission completes", () => {
    const wt = makeFakeWorktree({ /* default mergeResult ok:true */ })
    const { svc, missionId, taskId } = isolatedAwaitingReview(wt)
    const branch = svc.get(missionId)!.tasks[0].branch
    const out = svc.approveTask(missionId, taskId)!
    const task = out.tasks[0]
    expect(task.status).toBe("done")
    expect(out.status).toBe("done") // recomputeCompletion ran
    expect(task.worktreePath).toBeUndefined()
    expect(task.branch).toBeUndefined()
    // merge then remove (with branch delete).
    expect(wt.calls.filter((c) => c.op === "merge")).toHaveLength(1)
    const remove = wt.calls.filter((c) => c.op === "remove").at(-1)!
    expect((remove.args as { deleteBranch?: string }).deleteBranch).toBe(branch)
  })

  it("approveTask CONFLICT → task merge-conflict, worktree+branch KEPT, notify, NEVER auto-resolved", () => {
    const notes: Array<{ text: string; level?: string }> = []
    const wt = makeFakeWorktree()
    wt.mergeResult = { ok: false, conflict: "CONFLICT in base.txt" }
    const svc = new MissionService(
      fakeDriver({ create: () => ({ id: "w1", name: "w", cwd: "/r", state: "active" }) }),
      { dir, worktree: wt, seedDelayMs: 0, notify: (text, level) => notes.push({ text, level }) },
    )
    const m = svc.create("g", "/repo", "hands-off", true)
    svc.plan(m.id, [{ title: "t" }])
    const taskId = svc.get(m.id)!.tasks[0].id
    svc.dispatch(m.id, taskId, "go")
    svc.resolve(m.id, taskId, "done")
    const out = svc.approveTask(m.id, taskId)!
    const task = out.tasks[0]
    expect(task.status).toBe("merge-conflict")
    expect(task.reviewReason).toBe("CONFLICT in base.txt")
    // Worktree+branch preserved for manual handling — NO remove after the merge.
    expect(task.worktreePath).toBeDefined()
    expect(task.branch).toBeDefined()
    expect(wt.calls.some((c) => c.op === "remove")).toBe(false)
    expect(notes.some((n) => /conflict/i.test(n.text))).toBe(true)
    // Mission is NOT done — a merge-conflict task isn't done.
    expect(out.status).toBe("running")
  })

  it("rejectTask → worktree+branch discarded, task back to pending (re-dispatchable), reason logged", () => {
    const wt = makeFakeWorktree()
    const { svc, missionId, taskId } = isolatedAwaitingReview(wt)
    const branch = svc.get(missionId)!.tasks[0].branch
    const out = svc.rejectTask(missionId, taskId, "wrong approach")!
    const task = out.tasks[0]
    expect(task.status).toBe("pending")
    expect(task.assignedTo).toBeUndefined()
    expect(task.worktreePath).toBeUndefined()
    expect(task.branch).toBeUndefined()
    expect(task.reviewReason).toBe("wrong approach")
    const remove = wt.calls.filter((c) => c.op === "remove").at(-1)!
    expect((remove.args as { deleteBranch?: string }).deleteBranch).toBe(branch)
    expect(out.eventLog.some((e) => /rejected/i.test(e.text))).toBe(true)
  })

  it("rejectTask also works from a merge-conflict state", () => {
    const wt = makeFakeWorktree()
    wt.mergeResult = { ok: false, conflict: "boom" }
    const svc = new MissionService(
      fakeDriver({ create: () => ({ id: "w1", name: "w", cwd: "/r", state: "active" }) }),
      { dir, worktree: wt, seedDelayMs: 0 },
    )
    const m = svc.create("g", "/repo", "hands-off", true)
    svc.plan(m.id, [{ title: "t" }])
    const taskId = svc.get(m.id)!.tasks[0].id
    svc.dispatch(m.id, taskId, "go")
    svc.resolve(m.id, taskId, "done")
    svc.approveTask(m.id, taskId) // → merge-conflict
    expect(svc.get(m.id)!.tasks[0].status).toBe("merge-conflict")
    const out = svc.rejectTask(m.id, taskId)!
    expect(out.tasks[0].status).toBe("pending")
  })

  it("approve/reject are no-ops for a task that isn't awaiting review", () => {
    const wt = makeFakeWorktree()
    const svc = new MissionService(fakeDriver(), { dir, worktree: wt, seedDelayMs: 0 })
    const m = svc.create("g", "/repo", "hands-off", true)
    svc.plan(m.id, [{ title: "t" }])
    const taskId = svc.get(m.id)!.tasks[0].id // still pending
    expect(svc.approveTask(m.id, taskId)).toBeUndefined()
    expect(svc.rejectTask(m.id, taskId)).toBeUndefined()
    expect(wt.calls.some((c) => c.op === "merge")).toBe(false)
  })

  it("a multi-task mission completes only after EVERY task is approved", () => {
    const wt = makeFakeWorktree()
    const svc = new MissionService(
      fakeDriver({ create: () => ({ id: `w${Math.random()}`, name: "w", cwd: "/r", state: "active" }) }),
      { dir, worktree: wt, seedDelayMs: 0 },
    )
    const m = svc.create("g", "/repo", "hands-off", true)
    svc.plan(m.id, [{ title: "a" }, { title: "b" }])
    const [t1, t2] = svc.get(m.id)!.tasks.map((t) => t.id)
    svc.dispatch(m.id, t1, "go"); svc.resolve(m.id, t1, "done")
    svc.dispatch(m.id, t2, "go"); svc.resolve(m.id, t2, "done")
    expect(svc.get(m.id)!.status).toBe("running") // both awaiting-review
    svc.approveTask(m.id, t1)
    expect(svc.get(m.id)!.status).toBe("running") // one still awaiting
    svc.approveTask(m.id, t2)
    expect(svc.get(m.id)!.status).toBe("done")    // all approved
  })
})

describe("MissionService WW-2 — stop/finish cleanup + orphan reap", () => {
  it("stop removes ALL of the mission's worktrees+branches", () => {
    const wt = makeFakeWorktree()
    const svc = new MissionService(
      fakeDriver({ create: () => ({ id: `w${Math.random()}`, name: "w", cwd: "/r", state: "active" }) }),
      { dir, worktree: wt, seedDelayMs: 0 },
    )
    const m = svc.create("g", "/repo", "hands-off", true)
    svc.plan(m.id, [{ title: "a" }, { title: "b" }])
    const [t1, t2] = svc.get(m.id)!.tasks.map((t) => t.id)
    svc.dispatch(m.id, t1, "go")
    svc.dispatch(m.id, t2, "go")
    const branches = svc.get(m.id)!.tasks.map((t) => t.branch)
    wt.calls.length = 0
    svc.stop(m.id)
    const removed = wt.calls.filter((c) => c.op === "remove")
    expect(removed).toHaveLength(2)
    const removedBranches = removed.map((c) => (c.args as { deleteBranch?: string }).deleteBranch).sort()
    expect(removedBranches).toEqual([...branches].sort())
    // Persisted task state is cleared.
    expect(svc.get(m.id)!.tasks.every((t) => !t.worktreePath)).toBe(true)
  })

  it("finish removes all worktrees too", () => {
    const wt = makeFakeWorktree()
    const svc = new MissionService(
      fakeDriver({ create: () => ({ id: "w1", name: "w", cwd: "/r", state: "active" }) }),
      { dir, worktree: wt, seedDelayMs: 0 },
    )
    const m = svc.create("g", "/repo", "hands-off", true)
    svc.plan(m.id, [{ title: "t" }])
    const taskId = svc.get(m.id)!.tasks[0].id
    svc.dispatch(m.id, taskId, "go")
    wt.calls.length = 0
    svc.finish(m.id)
    expect(wt.calls.filter((c) => c.op === "remove")).toHaveLength(1)
  })

  it("on load, orphan worktrees are reaped for isolated missions (keeping live task branches)", () => {
    // Seed an on-disk isolated mission with one task carrying a live branch.
    const wt1 = makeFakeWorktree()
    const seed = new MissionService(
      fakeDriver({ create: () => ({ id: "w1", name: "w", cwd: "/r", state: "active" }) }),
      { dir, worktree: wt1, seedDelayMs: 0 },
    )
    const m = seed.create("g", "/repo", "hands-off", true)
    seed.plan(m.id, [{ title: "t" }])
    const taskId = seed.get(m.id)!.tasks[0].id
    seed.dispatch(m.id, taskId, "go")
    const liveBranch = seed.get(m.id)!.tasks[0].branch!

    // A fresh instance loads from disk and reaps orphans in the constructor.
    const wt2 = makeFakeWorktree()
    new MissionService(fakeDriver(), { dir, worktree: wt2 })
    const reap = wt2.calls.find((c) => c.op === "reapOrphans")!
    expect(reap).toBeDefined()
    expect((reap.args as { keepBranches: string[] }).keepBranches).toContain(liveBranch)
  })

  it("on load, a NON-isolated mission is never reaped (no worktree calls)", () => {
    const seed = new MissionService(fakeDriver(), { dir, worktree: makeFakeWorktree(), seedDelayMs: 0 })
    const m = seed.create("g", "/repo")
    seed.plan(m.id, [{ title: "t" }])
    const wt2 = makeFakeWorktree()
    new MissionService(fakeDriver(), { dir, worktree: wt2 })
    expect(wt2.calls.filter((c) => c.op === "reapOrphans")).toHaveLength(0)
    // Sanity: the non-isolated mission did load.
    void m
  })
})
