# Feature Audit — 2026-07-04 (proposal, not yet ratified)

> Architect's assessment requested by the owner: "what's working, what's too much, and why
> aren't we just leveraging CLAUDE.md + Claude's native memory?" Grounded in the identity doc
> (`00-identity.md`), the coexistence design, and — decisively — the actual usage data in
> `~/.claude-tui` after ~3 weeks of dogfooding.

## TL;DR

The app is two products fused together:

1. A **multi-agent cockpit** (terminals, structured chat, restore, attention, panels,
   workspaces, dictation) — genuinely used, every day.
2. A **parallel knowledge system** (session notes → promotion → workspace memory → recall →
   inject → export → adoption) — effectively **zero organic writes in three weeks**.

The knowledge system should pivot from "parallel store" to "the best GUI for Claude's *native*
memory," and a long tail of never-used features should be cut or parked.

## The usage evidence (disk truth, 2026-07-04)

| Feature | Investment | Actual use |
|---|---|---|
| Terminals, sessions, restore, handoff, model/effort switching | large | **Real** — daily spawns, interrupts, handoffs, model switches in session event logs |
| Workspaces | medium | **Real** — 5 workspaces, all real projects |
| STT dictation | medium | Model downloaded — real |
| Session notes / summaries | large | **Zero.** Every session ever: `notes: [], summary: ""` |
| Workspace memory | large | **One finding ever** — the owner's "Banana" test, whose own text documents the memory wasn't ambient |
| Missions / worktree review | ~1,000+ lines | **Zero missions ever created** |
| Scheduler, action buttons, layouts, templates, broadcast, exports | ~1,700 lines | **Zero data files on disk for any of them** |
| Agent rail | medium | `"open": false` in config |
| Context inject pipeline | ~600 lines + IPC | Runs every spawn — currently delivers a **176-byte primer advertising an empty store** |

That last row is the whole problem in miniature: a sophisticated pipeline faithfully
injecting nothing.

## Root cause of the context-engine failure (not a polish problem)

The write path depends on the agent *voluntarily* spending tool calls on bookkeeping
(`session_note`, `set_session_summary`) mid-task, prompted only by MCP server instructions
buried among ~100 tools. Agents don't do that; there is no harness-level enforcement, and the
idle-flush nudge demonstrably isn't producing summaries either.

Claude Code's **native auto-memory works** because it's in the system prompt as a first-class
instruction, the harness maintains the index, and the model is trained/prompted into the
habit. It's git-root-keyed, per-project, survives everything, and needs zero cooperation from
this app.

The identity doc predicted this: pillar 2 says *"assume competitors converge here."* The
competitor that converged was Claude Code itself. The doc also warns *"anything that is a UI
over a Claude Code CLI feature erodes as Claude Code improves"* — a parallel memory store is
worse: it's a **replacement** for a Claude Code feature, fighting the grain instead of riding
it.

## Is there an actual argument for the parallel store?

Steelman: workspaces aren't always git repos; structured findings with corrections/ruled-out
have no native analog; an app-owned store enables UI curation. All real distinctions — and
three weeks of evidence says none of them matter in practice. A structured store nobody
writes to loses to a freeform file that gets written. The coexistence layer
(inspector/export/adoption — ~1,600 lines built to reconcile our store with native files) was
already an implicit admission that native is the center of gravity.

**Verdict: leverage the native system.** For durable knowledge, CLAUDE.md + CLAUDE.local.md +
native auto-memory should be the single source of truth.

## Recommended restructuring — three moves

### 1. Pivot the knowledge tier: "parallel store" → "best GUI for Claude's own memory"

- **Keep the Context Inspector** — it already reads the native files; exactly the right
  relationship (READ, never write-compete).
- **Repurpose WorkspaceMemoryPanel** into an editor for the native files themselves:
  CLAUDE.md, CLAUDE.local.md, the auto-memory MEMORY.md. Curating memory in a nice panel is
  real value; owning a rival JSON store is not.
- **Deprecate:** `session_note` / `promote_finding` / `recall` / pinning / launch-delta /
  inject-primer / **export** / **adoption** (the last two exist only to leak our store back to
  native — pointless once native IS the store). Roughly 3–4k lines of services plus their
  IPC/MCP/preload/panel/parity-test scaffolding, and a big chunk of the ~100-tool MCP surface
  every spawned agent pays tokens and attention for.
- **Keep the work-session container itself** — terminal grouping, event log, conversation
  resume. That's the restore backbone and it's genuinely used.

### 2. Cut or park the zero-use tail

- **Missions + worktree review: park, don't delete** — pillar 3 is real but premature; the
  on-disk state format means it can return when there's actual pull.
- **Cut:** action buttons, layouts, templates, broadcast, session timeline.
- **Prune panel types** (heatmap, kanban, stat, progress, timeline…) down to what agents
  actually render: diff, markdown, image, table, form.
- **Scheduler:** two days old, born from a real want (fable-watch) — honest two-week trial;
  if no schedule exists on disk by then, it goes too.
- Every cut also shrinks `SERVER_INSTRUCTIONS` — less noise per agent.

### 3. Double down on what's actually felt

The moat that survives is pillar 1 plus the cockpit substrate: structured chat, the
permission UX (CAPP-57 is the release blocker anyway), `ask_user`/forms, the attention queue,
context meter, restore. These are where the app *adds to* the Claude Code experience instead
of duplicating it.

## Process change to prevent recurrence

Before any new feature, name the **pull signal** — the concrete moment you reached for it and
it wasn't there. Missions, action buttons, and layouts were all push (plausible-sounding),
not pull. The features used daily all came from a felt pain.

## The post-cut thesis, one line

**"The window where many Claude Code sessions live, survive restarts, render UI back at you,
and tell you who needs you"** — with Claude's own memory system doing the remembering, and
this app making it visible and editable.

## Next step (on ratification)

Draft the retrenchment plan: per-feature disposition kill-list, the
WorkspaceMemoryPanel→native-editor design, and the MCP tool-surface diet — staged as CAPP
epics for review.

---

## Appendix: rendering bug found while delivering this (needs repro on current main)

Discovered 2026-07-04 while investigating why this assessment never appeared in the app: the
structured transcript **dropped the tail of a completed turn** — the last tool block plus the
entire final assistant message (~5 KB markdown containing a table) are absent from the
rendered view, while the same conversation's transcript JSONL contains them and every block
of the *following* turn renders live and correctly. Backend was healthy: conversation id
captured, session bound, no main-process errors beyond the known packaged-build updater
ENOENT (`app-update.yml`) unhandledRejection.

Caveats: observed on the **stale packaged build** (`dist/win-unpacked`, repackage was
pending), so first check whether it reproduces on current main. Candidate areas: final-text
fold/settle gating in the stream renderer (see the stream-reveal flicker history), long
single-message handling, and transcript windowing interplay. Also worth fixing regardless:
unit-test runs pollute the real `~/.claude-tui/logs/main.log` (temp-dir paths from vitest
appear in it), and the packaged updater unhandledRejection should be caught.
