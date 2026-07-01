# Identity check-in — 2026-07-01

> Light-depth alignment pass against `00-identity.md` (owner-requested; not a re-derivation of
> the identity — a "are we still on track" audit of the work since the last deep analysis).

## Verdict

**On track.** The three pillars are all visibly deeper than at the last check, the kill-list is
holding, and the two big "substrate" investments of the period (the headless/structured engine
cutover, the panel→modal rework) both cash out as *enablers of the lead pillar* rather than
detours. Two watch items, one of which got more urgent this week.

## Pillar-by-pillar

**1. Agent-rendered UI (lead pillar)** — meaningfully advanced. The panel→modal rework
(CAPP-105..112) moved agent-rendered panels INTO the main window (modal-by-default, pop-out
kept), which makes the bidirectional surface something the user actually lives in rather than a
second window they ignore; the per-block expand buttons keep the chat→detail path explicit. The
Agent Rail exists; the attention queue routes focus. Backlog is correctly pointed at the two
open gaps: CAPP-104 (agents authoring durable action buttons — the rail becoming a two-way
surface) and CAPP-107 (native AskUserQuestion never renders in-app — a real bidirectionality
hole the owner personally hit; it now has a modal host to land in and should be scheduled soon).

**2. Continuity (durability spine)** — the strongest period on record: the whole workspace-memory
arc (CAPP-87..101) built the second durable tier, auto-load, pinning + launch-delta, the
read-only context inspector, portable export + adoption reconcile, plus the local-git data-loss
net (CAPP-95). The context engine is now a genuinely layered brain (session ∪ workspace) with
its own safety net. Nothing in the period contradicts the "work outlives the terminal" thesis.

**3. Orchestration** — steady state, correctly de-prioritized relative to 1+2: missions +
supervisor + worktree review are live; no throughput-chasing features were added (parallelism
stays ceded, per the positioning note).

**New work admitted this week, filtered:** the on-device scheduler (CAPP-114/115, design
`scheduler-design.md`) passes the decision filter cleanly — it is continuity extended along the
time axis (work fires without a human present; results accumulate in the durable container),
and on-device execution is exactly the moat edge vs Claude's own cloud scheduling. Boundary to
hold: it stays *Claude-run* scheduling, not a general cron GUI. The never-stale model picker
(CAPP-113) is acknowledged parity/substrate work — the identity doc names the model picker as
the eroding kind — and is being shipped to good-enough with a config-extensible list precisely
so it stops consuming code changes.

## Kill-list adherence

Holding. No utility-MCP-tool creep this period; the git surface is still read-only; no
IDE/file-tree ambitions surfaced. The retired PanelDrawer (CAPP-112) is the right kind of
deletion.

## Watch items

1. **CAPP-57 (permissions) got MORE urgent.** The identity's quality bar is "no runaway you
   can't stop, no forgeable identity" — and the scheduler introduces *unattended* runs on the
   default dev skip-permissions posture. Still fine for a solo-dev machine, still a hard
   release blocker; the CAPP-57 re-approach must explicitly cover scheduled/missioned runs.
2. **Substrate share of effort.** The last two arcs (BO rebuild → panel rework + picker/
   ultracode/model plumbing) were substrate-heavy. Each was justified (the moat needs the owned
   render surface; dogfooding demanded the modal UX), but per the identity doc this should stay
   the minority — the current queue (scheduler, CAPP-104, CAPP-107) correctly tilts back to
   moat work. Re-check this balance at the next check-in.
3. **Doc drift.** CLAUDE.md's panel sections still describe the companion-only world; being
   fixed today. Source-of-truth drift is a continuity bug in our own process.
