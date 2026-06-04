import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { MissionService, type SessionDriver } from "./mission"

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
      { dir },
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
    expect(writes).toEqual([{ id: "w1", data: "please do thing\r" }])
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
