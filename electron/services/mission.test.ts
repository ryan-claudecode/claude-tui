import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { MissionService, detectUsageLimit, type SessionDriver } from "./mission"

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
      { dir, enterDelayMs: 0, seedDelayMs: 0 },
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
    expect(svc.get(m.id)!.workers).toContainEqual({ sessionId: "w1", currentTaskId: taskId })
    // Prompt text and Enter are sent as separate writes so the TUI submits it.
    expect(writes).toEqual([{ id: "w1", data: "please do thing" }, { id: "w1", data: "\r" }])
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
    const svc = new MissionService(
      fakeDriver({
        create: () => ({ id: "w1", name: "w", cwd: "/r", state: "active" }),
        getActivity: () => [
          { id: "c1", name: "c", state: "active", idleMs: 0 },
          { id: "w1", name: "w", state: "idle", idleMs: 11 * 60_000 }, // 11 min idle
        ],
        kill: (id) => { killed.push(id); return true },
      }),
      { dir, seedDelayMs: 0, workerStallMs: 10 * 60_000 },
    )
    const m = svc.create("g", "/r")
    svc.plan(m.id, [{ title: "t" }])
    const taskId = svc.get(m.id)!.tasks[0].id
    svc.dispatch(m.id, taskId, "go")            // assigns w1, status in-progress
    svc.get(m.id)!.conductorSessionId = "c1"    // pretend conductor exists
    svc.tick()
    expect(killed).toContain("w1")
    const task = svc.get(m.id)!.tasks[0]
    expect(task.status).toBe("pending")
    expect(task.assignedTo).toBeUndefined()
    expect(svc.get(m.id)!.workers.some((w) => w.sessionId === "w1")).toBe(false)
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
