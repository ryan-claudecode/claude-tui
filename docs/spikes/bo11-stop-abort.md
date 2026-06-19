# BO-11 (CAPP-50) — "Stop truly stops": abort behavior of `claude -p --resume` (LIVE)

Base commit: `2c5e6b3` (main). Branch: `bo11-stop-truly-stops`.

BO-10 shipped a Stop handbrake = **kill the headless `claude -p` proc + respawn with
`--resume`**. Two compounding bugs were reported (CAPP-50):

- **Bug A (CRITICAL / safety):** the kill drops the aborted turn from the LIVE proc but
  does not necessarily CLOSE it in the on-disk transcript. A turn parked on a tool
  permission leaves a **half-open tool_use** (a `tool_use` with no `tool_result`). The
  respawned `--resume` proc can then **re-attempt** that tool — completing an unwanted
  file write — when the conversation next runs, with no new user instruction.
- **Bug B (usability):** a stale `PermissionPrompt` overlay (rendered from the GLOBAL
  request queue, `position:fixed` bottom-right) occludes the active session's composer
  when a dead terminal's card outlives its `permission:resolved` push (e.g. a Stop
  racing a Ctrl+K).

This doc records STEP-1 **live experimentation** against real `claude -p` **2.1.170**
that determined the fix, then summarizes what shipped.

## Harness

`electron/services/bo11Live.test.ts` (permanent) + two throwaway scratch suites
(`bo11Experiment*.test.ts`, removed after capture). All wire the **real**
`TerminalService` + **real** `SessionService` + **real** MCP `approve_tool` gate like
`ipc.ts`, flip the structured engine on, and drive a from-scratch headless session.
Gated `describe.runIf(BO11_LIVE)` — `npm test` SKIPS them (hermetic). Run with:

```
$env:BO11_LIVE=1; npx vitest run electron/services/bo11Live.test.ts
```

## Finding 0 (the one that reframed everything): headless `claude -p` is DORMANT until stdin

`claude -p --input-format stream-json` emits **nothing** until it receives a user
message on stdin (already noted for the fresh-spawn case in the BO-4a spike; confirmed
here for the **resumed** case too). Consequences:

- A respawned `--resume` proc that is sent **no input** produces **zero** stream events
  and writes **no** files — it just waits. EXP-3 proved this starkly: a turn that had
  already streamed **37 assistant deltas** produced **0 deltas / 0 results** after
  kill→resume with no follow-up message.
- Therefore the **"no-input quiescent" assertion is trivially true regardless of the
  bug**. BO-10's live test asserted the write-target absent only in that dormant window
  (a 3 s sleep *before* sending its turn-3 recall) and never re-checked afterward — so
  it could not have caught a replay even if one occurred. **That is the masking gap.**
- Bug A can only surface when the **next user message** boots the resumed proc on a
  half-open transcript. So the real test must send a **neutral, non-redirecting**
  follow-up and re-check.

| EXP | Setup | Result |
|-----|-------|--------|
| EXP-1 | park on Write → CURRENT kill+resume → **no input** → wait 35 s | file **absent**; resumed stream **empty** (dormant) |
| EXP-3 | generating turn (37 deltas) → kill+resume → **no input** → wait 35 s | **no** regeneration; resumed stream **empty** (dormant) |

## Finding 1 (the answer to ticket Q1): the replay is timing-dependent, not deterministic-in-harness

EXP-A: park on Write → **CURRENT** kill+resume → a **neutral** follow-up
(*"What is 2 plus 2?"*) → wait.

```
[EXP-A] CURRENT — file written: false | Write re-gated on resume: false
        resumed kinds: user_message,init,assistant_delta,unknown,result
        resumed answer: 4
```

The current code **landed clean** here. Why: `TerminalService.kill()` does
`proc.kill()` **then** `rejectPendingPermissions(... "agent-exited")`. The powershell
wrapper is killed, but the `claude.exe` grandchild lingers briefly with its
`approve_tool` MCP HTTP call still open, so the orphan-deny **reaches it in time**,
Claude writes the denial `tool_result`, and the turn closes on disk → the resume is
clean. **But this is a race** (kill-before-deny). Under teardown pressure — a Stop
racing a Ctrl+K, which tears down MCP routing and the proc together (the dogfooding
repro) — the deny can fail to reach the dying proc, leaving the tool_use half-open →
replay on the next message. The harness wins the race; real interactive teardown can
lose it. **Conclusion: the bug is real but order-/timing-dependent; the robust fix is
to stop depending on that timing.**

## Finding 2 (the answer to ticket Q2): deny THROUGH the live proc + drain-to-result is deterministically clean

EXP-2 / EXP-B: park on Write → settle the permission as a **DENY through the still-LIVE
proc** (`resolvePermission(deny, message)`) → **drain to the `result`** event → THEN
kill + `--resume`.

EXP-2 (the original terminal's events show the turn CLOSING after the deny):

```
[EXP-2] after deny, drained kinds: …,tool_use,tool_result,assistant_delta,assistant_delta,result
[EXP-2] file written after deny-drain-resume: false (want false)
[EXP-2] recall on resumed terminal: 42
```

EXP-B (deny-drain-resume, THEN the neutral follow-up that boots the resumed proc):

```
[EXP-B] APPROACH A — file written: false (want false) | Write re-gated: false (want false)
        neutral answer: 4
        resumed kinds: user_message,init,assistant_delta,unknown,result
```

So denying through the live proc makes Claude write the denial `tool_result` and wind
the turn down to a `result` **before any kill** — the transcript carries a **CLOSED**
turn, the resume is idle, the neutral follow-up is answered normally, the file is never
written, and **the conversation survives** (recall `42`). Claude did **not** re-plan or
retry the Write after an explicit deny carrying *"the user interrupted this action; do
not retry it."*

## Finding 3 (the answer to ticket Q3): a pure generating turn has no in-band abort, and needs none

On Windows the headless proc is `child_process.spawn` of `powershell.exe … claude -p`,
and `child.kill(signal)` is always `TerminateProcess` (no real POSIX signals), so
there is **no SIGINT-style turn-abort**; stdin-close is not exposed either. But a pure
generating turn (no tool call yet) has **no half-open tool_use** to replay, and EXP-3
shows kill+resume lands **dormant/idle** with no regeneration absent input. Its
(unanswered) request being completed on a later turn is benign — no file side-effect —
so the generating case goes **straight to kill+resume**, unchanged.

## Decision — implemented approach (a)

> **When the turn is parked on a permission:** settle it as an abort **DENY through the
> LIVE proc** and **drain to `result`** (closing the turn on disk) **before** kill +
> `--resume`. **Otherwise** (a generating turn): kill + `--resume` directly.

Chosen over the interim mitigation (c) (inject a steering message after respawn) because
(a) is deterministic, keeps the agent **idle on a clean transcript** (no synthetic user
turn), and the acceptance explicitly wants the file absent **without a redirecting
message**. (b) (a generating-turn signal abort) is infeasible on Windows headless and
unnecessary (no half-open tool_use).

### What shipped

- **`TerminalService.abortPendingPermissionAndDrain(id, message, timeoutMs=30_000)`**
  (`terminals.ts`) — denies the pending permission(s) through the live proc
  (`denyPendingFor` → `resolvePermission`, delivered over the still-open `approve_tool`
  MCP call), subscribes to the terminal's stream events, and polls until a `result`
  drains (re-denying any retry the agent parks on) or the guard elapses. Returns
  whether a result was drained; a timeout falls back to the bare kill (never worse than
  before).
- **`SessionService.interruptAgent`** is now `async`: when
  `terminals.hasPendingPermission(ref.id)` it `await`s `abortPendingPermissionAndDrain`
  with `INTERRUPT_ABORT_MESSAGE` **before** `respawnHeadlessRef` (the unchanged
  kill+`--resume`). The IPC handler (`agent:interrupt`) already returns the promise; the
  renderer's `interruptAgent` invoke already awaits.
- **Bug B (renderer):** `App.tsx` renders `PermissionPrompt` from
  `permissionRequests.filter(r => r.terminalId === activeTerminalId)` (never the global
  queue); `isTerminalBusy` still reads the global queue. `usePermissions(liveTerminalIds)`
  prunes orphaned requests (`pruneOrphanedRequests`) when the live terminal-id set
  changes, self-healing a missed `permission:resolved`. `.permission-overlay` is
  `pointer-events:none` with `.permission-card` `pointer-events:auto` (click-through
  defense-in-depth).

### Gates

- `npm test` — full hermetic suite green (live suites skipped). Added: 3 SessionService
  interrupt tests (abort-drain ordering, generating-turn straight-to-kill, async no-ops),
  3 `abortPendingPermissionAndDrain` tests, 4 `pruneOrphanedRequests` tests.
- `npm run build` — green. `npm run e2e` — green (defaults to xterm).
- `BO11_LIVE=1 … bo11Live.test.ts` — **green**: after Stop on a permission-parked turn,
  a neutral follow-up boots the resumed proc and the write-target stays **absent**, the
  Write is **not** re-gated, the neutral question is answered, and the anchor recall
  survives. `bo10Live.test.ts` updated (await + the masking-gap re-check after turn 3).

### Still unproven / residual

- The harness could **not** force the original deterministic file-write replay (the
  current kill-time deny won the race in 2/2 EXP-A runs). The fix is justified by
  removing the *race*, proven cleanly by EXP-2/EXP-B, not by a red EXP-A. The
  Ctrl+K-racing-Stop teardown path that loses the race in dogfooding is hard to make
  deterministic in a unit harness.
- The generating-turn case relies on "no half-open tool_use ⇒ nothing to replay." A
  turn killed in the narrow window *after deciding to call a tool but before the
  `tool_use`/permission lands* has no permission to deny; it falls to plain kill+resume
  and the request may be completed on a later turn. Not observed; flagged for follow-up
  if it bites.
