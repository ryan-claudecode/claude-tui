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
