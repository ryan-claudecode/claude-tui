# ST-1 — Session timeline (durable event log + render)

- **Phase:** 2 · **Depends on:** — · **Worktree: yes** · **Model: Opus** · **Size:** M
- **Why** ([identity](../00-identity.md), continuity pillar): a work session accumulates a
  life — terminals spawned, notes pinned, findings corrected, summaries refreshed,
  handoffs — but only *current state* is queryable. A reviewable timeline answers "what
  did my agents do while I was away?", the core overnight-missions use case. Today no
  event history is captured; this item adds it.

## Current state (verified 2026-06-13)

- `electron/services/sessions.ts` — `WorkSession` has `notes: Note[]` (each `createdAt`),
  `summary` (no history), `terminals: TerminalRef[]` (no spawn timestamps), `createdAt`,
  `updatedAt`. NO event log. Lifecycle methods to hook: `spawnInto` (spawn), terminal
  kill/retire, the handoff path, `addNote` (note + correction when `corrects` set),
  `setSummary` (summary), the idle-flush. (Grep these in the file — names verified to
  exist: `spawnInto`, `addNote`, `setSummary`, handoff/retire logic.)
- A `timeline` panel type ALREADY EXISTS — find `src/components/panels/TimelinePanel.tsx`
  and MATCH its existing props shape (do not invent a new one). `show_panel` already
  accepts `type: "timeline"`.
- Versioned persistence (`electron/persist.ts`): an additive OPTIONAL array field needs NO
  schema-version bump (the P0-4 pattern — older files load fine, field defaults empty).
- The sidebar session row has a ⊕ overview affordance (opens `getOverview` panel); the
  overview panel type is `session-overview`.

## Scope

1. **Durable event log.** Add `eventLog?: SessionEvent[]` to `WorkSession` where
   `SessionEvent = { time: number; kind: "spawn"|"retire"|"handoff"|"note"|"correction"|"summary"|"idle-flush"; text: string; terminalId?: string }`.
   Append one event at each lifecycle point listed above (persist routes through the
   existing `persist()`; cap the log at ~500 like mission `eventLog` does). Keep events
   terse and human-readable (e.g. `Spawned terminal "auth-fix"`, `Note: root cause is X`,
   `Corrected an earlier note`, `Summary refreshed`).
2. **`getSessionTimeline(sessionId): SessionEvent[]`** — returns the log sorted by time.
   For sessions that predate this feature (empty log), BACKFILL a best-effort timeline
   from existing data: session `createdAt` as a "created" event + each note's `createdAt`
   + corrections from superseded notes. So old sessions still show something.
3. **MCP tool** `session_timeline` (in `electron/mcp/tools/worksessions.ts`): loads
   `getSessionTimeline` and renders it via the existing `timeline` panel
   (`PanelService.show("timeline", <props matching TimelinePanel>)`). Defaults to the
   caller's identity session like the other work-session tools. One SERVER_INSTRUCTIONS line.
4. **UI affordance.** Add a small "timeline" button next to the ⊕ overview button on the
   sidebar session row (`Sidebar.tsx`), wired through preload→IPC→`getSessionTimeline`→
   show the timeline panel. Match the existing ⊕ button's style/pattern exactly.

## Non-goals

- No new panel type (reuse `timeline`). No worktree/mission/attention changes. No summary
  *diffing* (just "summary refreshed" events). No live-streaming (panel is a snapshot;
  reopen to refresh — acceptable for v1).

## Acceptance criteria

- `sessions.test.ts`: events appended at spawn/note/correction/summary/retire/handoff;
  `getSessionTimeline` returns them sorted; backfill produces events for a log-less
  session built from notes; cap holds; a legacy (no-eventLog) persisted session loads
  (versioned-loader regression).
- `npm run build` + `npm test` green (203 baseline stays green).
- Commit only: `electron/services/sessions.ts`, `electron/services/sessions.test.ts`,
  `electron/mcp/tools/worksessions.ts`, `electron/mcp/server.ts` (instructions line),
  `electron/preload.ts`, `electron/ipc/worksession-handlers.ts` (or wherever worksession
  IPC lives — verify), `src/App.tsx` (Window.api type + handler), `src/components/Sidebar.tsx`.

## Mandatory base check (stale-base quirk recurs)

Before editing: `git rev-parse HEAD` vs `git rev-parse main`; if different
`git reset --hard main`; confirm HEAD ≥ `471df08` and `npm test` = 14 files / 203 tests
BEFORE changing anything. Stop and report if wrong.

## Safety

Never kill a process you didn't launch+record. Don't launch the app or claude CLI.
