# ClaudeTUI Orchestration Layer — Design Spec

**Date:** 2026-06-04
**Status:** Active

## Overview

A layer above the TUI where Claude *sees and orchestrates* other Claude sessions to pursue a long-running goal — including improving ClaudeTUI's own codebase ("the app builds itself"). The defining requirement: orchestration state lives **on disk, not in a Claude context window**, so a mission survives context limits, usage limits, and full app/PC restarts. This retires the out-of-app `scripts/overnight-run.sh` by moving its job (drive Claude calls, check in, wait out token-limit windows, restart) into the app, with a Claude conductor providing the intelligence instead of a shell script.

## Core principle: code guarantees continuity, Claude provides intelligence

The system splits into a durable half (code) and an intelligent half (Claude), with a clean boundary:

- The **Mission** is durable memory. A plain JSON record of a long-running effort. Not smart.
- The **Conductor** is intelligence. A normal Claude session that reads the Mission, decides what to do next, dispatches workers, reviews results, and writes outcomes back. The brain is Claude; the Mission is its notebook.
- Because Claude itself hits context and usage limits, a code-level **Supervisor** guarantees a live Conductor always exists for a running mission. It is *not* the brain — it just ensures a brain is alive and resumes after outages.

Any fresh Conductor can pick up an in-flight Mission and continue, because everything it needs to resume is on disk. No handoffs; no ballooning context even on focused long-running work.

## Roles

| Role | Who | Job |
|------|-----|-----|
| **Mission** | code — durable JSON on disk | The notebook: goal, tasks, workers, event log. Not smart. |
| **Supervisor** | code — main-process loop | Continuity guarantee: ensure a live Conductor exists, respawn it after death/context/usage limits, auto-resume after a token-limit window, watchdog stalled workers. Minimal logic. |
| **Conductor** | a Claude session | The brain: read the Mission, decide next steps, dispatch workers, review results, commit. |
| **Workers** | Claude sessions | Do one scoped task, go idle, get reviewed. |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Conductor Claude (a session)        Workers (sessions)   │
│   reads mission_status                do one scoped task   │
│   plans / dispatches / reviews        go idle → reviewed   │
│   can die + resume from disk                               │
├──────────────────────────────────────────────────────────┤
│  MCP Tool Handlers (electron/mcp/tools.ts)                │
│   mission_* tools — thin wrappers over MissionService     │
├──────────────────────────────────────────────────────────┤
│  MissionService (electron/services/mission.ts)            │
│   • durable state + persistence (~/.claude-tui/missions/) │
│   • CRUD + state transitions                              │
│   • Supervisor loop (interval tick, like idle monitor)    │
│        ├─ ensure/respawn Conductor for running missions   │
│        ├─ stalled-worker watchdog (via getActivity)       │
│        └─ usage-limit pause + resumeAt auto-resume        │
├──────────────────────────────────────────────────────────┤
│  Reused as-is:                                            │
│   SessionService.create / waitForIdle / getActivity /     │
│   getOutput · git_* / file_* MCP tools · panel system ·   │
│   NotificationService.notify                              │
└──────────────────────────────────────────────────────────┘
```

`MissionService` follows the existing service-layer pattern: it is the source of truth; IPC handlers and MCP tools are thin wrappers. The Supervisor runs as an internal interval inside `MissionService`, mirroring `SessionService.startIdleMonitor`.

## Data model

Persisted to `~/.claude-tui/missions/<id>.json` (one file per mission). Written on every state change.

```ts
interface Mission {
  id: string
  goal: string                  // north star, e.g. a self-improvement directive
  cwd: string                   // repo the mission operates on
  autonomy: "hands-off" | "checkpoints" | "supervised"
  status: "planning" | "running" | "paused" | "blocked" | "done" | "stopped"
  conductorSessionId?: string   // the live brain, if any
  resumeAt?: number             // epoch ms — set when paused for a usage limit
  tasks: MissionTask[]
  workers: MissionWorker[]      // active worker registry
  eventLog: MissionEvent[]      // append-only audit trail
  createdAt: number
  updatedAt: number
}

interface MissionTask {
  id: string
  title: string
  detail?: string
  status: "pending" | "assigned" | "in-progress" | "review" | "done" | "failed"
  assignedTo?: string           // worker sessionId
  result?: string               // conductor's review note / outcome
  attempts: number
}

interface MissionWorker {
  sessionId: string
  role?: string
  currentTaskId?: string
}

interface MissionEvent {
  time: number
  kind: "info" | "task" | "worker" | "review" | "commit" | "pause" | "error"
  text: string
}
```

## Conductor working loop (prompt-driven, via MCP tools)

The Supervisor spawns the Conductor with a seed prompt: *"You are the conductor for mission `<id>`. Call `mission_status` to load state, then continue the loop."* The loop:

1. `mission_status` — load durable state. **This is the resume entry point** for any fresh Conductor.
2. If `planning`: decompose the goal into tasks → `mission_plan(tasks[])`, flip status to `running`.
3. Pick the next `pending` task. If an autonomy gate applies (see below), `show_form` to ask the user first.
4. `mission_dispatch(taskId, prompt)` — spawn or reuse a worker session in `cwd`, inject the task prompt, mark the task `in-progress`. (Implemented via `SessionService.create()` + `waitForIdle({ input })`.) Returns the worker `sessionId`.
5. `mission_await(taskId)` — block until that worker goes idle, return its recent output. (Wraps `SessionService.waitForIdle`.)
6. Review the output → `mission_resolve(taskId, "done" | "failed", result)`. If a unit of work is complete, commit via the existing `git_*` tools (gated by autonomy).
7. Loop to step 1. The Conductor may stop at any point (e.g. its own context is filling) — the Supervisor respawns a fresh Conductor that resumes from `mission_status`.
8. When all tasks are `done` → `mission_finish`.

Workers stay "dumb": each does one scoped task and reports back. Only the Conductor holds the big picture, and the big picture is on disk.

## Supervisor loop (code, ~5s tick)

Mirrors `SessionService.startIdleMonitor`. On each tick, for each mission:

- **`running` with no live Conductor** (none set, or its session is dead) → spawn a fresh Conductor in `cwd` with the seed prompt.
- **Stalled worker** — a worker idle/silent beyond a threshold while still holding an `in-progress` task (detected via `SessionService.getActivity()`) → kill it and clear its task assignment so the Conductor re-dispatches. (Per-task version of the watchdog already added to `overnight-run.sh`.)
- **Usage limit detected** → mission → `paused`, set `resumeAt`. Detection is two-pronged: (a) passive scan of session output buffers for the usage-limit signature (reuse/extend the runner's grep), as a safety net; (b) a `mission_pause(resumeAt?)` tool the Conductor calls when it notices. If the limit message includes a reset time, parse it; otherwise use a configurable backoff (default 1 hour).
- **`paused` with `resumeAt <= now`** → flip to `running`; the next tick respawns the Conductor. This is the "wait out the token window, then start back up" behavior, fully in-app.
- **All remaining tasks `failed`/blocked** → status `blocked` + `notify` the user.

## MCP tools (new)

Thin wrappers over `MissionService`. ~12 tools, several tiny:

| Tool | Purpose |
|------|---------|
| `mission_create(goal, cwd?, autonomy?)` | Start a mission (status `planning`); Supervisor spawns the Conductor. |
| `mission_status(missionId?)` | Full durable state — the resume entry point. Defaults to the most recently updated non-terminal (`planning`/`running`/`paused`/`blocked`) mission when `missionId` is omitted. |
| `mission_list()` | All missions with status summaries. |
| `mission_plan(missionId, tasks[])` | Add/replace the task list during planning. |
| `mission_dispatch(missionId, taskId, prompt)` | Spawn/reuse a worker, inject the prompt, mark `in-progress`; returns `sessionId`. |
| `mission_await(missionId, taskId, timeoutMs?)` | Block until the worker idles; return recent output. |
| `mission_resolve(missionId, taskId, status, result)` | Record review outcome (`done`/`failed`). |
| `mission_log(missionId, kind, text)` | Append an event to the audit trail. |
| `mission_pause(missionId, resumeAt?)` | Pause (e.g. on usage limit). |
| `mission_resume(missionId)` | Resume immediately. |
| `mission_stop(missionId)` | User stop — terminate the mission and its workers. |
| `mission_finish(missionId)` | Mark `done`. |

## Autonomy gates

A mission's `autonomy` field controls how hands-on the user is:

- **hands-off** (default) — Conductor runs to completion without pausing for approval.
- **checkpoints** — Conductor pauses (via `show_form`) at key gates: plan ready, and before each commit/push.
- **supervised** — Conductor pauses for approval before dispatching each task.

The "Start Mission…" UI form asks the goal and the autonomy level (defaulting to hands-off). The user can **always** Stop or Pause a mission from the dashboard regardless of autonomy.

## UI — Mission dashboard panel

A new panel composing existing panel pieces:

- Header: goal, status, autonomy (`stat` cards).
- Task board: `kanban`/`progress` view of `tasks` by status.
- Worker list: active workers with live activity dots (driven by `session:state` events already emitted).
- Event log: `timeline`/`log` view of `eventLog`.
- Controls: **Stop** and **Pause** buttons.

Plus a command-palette **"Start Mission…"** entry → the autonomy form. Missions can also be started purely via the `mission_create` MCP tool.

## Error handling

- Worker timeout → Conductor retries (`attempts++`) or marks the task `failed` and decides.
- Worker death → Supervisor clears the assignment; Conductor re-dispatches or marks failed.
- Conductor death → Supervisor respawns from durable state.
- Build/test failure → Conductor observes it via `run_build`/`git_*` tools and queues a fix task.
- Usage limit → pause + `resumeAt` + auto-resume.
- All remaining tasks failed/blocked → status `blocked` + user notification.

## Testing

- **`MissionService` unit tests (no Claude required)** — it is pure state + persistence. Cover: create → plan → dispatch (mock session) → await → resolve → finish; pause/resume timing; Supervisor respawn decision logic; usage-limit pause/`resumeAt` math; persistence round-trip (write → reload).
- **Build/UI** — `run_build` for type/compile safety; `get_app_state` + `take_screenshot` to validate the dashboard renders.
- **End-to-end** — one real dry-run mission against a small scratch goal to validate the full conductor/worker/supervisor loop.

## Build phases

One cohesive feature with internal phases (the implementation plan will break these out):

1. **Mission spine** — `MissionService` (state + persistence + CRUD) + core MCP tools (`mission_create`/`status`/`list`/`plan`/`dispatch`/`await`/`resolve`/`log`/`finish`). Conductor driven manually (no auto-respawn yet). Unit-tested.
2. **Supervisor** — auto-spawn/respawn Conductor + stalled-worker watchdog.
3. **Token-limit resilience** — usage-limit detection + `pause`/auto-resume after backoff. Retires `scripts/overnight-run.sh`.
4. **Dashboard + controls** — Mission panel, Start/Stop/Pause UI, autonomy form.

## Related, separate work

**ConfigService + `set_config` + settings UI** (pre-approved) is a small, independent build that slots in around Phase 4, since orchestration defaults — default autonomy, usage-limit backoff duration — naturally live in config. Not part of this spec's core, but noted because the two meet at the config surface.

## Reuse vs. new

- **New:** `electron/services/mission.ts` (state, persistence, Supervisor loop), ~12 `mission_*` MCP tools, a Mission dashboard panel component + `"mission"` panel type, a "Start Mission…" command-palette entry/form, IPC handlers for UI-initiated start/stop/pause.
- **Reuse as-is:** `SessionService.create` / `waitForIdle` / `getActivity` / `getOutput`, the `git_*` and file MCP tools, the watchdog pattern, the panel system, `NotificationService.notify`, `show_form`.
