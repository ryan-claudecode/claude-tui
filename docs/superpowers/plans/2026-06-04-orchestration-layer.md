# Orchestration Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable, on-disk Mission system plus a code Supervisor that keeps a Claude "Conductor" alive to orchestrate worker sessions toward a long-running goal — surviving context limits, usage limits, and restarts.

**Architecture:** A new `MissionService` (source of truth) owns Mission state, persists each change to `~/.claude-tui/missions/<id>.json`, and runs a Supervisor `tick()` (driven by a `setInterval`, like `SessionService.startIdleMonitor`). It drives sessions through a narrow `SessionDriver` interface (a subset of `SessionService`) so the state logic is unit-testable with a fake driver. MCP `mission_*` tools and IPC handlers are thin wrappers. A Conductor Claude session reads/updates the Mission via the tools; the Supervisor respawns the Conductor and auto-resumes after token-limit windows. A Mission dashboard panel renders state.

**Tech Stack:** TypeScript, Electron main process, node-pty (via SessionService), @modelcontextprotocol/sdk + zod (tools), React (panel), vitest (new — unit tests for the service).

---

## File Structure

| File | Responsibility | New/Modify |
|------|----------------|-----------|
| `electron/services/mission.ts` | `MissionService`: types, durable state, CRUD, dispatch/await/resolve, Supervisor `tick()`, usage-limit handling | Create |
| `electron/services/mission.test.ts` | Unit tests (fake `SessionDriver`, injected `now`) | Create |
| `electron/mcp/tools.ts` | ~12 `mission_*` tool registrations | Modify |
| `electron/mcp/server.ts` | Inject `missionService`; extend `SERVER_INSTRUCTIONS` | Modify |
| `electron/ipc.ts` | Instantiate `missionService`, start it, IPC handlers for UI start/stop/pause | Modify |
| `electron/preload.ts` | Expose mission IPC + event listener to renderer | Modify |
| `src/components/panels/MissionPanel.tsx` | Dashboard panel component | Create |
| `src/components/PanelDrawer.tsx` | Route `"mission"` panel type | Modify |
| `src/App.tsx` | "Start Mission…" command + start/stop wiring | Modify |
| `src/App.css` | `.mission-panel` styles | Modify |
| `CLAUDE.md` | Document the Mission tool group + architecture | Modify |
| `vitest.config.ts` + `package.json` | Test runner | Create/Modify |

`MissionService` is the only file with real logic. It is large-ish but cohesive (one responsibility: missions). The interface boundary (`SessionDriver`) keeps it decoupled from pty internals.

---

## Phase 0 — Test infrastructure

### Task 1: Add vitest

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`
- Create: `electron/services/smoke.test.ts` (temporary smoke test, deleted in step 6)

- [ ] **Step 1: Install vitest**

Run: `npm install -D vitest`
Expected: vitest added to devDependencies.

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["electron/**/*.test.ts"],
    environment: "node",
  },
})
```

- [ ] **Step 3: Add test script to `package.json`**

In `"scripts"`, add:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Write smoke test** — `electron/services/smoke.test.ts`

```ts
import { describe, it, expect } from "vitest"

describe("smoke", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 5: Run it**

Run: `npm test`
Expected: 1 passed.

- [ ] **Step 6: Delete the smoke test and commit**

```bash
rm electron/services/smoke.test.ts
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add vitest test runner"
```

---

## Phase 1 — Mission spine

### Task 2: Mission types + persistence + create/get/list

**Files:**
- Create: `electron/services/mission.ts`
- Create: `electron/services/mission.test.ts`

- [ ] **Step 1: Write failing tests** — `electron/services/mission.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { MissionService, type SessionDriver } from "./mission"

function fakeDriver(overrides: Partial<SessionDriver> = {}): SessionDriver {
  return {
    create: (name, cwd) => ({ id: `s-${Math.random().toString(36).slice(2, 6)}`, name: name ?? "s", cwd: cwd ?? ".", state: "active" }),
    write: () => {},
    waitForIdle: async () => ({ idle: true, timedOut: false }),
    getActivity: () => [],
    getOutput: () => "",
    kill: () => true,
    ...overrides,
  }
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mission-test-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

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
```

- [ ] **Step 2: Run, verify fail**

Run: `npm test`
Expected: FAIL — cannot find `./mission`.

- [ ] **Step 3: Implement types + create/get/list/status** — `electron/services/mission.ts`

```ts
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { SessionInfo, SessionActivity } from "./sessions"

/** The slice of SessionService that MissionService drives. A fake is used in tests. */
export interface SessionDriver {
  create(name?: string, cwd?: string): SessionInfo
  write(id: string, data: string): void
  waitForIdle(
    id: string,
    opts: { input?: string; submit?: boolean; quietMs?: number; timeoutMs?: number },
  ): Promise<{ idle: boolean; timedOut: boolean; reason?: string }>
  getActivity(): SessionActivity[]
  getOutput(id: string, maxChars?: number): string | null
  kill(id: string): boolean
}

export type Autonomy = "hands-off" | "checkpoints" | "supervised"
export type MissionStatus = "planning" | "running" | "paused" | "blocked" | "done" | "stopped"
export type TaskStatus = "pending" | "assigned" | "in-progress" | "review" | "done" | "failed"
export type EventKind = "info" | "task" | "worker" | "review" | "commit" | "pause" | "error"

export interface MissionTask {
  id: string
  title: string
  detail?: string
  status: TaskStatus
  assignedTo?: string
  result?: string
  attempts: number
}
export interface MissionWorker { sessionId: string; role?: string; currentTaskId?: string }
export interface MissionEvent { time: number; kind: EventKind; text: string }

export interface Mission {
  id: string
  goal: string
  cwd: string
  autonomy: Autonomy
  status: MissionStatus
  conductorSessionId?: string
  resumeAt?: number
  tasks: MissionTask[]
  workers: MissionWorker[]
  eventLog: MissionEvent[]
  createdAt: number
  updatedAt: number
}

const TERMINAL: MissionStatus[] = ["done", "stopped"]

export interface MissionServiceOpts {
  dir?: string
  now?: () => number
  seedDelayMs?: number
  notify?: (text: string, level?: string) => void
}

export class MissionService {
  private dir: string
  private now: () => number
  private seedDelayMs: number
  private notify?: (text: string, level?: string) => void
  private missions = new Map<string, Mission>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private sessions: SessionDriver, opts: MissionServiceOpts = {}) {
    this.dir = opts.dir ?? join(homedir(), ".claude-tui", "missions")
    this.now = opts.now ?? (() => Date.now())
    this.seedDelayMs = opts.seedDelayMs ?? 4000
    this.notify = opts.notify
    this.loadAll()
  }

  private loadAll(): void {
    try {
      for (const f of readdirSync(this.dir)) {
        if (!f.endsWith(".json")) continue
        try {
          const m = JSON.parse(readFileSync(join(this.dir, f), "utf-8")) as Mission
          this.missions.set(m.id, m)
        } catch { /* skip corrupt file */ }
      }
    } catch { /* dir absent yet */ }
  }

  private persist(m: Mission): void {
    m.updatedAt = this.now()
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(join(this.dir, `${m.id}.json`), JSON.stringify(m, null, 2))
  }

  private log(m: Mission, kind: EventKind, text: string): void {
    m.eventLog.push({ time: this.now(), kind, text })
  }

  create(goal: string, cwd: string, autonomy: Autonomy = "hands-off"): Mission {
    const t = this.now()
    const m: Mission = {
      id: `mission-${t}-${Math.random().toString(36).slice(2, 8)}`,
      goal, cwd, autonomy,
      status: "planning",
      tasks: [], workers: [], eventLog: [],
      createdAt: t, updatedAt: t,
    }
    this.log(m, "info", `Mission created: ${goal}`)
    this.missions.set(m.id, m)
    this.persist(m)
    return m
  }

  get(id: string): Mission | undefined { return this.missions.get(id) }

  list(): Mission[] {
    return Array.from(this.missions.values()).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** With no id: the most-recently-updated non-terminal mission. */
  status(id?: string): Mission | undefined {
    if (id) return this.missions.get(id)
    return this.list().find((m) => !TERMINAL.includes(m.status))
  }

  finish(id: string): Mission | undefined {
    const m = this.missions.get(id)
    if (!m) return undefined
    m.status = "done"
    this.log(m, "info", "Mission finished")
    this.persist(m)
    return m
  }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/services/mission.ts electron/services/mission.test.ts
git commit -m "feat: MissionService core — types, persistence, create/get/list/status/finish"
```

### Task 3: Planning — add/replace tasks

**Files:** Modify `electron/services/mission.ts`, `electron/services/mission.test.ts`

- [ ] **Step 1: Add failing test** (append to mission.test.ts)

```ts
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
```

- [ ] **Step 2: Run, verify fail** — `npm test` → FAIL (`svc.plan` not a function).

- [ ] **Step 3: Implement `plan`** (add method to MissionService)

```ts
  plan(id: string, tasks: Array<{ title: string; detail?: string }>): Mission | undefined {
    const m = this.missions.get(id)
    if (!m) return undefined
    m.tasks = tasks.map((t, i) => ({
      id: `t${i + 1}-${Math.random().toString(36).slice(2, 6)}`,
      title: t.title,
      detail: t.detail,
      status: "pending" as TaskStatus,
      attempts: 0,
    }))
    if (m.status === "planning") m.status = "running"
    this.log(m, "task", `Planned ${tasks.length} task(s)`)
    this.persist(m)
    return m
  }
```

- [ ] **Step 4: Run, verify pass** — `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/mission.ts electron/services/mission.test.ts
git commit -m "feat: MissionService.plan — populate task list, start mission"
```

### Task 4: Dispatch + await (drive a worker)

**Files:** Modify `electron/services/mission.ts`, `electron/services/mission.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
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
```

- [ ] **Step 2: Run, verify fail** — `npm test` → FAIL.

- [ ] **Step 3: Implement `dispatch` + `await`**

```ts
  /** Spawn (or reuse) a worker for a task, inject its prompt, mark in-progress. */
  dispatch(missionId: string, taskId: string, prompt: string): { sessionId: string } | undefined {
    const m = this.missions.get(missionId)
    const task = m?.tasks.find((t) => t.id === taskId)
    if (!m || !task) return undefined
    const info = this.sessions.create(`${m.goal.slice(0, 20)} · ${task.title.slice(0, 20)}`, m.cwd)
    this.sessions.write(info.id, `${prompt}\r`)
    task.status = "in-progress"
    task.assignedTo = info.id
    task.attempts += 1
    if (!m.workers.some((w) => w.sessionId === info.id)) {
      m.workers.push({ sessionId: info.id, currentTaskId: taskId })
    }
    this.log(m, "worker", `Dispatched "${task.title}" to ${info.id}`)
    this.persist(m)
    return { sessionId: info.id }
  }

  /** Block until the task's worker goes idle; return its recent output. */
  async await(
    missionId: string,
    taskId: string,
    timeoutMs?: number,
  ): Promise<{ idle: boolean; timedOut: boolean; output: string } | undefined> {
    const m = this.missions.get(missionId)
    const task = m?.tasks.find((t) => t.id === taskId)
    if (!m || !task || !task.assignedTo) return undefined
    const r = await this.sessions.waitForIdle(task.assignedTo, { timeoutMs })
    const output = this.sessions.getOutput(task.assignedTo, 8000) ?? ""
    if (r.idle) {
      task.status = "review"
      this.persist(m)
    }
    return { idle: r.idle, timedOut: r.timedOut, output }
  }
```

> Note: `await` is a valid method name (only a reserved word as an operator). If the toolchain complains, rename to `awaitWorker` here and in the tool registration.

- [ ] **Step 4: Run, verify pass** — `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/mission.ts electron/services/mission.test.ts
git commit -m "feat: MissionService dispatch/await — drive a worker session for a task"
```

### Task 5: Resolve, log, stop, worker cleanup

**Files:** Modify `electron/services/mission.ts`, `electron/services/mission.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
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
```

- [ ] **Step 2: Run, verify fail** — `npm test` → FAIL.

- [ ] **Step 3: Implement `resolve`, `logEvent`, `stop`**

```ts
  resolve(missionId: string, taskId: string, status: "done" | "failed", result?: string): Mission | undefined {
    const m = this.missions.get(missionId)
    const task = m?.tasks.find((t) => t.id === taskId)
    if (!m || !task) return undefined
    task.status = status
    task.result = result
    const worker = m.workers.find((w) => w.currentTaskId === taskId)
    if (worker) worker.currentTaskId = undefined
    this.log(m, "review", `Task "${task.title}" → ${status}${result ? `: ${result}` : ""}`)
    if (m.tasks.length > 0 && m.tasks.every((t) => t.status === "done")) {
      m.status = "done"
      this.log(m, "info", "All tasks done — mission complete")
    } else if (m.tasks.every((t) => t.status === "done" || t.status === "failed")) {
      m.status = "blocked"
      this.log(m, "error", "Remaining tasks failed — mission blocked")
      this.notify?.(`Mission blocked: ${m.goal}`, "warning")
    }
    this.persist(m)
    return m
  }

  logEvent(missionId: string, kind: EventKind, text: string): Mission | undefined {
    const m = this.missions.get(missionId)
    if (!m) return undefined
    this.log(m, kind, text)
    this.persist(m)
    return m
  }

  stop(missionId: string): Mission | undefined {
    const m = this.missions.get(missionId)
    if (!m) return undefined
    for (const w of m.workers) this.sessions.kill(w.sessionId)
    if (m.conductorSessionId) this.sessions.kill(m.conductorSessionId)
    m.workers = []
    m.conductorSessionId = undefined
    m.status = "stopped"
    this.log(m, "info", "Mission stopped by user")
    this.persist(m)
    return m
  }
```

- [ ] **Step 4: Run, verify pass** — `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/mission.ts electron/services/mission.test.ts
git commit -m "feat: MissionService resolve/logEvent/stop with completion + block detection"
```

### Task 6: Wire core MCP tools + IPC

**Files:** Modify `electron/mcp/tools.ts`, `electron/mcp/server.ts`, `electron/ipc.ts`

- [ ] **Step 1: Instantiate + start in `electron/ipc.ts`**

After the other service instantiations (near line 71), add:
```ts
import { MissionService } from "./services/mission"
```
After `export const uiService = new UiService()`:
```ts
export const missionService = new MissionService(sessionService, {
  notify: (text, level) => notificationService.show?.(text, level as any),
})
```
> If `NotificationService` lacks a usable `show`, omit the `notify` option for now (Supervisor still works; user just won't get a toast on block). Verify the method name against `electron/services/notifications.ts` before wiring.

In `setupIpc`, after `uiService.setMainWindow(win)`:
```ts
missionService.start()
```
And add IPC handlers (after the UI handlers):
```ts
ipcMain.handle("mission:list", () => missionService.list())
ipcMain.handle("mission:status", (_e, id?: string) => missionService.status(id))
ipcMain.handle("mission:create", (_e, goal: string, cwd: string, autonomy?: any) =>
  missionService.create(goal, cwd, autonomy),
)
ipcMain.handle("mission:stop", (_e, id: string) => missionService.stop(id))
ipcMain.handle("mission:pause", (_e, id: string, resumeAt?: number) => missionService.pause(id, resumeAt))
ipcMain.handle("mission:resume", (_e, id: string) => missionService.resume(id))
```
> `start`, `pause`, `resume` land in Task 7/9. This step only compiles after those exist — so reorder: do Step 1's handler additions but stub `start/pause/resume` now. To avoid a broken build between tasks, add minimal stubs to MissionService now:
```ts
  start(): void { if (!this.timer) this.timer = setInterval(() => this.tick(), 5000) }
  pause(id: string, resumeAt?: number): Mission | undefined { return undefined }
  resume(id: string): Mission | undefined { return undefined }
  tick(): void {}
  stopTimer(): void { if (this.timer) { clearInterval(this.timer); this.timer = null } }
```

- [ ] **Step 2: Inject into MCP server** — `electron/mcp/server.ts`

Add `import type { MissionService } from "../services/mission"`. Add `missionService: MissionService,` as the final param of `startMcpServer`. Pass `missionService,` as the final arg to `registerTools`. In `ipc.ts`, pass `missionService` as the final arg to `startMcpServer(...)`.

- [ ] **Step 3: Register tools** — `electron/mcp/tools.ts`

Add `import type { MissionService } from "../services/mission"` and `mission: MissionService,` as the final `registerTools` param. After the App-UI-control tools block (after `get_config`, ~line 331), add:
```ts
  // Mission orchestration — durable, on-disk missions driven by a Conductor.
  server.tool("mission_create", "Start a new orchestration mission. Returns the mission (status 'planning'); decompose its goal with mission_plan, then dispatch workers.", {
    goal: z.string().describe("The mission's north-star goal"),
    cwd: z.string().describe("Absolute path of the repo/dir the mission operates on"),
    autonomy: z.enum(["hands-off", "checkpoints", "supervised"]).optional().describe("How hands-on the user is (default hands-off)"),
  }, async ({ goal, cwd, autonomy }) => {
    const m = mission.create(goal, cwd, autonomy)
    return { content: [{ type: "text" as const, text: JSON.stringify(m, null, 2) }] }
  })

  server.tool("mission_status", "Load a mission's full durable state — the resume entry point. Omit mission_id for the most-recently-updated active mission.", {
    mission_id: z.string().optional(),
  }, async ({ mission_id }) => {
    const m = mission.status(mission_id)
    return { content: [{ type: "text" as const, text: m ? JSON.stringify(m, null, 2) : "No active mission" }] }
  })

  server.tool("mission_list", "List all missions, newest-updated first.", {}, async () => {
    return { content: [{ type: "text" as const, text: JSON.stringify(mission.list(), null, 2) }] }
  })

  server.tool("mission_plan", "Set a mission's task list (decomposition) and start it running.", {
    mission_id: z.string(),
    tasks: z.array(z.object({ title: z.string(), detail: z.string().optional() })).describe("Ordered task list"),
  }, async ({ mission_id, tasks }) => {
    const m = mission.plan(mission_id, tasks)
    return { content: [{ type: "text" as const, text: m ? JSON.stringify(m, null, 2) : "Mission not found" }] }
  })

  server.tool("mission_dispatch", "Spawn/reuse a worker session for a task, inject its prompt, mark it in-progress. Returns the worker session id.", {
    mission_id: z.string(), task_id: z.string(), prompt: z.string().describe("The full task prompt for the worker"),
  }, async ({ mission_id, task_id, prompt }) => {
    const r = mission.dispatch(mission_id, task_id, prompt)
    return { content: [{ type: "text" as const, text: r ? JSON.stringify(r) : "Mission/task not found" }] }
  })

  server.tool("mission_await", "Block until a task's worker goes idle (finished), then return its recent output for review.", {
    mission_id: z.string(), task_id: z.string(), timeout_ms: z.number().optional(),
  }, async ({ mission_id, task_id, timeout_ms }) => {
    const r = await mission.await(mission_id, task_id, timeout_ms)
    return { content: [{ type: "text" as const, text: r ? JSON.stringify(r, null, 2) : "Mission/task/worker not found" }] }
  })

  server.tool("mission_resolve", "Record a task's review outcome (done/failed) and free its worker.", {
    mission_id: z.string(), task_id: z.string(), status: z.enum(["done", "failed"]), result: z.string().optional(),
  }, async ({ mission_id, task_id, status, result }) => {
    const m = mission.resolve(mission_id, task_id, status, result)
    return { content: [{ type: "text" as const, text: m ? JSON.stringify(m, null, 2) : "Mission/task not found" }] }
  })

  server.tool("mission_log", "Append an event to a mission's audit trail.", {
    mission_id: z.string(), kind: z.enum(["info", "task", "worker", "review", "commit", "pause", "error"]), text: z.string(),
  }, async ({ mission_id, kind, text }) => {
    const m = mission.logEvent(mission_id, kind, text)
    return { content: [{ type: "text" as const, text: m ? "logged" : "Mission not found" }] }
  })

  server.tool("mission_pause", "Pause a mission (e.g. on a usage limit). Optionally set resume_at (epoch ms) for auto-resume.", {
    mission_id: z.string(), resume_at: z.number().optional(),
  }, async ({ mission_id, resume_at }) => {
    const m = mission.pause(mission_id, resume_at)
    return { content: [{ type: "text" as const, text: m ? JSON.stringify(m, null, 2) : "Mission not found" }] }
  })

  server.tool("mission_resume", "Resume a paused mission immediately.", { mission_id: z.string() }, async ({ mission_id }) => {
    const m = mission.resume(mission_id)
    return { content: [{ type: "text" as const, text: m ? JSON.stringify(m, null, 2) : "Mission not found" }] }
  })

  server.tool("mission_stop", "Stop a mission and kill its workers + conductor.", { mission_id: z.string() }, async ({ mission_id }) => {
    const m = mission.stop(mission_id)
    return { content: [{ type: "text" as const, text: m ? "stopped" : "Mission not found" }] }
  })

  server.tool("mission_finish", "Mark a mission done.", { mission_id: z.string() }, async ({ mission_id }) => {
    const m = mission.finish(mission_id)
    return { content: [{ type: "text" as const, text: m ? "done" : "Mission not found" }] }
  })
```

- [ ] **Step 4: Build**

Run: `npx electron-vite build`
Expected: BUILD SUCCESS.

- [ ] **Step 5: Commit**

```bash
git add electron/mcp/tools.ts electron/mcp/server.ts electron/ipc.ts electron/services/mission.ts
git commit -m "feat: wire mission_* MCP tools + IPC handlers"
```

---

## Phase 2 — Supervisor

### Task 7: Supervisor tick — ensure/respawn Conductor

**Files:** Modify `electron/services/mission.ts`, `electron/services/mission.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
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
```

- [ ] **Step 2: Run, verify fail** — `npm test` → FAIL.

- [ ] **Step 3: Implement `tick` + conductor seeding** (replace the Task-6 stub `tick(){}`)

```ts
  private conductorSeed(m: Mission): string {
    return `You are the Conductor for ClaudeTUI mission "${m.id}". ` +
      `Call the mission_status MCP tool to load the goal and task list, then drive the mission: ` +
      `if planning, decompose the goal with mission_plan; otherwise pick the next pending task, ` +
      `mission_dispatch it to a worker, mission_await it, review the output, and mission_resolve it. ` +
      `Commit completed work with the git_* tools. Loop until every task is done, then mission_finish. ` +
      `If you hit a usage limit, call mission_pause. You may stop anytime — a fresh Conductor resumes from mission_status.`
  }

  private liveSessionIds(): Set<string> {
    return new Set(this.sessions.getActivity().filter((a) => a.state !== "dead").map((a) => a.id))
  }

  private ensureConductor(m: Mission, live: Set<string>): void {
    if (m.conductorSessionId && live.has(m.conductorSessionId)) return
    const info = this.sessions.create(`Conductor · ${m.goal.slice(0, 24)}`, m.cwd)
    m.conductorSessionId = info.id
    this.log(m, "info", `Conductor (re)spawned: ${info.id}`)
    const seed = this.conductorSeed(m)
    if (this.seedDelayMs > 0) setTimeout(() => this.sessions.write(info.id, `${seed}\r`), this.seedDelayMs)
    else this.sessions.write(info.id, `${seed}\r`)
    this.persist(m)
  }

  tick(): void {
    const live = this.liveSessionIds()
    for (const m of this.missions.values()) {
      if (m.status === "running") this.ensureConductor(m, live)
    }
  }
```

- [ ] **Step 4: Run, verify pass** — `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/mission.ts electron/services/mission.test.ts
git commit -m "feat: Supervisor tick spawns/respawns the Conductor for running missions"
```

### Task 8: Stalled-worker watchdog

**Files:** Modify `electron/services/mission.ts`, `electron/services/mission.test.ts`

- [ ] **Step 1: Add failing test**

```ts
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
```

- [ ] **Step 2: Run, verify fail** — `npm test` → FAIL.

- [ ] **Step 3: Implement** — add `workerStallMs` opt + watchdog in `tick`

Add to `MissionServiceOpts`: `workerStallMs?: number`. In constructor: `this.workerStallMs = opts.workerStallMs ?? 10 * 60_000` (field declared `private workerStallMs: number`). Add method and call it from `tick` (before `ensureConductor` per mission):

```ts
  private reapStalledWorkers(m: Mission, activity: SessionActivity[]): void {
    const byId = new Map(activity.map((a) => [a.id, a]))
    for (const w of [...m.workers]) {
      const a = byId.get(w.sessionId)
      const stalled = !a || a.idleMs > this.workerStallMs
      if (w.currentTaskId && stalled) {
        const task = m.tasks.find((t) => t.id === w.currentTaskId)
        if (task && task.status === "in-progress") {
          task.status = "pending"
          task.assignedTo = undefined
        }
        this.sessions.kill(w.sessionId)
        m.workers = m.workers.filter((x) => x.sessionId !== w.sessionId)
        this.log(m, "error", `Reaped stalled worker ${w.sessionId}; task requeued`)
      }
    }
  }
```
Update `tick`:
```ts
  tick(): void {
    const activity = this.sessions.getActivity()
    const live = new Set(activity.filter((a) => a.state !== "dead").map((a) => a.id))
    for (const m of this.missions.values()) {
      if (m.status !== "running") continue
      this.reapStalledWorkers(m, activity)
      this.ensureConductor(m, live)
      this.persist(m)
    }
  }
```

- [ ] **Step 4: Run, verify pass** — `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/mission.ts electron/services/mission.test.ts
git commit -m "feat: Supervisor reaps stalled workers and requeues their tasks"
```

---

## Phase 3 — Token-limit resilience

### Task 9: Usage-limit detection + pause/resume

**Files:** Modify `electron/services/mission.ts`, `electron/services/mission.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
import { detectUsageLimit } from "./mission"

describe("detectUsageLimit", () => {
  it("flags usage-limit messages", () => {
    expect(detectUsageLimit("Claude usage limit reached. Try again later.").limited).toBe(true)
    expect(detectUsageLimit("5-hour limit reached").limited).toBe(true)
    expect(detectUsageLimit("normal output").limited).toBe(false)
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
```

- [ ] **Step 2: Run, verify fail** — `npm test` → FAIL.

- [ ] **Step 3: Implement**

Top-level export in `mission.ts`:
```ts
const USAGE_LIMIT_RE = /usage limit|limit reached|rate limit|too many requests/i
export function detectUsageLimit(text: string): { limited: boolean } {
  return { limited: USAGE_LIMIT_RE.test(text) }
}
```
Add opts `usageBackoffMs?: number` (default `60 * 60_000`) and field. Add methods:
```ts
  pause(id: string, resumeAt?: number): Mission | undefined {
    const m = this.missions.get(id)
    if (!m) return undefined
    m.status = "paused"
    m.resumeAt = resumeAt
    this.log(m, "pause", resumeAt ? `Paused until ${new Date(resumeAt).toISOString()}` : "Paused")
    this.persist(m)
    return m
  }

  resume(id: string): Mission | undefined {
    const m = this.missions.get(id)
    if (!m) return undefined
    m.status = "running"
    m.resumeAt = undefined
    this.log(m, "info", "Resumed")
    this.persist(m)
    return m
  }

  private checkUsageLimit(m: Mission): boolean {
    const ids = [m.conductorSessionId, ...m.workers.map((w) => w.sessionId)].filter(Boolean) as string[]
    for (const id of ids) {
      const out = this.sessions.getOutput(id, 2000) ?? ""
      if (detectUsageLimit(out).limited) {
        this.pause(m.id, this.now() + this.usageBackoffMs)
        if (m.conductorSessionId) { this.sessions.kill(m.conductorSessionId); m.conductorSessionId = undefined }
        this.notify?.(`Mission paused (usage limit): ${m.goal}`, "warning")
        return true
      }
    }
    return false
  }
```
Update `tick` to handle pause→resume and usage-limit checks:
```ts
  tick(): void {
    const now = this.now()
    const activity = this.sessions.getActivity()
    const live = new Set(activity.filter((a) => a.state !== "dead").map((a) => a.id))
    for (const m of this.missions.values()) {
      if (m.status === "paused") {
        if (m.resumeAt != null && now >= m.resumeAt) this.resume(m)
        continue
      }
      if (m.status !== "running") continue
      if (this.checkUsageLimit(m)) continue
      this.reapStalledWorkers(m, activity)
      this.ensureConductor(m, live)
      this.persist(m)
    }
  }
```

- [ ] **Step 4: Run, verify pass** — `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/mission.ts electron/services/mission.test.ts
git commit -m "feat: usage-limit detection + pause/auto-resume (token-limit resilience)"
```

### Task 10: Retire overnight-run.sh

**Files:** Modify `scripts/overnight-run.sh`

- [ ] **Step 1: Add a deprecation banner** to the top of `scripts/overnight-run.sh` (do NOT delete — keep as a fallback reference):

```bash
# DEPRECATED: superseded by the in-app Mission orchestration layer
# (electron/services/mission.ts). Missions now survive usage limits and
# restarts in-app via the Supervisor. Kept for reference / headless use.
```

- [ ] **Step 2: Build sanity** — `npx electron-vite build` → BUILD SUCCESS.

- [ ] **Step 3: Commit**

```bash
git add scripts/overnight-run.sh
git commit -m "docs: mark overnight-run.sh deprecated in favor of in-app missions"
```

---

## Phase 4 — Dashboard + controls

### Task 11: Mission dashboard panel

**Files:** Create `src/components/panels/MissionPanel.tsx`; Modify `src/components/PanelDrawer.tsx`, `src/App.css`, `electron/mcp/tools.ts`

- [ ] **Step 1: Create `MissionPanel.tsx`** — renders the props of a `mission` panel (the Mission object). No tests (UI; verified via build + screenshot).

```tsx
interface Task { id: string; title: string; detail?: string; status: string; result?: string }
interface Worker { sessionId: string; currentTaskId?: string }
interface Event { time: number; kind: string; text: string }
interface Props {
  id?: string; goal?: string; status?: string; autonomy?: string
  tasks?: Task[]; workers?: Worker[]; eventLog?: Event[]
  onStop?: (id: string) => void; onPause?: (id: string) => void
}

const STATUS_COLOR: Record<string, string> = {
  pending: "var(--text-2)", "in-progress": "var(--accent-bright)", assigned: "var(--accent-bright)",
  review: "var(--yellow, #d2a8ff)", done: "var(--green, #3fb950)", failed: "var(--red, #f85149)",
}

export default function MissionPanel({ id, goal, status, autonomy, tasks = [], workers = [], eventLog = [], onStop, onPause }: Props) {
  const done = tasks.filter((t) => t.status === "done").length
  return (
    <div className="mission-panel">
      <div className="mission-header">
        <div className="mission-goal">{goal}</div>
        <div className="mission-meta">
          <span className={`mission-status mission-status-${status}`}>{status}</span>
          <span className="mission-autonomy">{autonomy}</span>
          <span className="mission-progress">{done}/{tasks.length} done</span>
        </div>
        <div className="mission-controls">
          <button onClick={() => id && onPause?.(id)}>Pause</button>
          <button onClick={() => id && onStop?.(id)}>Stop</button>
        </div>
      </div>
      <div className="mission-tasks">
        {tasks.map((t) => (
          <div key={t.id} className="mission-task">
            <span className="mission-task-dot" style={{ background: STATUS_COLOR[t.status] ?? "var(--text-2)" }} />
            <div className="mission-task-body">
              <div className="mission-task-title">{t.title}</div>
              {t.result && <div className="mission-task-result">{t.result}</div>}
            </div>
            <span className="mission-task-status">{t.status}</span>
          </div>
        ))}
      </div>
      {workers.length > 0 && (
        <div className="mission-workers">Workers: {workers.map((w) => w.sessionId).join(", ")}</div>
      )}
      <div className="mission-log">
        {eventLog.slice(-30).map((e, i) => (
          <div key={i} className={`mission-log-line mission-log-${e.kind}`}>
            <span className="mission-log-time">{new Date(e.time).toLocaleTimeString()}</span> {e.text}
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Route the type** in `src/components/PanelDrawer.tsx` — add a `case "mission":` to `PanelContent` returning `<MissionPanel {...panel.props} onStop={onMissionStop} onPause={onMissionPause} />`, threading `onMissionStop`/`onMissionPause` props through `PanelDrawer` like the existing `onSendToSession`. Import `MissionPanel`.

- [ ] **Step 3: Allow the type** — in `electron/mcp/tools.ts`, add `"mission"` to the `show_panel` `type` enum and a short note in its description: `mission renders a Mission object (goal, status, tasks[], workers[], eventLog[]) as a live dashboard`.

- [ ] **Step 4: Style** — add a `.mission-panel` block to `src/App.css` using design tokens (header flex row, task rows with dot + title + status, scrollable `.mission-log` in monospace). Mirror the existing `.diff-panel`/`.log-panel` conventions.

- [ ] **Step 5: Build** — `npx electron-vite build` → BUILD SUCCESS.

- [ ] **Step 6: Commit**

```bash
git add src/components/panels/MissionPanel.tsx src/components/PanelDrawer.tsx src/App.css electron/mcp/tools.ts
git commit -m "feat: Mission dashboard panel (mission panel type)"
```

### Task 12: Start/Stop/Pause UI + preload

**Files:** Modify `electron/preload.ts`, `src/App.tsx`

- [ ] **Step 1: Expose mission IPC in `electron/preload.ts`** (inside the `api` object):

```ts
  createMission: (goal: string, cwd: string, autonomy?: string) => ipcRenderer.invoke("mission:create", goal, cwd, autonomy),
  listMissions: () => ipcRenderer.invoke("mission:list"),
  getMissionStatus: (id?: string) => ipcRenderer.invoke("mission:status", id),
  stopMission: (id: string) => ipcRenderer.invoke("mission:stop", id),
  pauseMission: (id: string) => ipcRenderer.invoke("mission:pause", id),
  resumeMission: (id: string) => ipcRenderer.invoke("mission:resume", id),
```

- [ ] **Step 2: Add a "Start Mission…" command** to the command palette in `src/App.tsx`. Add to the `commands` array:
```ts
{ id: "mission", label: "Start Mission…", keywords: "orchestrate conductor autonomous build", run: startMission },
```
And define `startMission` (uses the existing `show_form` is MCP-side; for UI use a simple `window.prompt` fallback to stay dependency-free, then open the dashboard):
```ts
const startMission = useCallback(async () => {
  const goal = window.prompt("Mission goal?")
  if (!goal) return
  const cwd = sessions.find((s) => s.id === activeId)?.cwd ?? ""
  const m = await window.api.createMission(goal, cwd, "hands-off")
  const panel = { id: `mission-${m.id}`, type: "mission", props: m }
  setPanels((prev) => [...prev.filter((p) => p.id !== panel.id), panel])
}, [sessions, activeId])
```
> Add `startMission` to the `commands` `useMemo` dependency array.

- [ ] **Step 3: Wire panel controls** — pass `onMissionStop`/`onMissionPause` into `<PanelDrawer>` in `App.tsx`:
```ts
onMissionStop={(id) => window.api.stopMission(id)}
onMissionPause={(id) => window.api.pauseMission(id)}
```

- [ ] **Step 4: Build** — `npx electron-vite build` → BUILD SUCCESS.

- [ ] **Step 5: Commit**

```bash
git add electron/preload.ts src/App.tsx src/components/PanelDrawer.tsx
git commit -m "feat: Start/Stop/Pause mission controls in the UI"
```

### Task 13: Docs — CLAUDE.md + SERVER_INSTRUCTIONS

**Files:** Modify `CLAUDE.md`, `electron/mcp/server.ts`

- [ ] **Step 1: Add a Mission tool group** to `CLAUDE.md` after the **App UI control** section, documenting the `mission_*` tools, the Mission/Conductor/Supervisor/Worker roles, durable state location (`~/.claude-tui/missions/`), the conductor loop, and that a fresh Conductor resumes via `mission_status`. Add `electron/services/mission.ts` to the Key Files table.

- [ ] **Step 2: Extend `SERVER_INSTRUCTIONS`** in `electron/mcp/server.ts` with a line:
```
- Mission orchestration — mission_create/status/list/plan/dispatch/await/resolve/log/pause/resume/stop/finish: run a durable, on-disk mission where you (or another Conductor session) decompose a goal, dispatch worker sessions, review results, and commit — surviving context/usage limits. If spawned as a Conductor, call mission_status first to load state and continue.
```

- [ ] **Step 3: Build** — `npx electron-vite build` → BUILD SUCCESS.

- [ ] **Step 4: Full test run** — `npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md electron/mcp/server.ts
git commit -m "docs: document Mission orchestration tools + Conductor protocol"
```

---

## Self-Review

**Spec coverage:** Mission data model → Task 2; durable persistence → Task 2; plan/decompose → Task 3; dispatch/await workers → Task 4; resolve + completion/block → Task 5; MCP tools → Task 6; Supervisor conductor respawn → Task 7; stalled-worker watchdog → Task 8; usage-limit pause/auto-resume → Task 9; retire overnight-run.sh → Task 10; dashboard panel → Task 11; Start/Stop/Pause UI + autonomy → Task 12; docs → Task 13. Autonomy *gates* (form prompts at checkpoints) are surfaced to the Conductor via the seed prompt + `autonomy` field; the Conductor enforces them with `show_form` — no extra service code needed (the field is persisted in Task 2). ConfigService/settings is explicitly out of this plan (separate follow-up, per spec's "Related, separate work").

**Placeholder scan:** No TBD/TODO. The two conditional notes (NotificationService.show name; `await` method-name reserved-word fallback) are explicit verification instructions, not placeholders.

**Type consistency:** `SessionDriver` methods match `SessionService` signatures (create/write/waitForIdle/getActivity/getOutput/kill). `Mission`/`MissionTask`/`MissionWorker`/`MissionEvent` field names are used consistently across service, tools, and panel. Method names stable: `create/get/list/status/plan/dispatch/await/resolve/logEvent/pause/resume/stop/finish/start/tick/stopTimer`. Tool param names (`mission_id`, `task_id`) consistent across all 12 tools.

**Note on `await` as a method name:** valid as a property/method identifier in TS; only reserved as an operator. If the bundler errors, rename the method and the `mission_await` handler call to `awaitWorker` (single rename, no other refs).
