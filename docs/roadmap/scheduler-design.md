# On-Device Scheduling — design

> Owner ask (2026-07-01): "very important functionality — scheduling. Claude's own scheduling
> runs in a cloud which disables a lot of what Claude Code can do natively on the machine. My
> fable-watch script proved the shape: every 20m between 8am–10pm, spin up a claude terminal
> that checks the web for Fable status and files a GitHub issue when it returns. I want to set
> recurring or one-shot scheduled tasks that run ON THE DEVICE at the set time, and view active
> scheduled/recurring claude programs."

## Identity fit

Straight moat by the decision filter (`00-identity.md`): scheduling makes agent work **durable
in time** — work fires without a human present, results accumulate in the durable session
container, and the schedule itself outlives every terminal. It is continuity (pillar 2) extended
along the clock axis, and it composes with orchestration (pillar 3): the Supervisor guarantees a
live Conductor; the Scheduler guarantees work *starts*. The on-device property is the
differentiation vs Claude's own cloud scheduling: a scheduled run here has the machine — local
filesystem, local git, local MCP servers, the user's auth, and this app's own MCP surface.

## Reference scenario (acceptance)

The fable-watch script must be expressible as one schedule:
- every 20 minutes, only between 08:00 and 22:00 local, all days
- prompt: "check the web for Fable 5 availability; if it returned, create a GitHub issue …"
- runs headless on this machine, needs web + `gh` + the user's auth — all present because it's
  a normal structured terminal spawn
- the user can see it in the sidebar (next run, last result), pause it, run it now, delete it.

## Data model

One file per schedule: `~/.claude-tui/schedules/<id>.json` (same pattern as missions/sessions,
via `persist.ts` `loadVersioned`/`saveVersioned`).

```ts
interface Schedule {
  id: string                        // uuid
  name: string                      // "Fable watch"
  prompt: string                    // seeded into the spawned terminal
  cwd?: string                      // spawn dir (defaults: workspace folder → home)
  workspaceId?: string              // scoping + sidebar filtering (undefined = All)
  recurrence: Recurrence
  enabled: boolean
  model?: string                    // per-run spawn opts (default config defaults)
  effort?: string
  ultracode?: boolean
  catchUp: boolean                  // missed while app closed → run ONCE at launch (default false)
  keepTerminal: boolean             // false (default) = retire the run terminal when it goes idle-done
  runHistory: RunRecord[]           // capped ring, newest first (RUN_HISTORY_MAX = 50)
  nextRunAt: string | null          // derived + persisted for display; null = exhausted one-shot
  createdAt: string
}

type Recurrence =
  | { kind: "interval"; everyMinutes: number;          // fable-watch shape
      window?: { start: string; end: string };         // "08:00".."22:00" local, inclusive-start
      days?: number[] }                                // 0-6 (Sun-Sat), absent = every day
  | { kind: "daily"; at: string; days?: number[] }     // "HH:mm" local
  | { kind: "once"; at: string }                       // ISO datetime; fires once then nextRunAt=null

interface RunRecord {
  at: string
  status: "ok" | "error" | "timeout" | "skipped-overlap" | "skipped-missed" | "killed"
  durationMs?: number
  sessionId?: string
  terminalId?: string
  note?: string                     // last assistant summary line / error excerpt
}
```

## Pure math core — `electron/services/scheduleMath.ts`

Node-testable, zero Electron imports (the `sessionRow.ts`/`companionPlacement.ts` pattern).

- `computeNextRun(recurrence, from: Date): Date | null` — the single source of truth for
  "when does this fire next". Handles: interval stepping anchored to the last fire (not wall-clock
  minute-0), window clipping (a fire landing outside `window` rolls to the next window start),
  `days` filtering, `once` in the past → null. All local time (the user thinks in local; DST
  jumps resolve to "next valid local time", tested).
- `isDue(schedule, now): boolean` and `describeNext(schedule, now): string` ("in 14m", "tomorrow
  08:00") — the row-renderer helper lives beside the math so the countdown can't drift from the
  ticker.

## SchedulerService — `electron/services/scheduler.ts`

Mirrors the Supervisor shape (`mission.ts`): constructor loads all schedules into a Map;
`start()` sets one `setInterval(() => this.tick(), 30_000)`; every mutation goes through
`persist()` which emits one `schedule:updated` event (renderer push, same seam as
`mission:updated`).

`tick()`:
1. For each enabled schedule with `nextRunAt <= now`:
   - **Overlap guard** — if the schedule's previous run terminal is still alive (tracked
     `runningTerminalId`, checked against `terminals.list()`), record `skipped-overlap`,
     advance `nextRunAt`, do NOT stack a second run.
   - **Concurrency cap** — at most `MAX_CONCURRENT_SCHEDULED = 2` scheduler-initiated runs
     machine-wide; over cap → stay due, retry next tick (30s), so due schedules queue rather
     than thundering-herd a laptop.
   - Otherwise `fire(schedule)`.
2. Launch catch-up (once, in `start()`): a schedule whose `nextRunAt` passed while the app was
   closed either records `skipped-missed` (default) or, if `catchUp`, fires exactly ONE
   catch-up run — never one per missed slot. Then re-derive `nextRunAt` from `now`.

`fire(schedule)`:
- Ensure the schedule's durable **work session** exists (one per schedule, named after it,
  `workspaceId` honored; created lazily via `SessionService`); every run spawns a fresh
  structured terminal INTO that session, so runs inherit the context primer + accumulate
  findings in one container instead of spamming session rows.
- Spawn structured (headless) with the schedule's model/effort/ultracode, then deliver
  `prompt` via `TerminalService.sendAgentMessage` (the BO-3 stdin sink — no PTY write+delay
  guess like templates.ts).
- Watch for completion: terminal `result` event or exit → RunRecord `ok`/`error`; a
  `maxRuntimeMs` guard (default 30 min) kills a hung run → `timeout` (reuses the reaper idiom;
  kills ONLY the terminal id it spawned — never inferred processes).
- `keepTerminal:false` (default): retire the run terminal after recording, keeping the session
  container + its knowledge. `true`: leave it open for inspection.
- A run that ends `error`/`timeout` raises a tier-2 attention entry attributed to the
  schedule's session (existing AttentionService seam). Anything richer (toasts, GitHub issues)
  the *spawned Claude* does itself with its native tools — that's the whole point of on-device.

## Surfaces

- **IPC** (`ipc/schedule-handlers.ts`): `schedule:create/list/update/delete/run-now/history`,
  push `schedule:updated` to the main window. Preload accessors on `window.api`.
- **MCP tools** (`electron/mcp/tools/schedules.ts`): `schedule_create`, `schedule_list`,
  `schedule_update` (incl. enable/disable), `schedule_delete`, `schedule_run_now`,
  `schedule_history`. Identity-bound like every other tool group: `workspaceId` defaults to the
  caller's OWNING session's workspace, never `getActiveId`. This is the "hey, watch X for me
  every 20 minutes" path — the agent authors the schedule.
- **Sidebar** — `SCHEDULED (n)` section (the MS-2 MissionsList pattern), between MISSIONS and
  WORKSPACES, absent when empty. Two-line rows: name + enabled/paused chip; `next in 14m ·
  last ok 13:40` with a status-tinted dot. Statically visible per-row controls (NO
  hover-reveal): ⏸/▶ toggle, ▶▶ run-now. Header `+` opens a renderer-local create/edit modal
  (clone the MissionPrompt overlay — NOT PanelService `show_form`, which is agent-driven and
  holds MCP promises). Row click opens the `schedule` detail panel.
- **Detail panel** — new `schedule` panel type in the shared `PanelContent` (renders in the
  ModalHost by default, pop-out like everything else): recurrence summary, next run, full run
  history with per-run status/duration/note, buttons Edit / Enable-Disable / Run now / Delete.
- **useSchedules hook** — seeds via `listSchedules()`, upserts on `schedule:updated` push; no
  polling. Countdown text re-derives on a 30s renderer interval from `nextRunAt`.

## Safety / policy

- Scheduler only fires while the app is running — by design (on-device is the feature; the
  cloud alternative exists for the always-on case). Missed-fire policy above makes the
  app-was-closed window explicit rather than surprising.
- Unattended runs use the same dev permission posture as every structured spawn
  (`permissions.skipApproval` default-skip). CAPP-57 (perms re-approach) already gates any
  public release; scheduled runs add no new exposure class beyond what missions already do,
  but the CAPP-57 work must cover them.
- Kill guard: the timeout reaper kills only the terminal id the scheduler spawned and recorded.
- `schedule_create` from an agent is allowed (it's the killer use case) but every schedule is
  visible in the sidebar the moment it exists — no invisible recurring agents.

## Phasing

- **SCHED-1 (core, one dispatch):** `scheduleMath.ts` + tests (window/days/DST/once/anchor
  cases); `SchedulerService` (persist, tick, overlap guard, cap, catch-up, fire via fake-able
  `deps`, run records, timeout reaper) + tests with FakeTerminals/FakeSessions; IPC + preload;
  MCP tool group + `SERVER_INSTRUCTIONS` line; sidebar section + create/edit overlay + run-now;
  `schedule:updated` push + `useSchedules`. Gate: npm test + build + e2e (new spec: create a
  schedule via the overlay → row renders with countdown; run-now on a fake fires the spawn seam).
- **SCHED-2 (detail + polish):** the `schedule` detail panel (history view), edit round-trip
  polish, per-run note capture from the stream (last assistant line), richer `describeNext`
  strings, config `scheduler.maxConcurrent`.

Deferred deliberately: cron-string syntax (the three recurrence kinds cover the real cases;
add `kind:"cron"` later without a schema break), OS-level scheduling while the app is closed
(Task Scheduler integration — a different product decision), and any cloud handoff.
