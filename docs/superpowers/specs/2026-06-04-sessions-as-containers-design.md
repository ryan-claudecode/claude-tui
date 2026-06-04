# Sessions-as-Containers — Design Spec

**Date:** 2026-06-04
**Status:** Approved (brainstorm complete, ready for implementation plan)
**Sub-project of:** the larger ClaudeTUI vision (see "Context & Scope" below)

---

## Context & Scope

This is **sub-project #1** of a six-part vision to evolve ClaudeTUI from a Claude-terminal
multiplexer into a **context-and-continuity control plane for autonomous Claude work**. The
full vision (in the user's words) covers: (1) sessions rework, (2) cross-device workspaces,
(3) a highest-tier "architect" agent, (4) always-on notifications, (5) Claude-suggested
missions, (6) implicit handoffs.

These were decomposed by dependency. **#1 (this spec) is the keystone** — fully local, no
backend, shippable on its own, and the foundation the others build on. **#6 (implicit
handoffs) folds into this spec** as a natural consequence of session-level context.

**Explicitly OUT of scope** (each its own later sub-project):

- Cross-device / per-user sync ("Parsec for Claude") — #2. A backend + identity + **security-first**
  design (a remote device injecting prompts into a local `--dangerously-skip-permissions`
  Claude is a real attack surface). Not started here.
- Phone/email/push notifications — #4 (desktop toasts already exist via the `notify` tool).
- The **observer** (a cross-cutting critic/auditor) — deferred but **prioritized as the next
  followup** after sessions + workspaces exist. This spec *reserves its seam*.
- The architect agent — #3.
- Mission suggestion — #5.

---

## The Problem

Today a "session" in the codebase **is one Claude terminal** (`SessionService`, `SessionInfo`,
`session:*` IPC, `*_session` MCP tools, the `Session` interface in `App.tsx`). But users think
in **units of work**, not terminals.

The concrete pain is the **"magic terminal"**: a Claude terminal does investigative work and
accumulates hard-won knowledge — a root cause, a "don't touch Z, it breaks W" gotcha, three
approaches already ruled out. A *fresh* terminal has none of it, so it re-discovers the slow
way, or worse, doesn't, and breaks something. The valuable thing isn't *what got done* — it's
the **knowledge of why it matters**, and today that knowledge dies with the terminal.

---

## The Solution (one sentence)

Promote **"session" to a durable container of many terminals** that **automatically accumulates
the knowledge its terminals discover**, so any new or resumed terminal inherits what prior
terminals learned — curing the magic-terminal problem and making handoffs implicit.

**The conceptual symmetry that validates the abstraction** — three tiers of the same idea
("manage Claude's context across scope and time"):

- **Missions** manage context across a *goal* (already built).
- **Sessions** manage context across *terminals* (this spec).
- **Workspaces** manage context across *sessions* (future, #2).

---

## Terminology & Data Model

**The rename (the bulk of the refactor — mechanical but wide):**

- **Session** (NEW top-level concept) — a durable unit of work. Holds many terminals, a context
  summary, notes. Lives on disk.
- **Terminal** (RENAMED from today's `Session`) — one Claude Code instance + its PTY, inside a
  session.

This touches: `SessionService` → effectively `TerminalService`; a new `SessionService` (the
container); every `session:*` IPC channel; MCP tool names; the renderer's `Session` type and
components. The payoff: every downstream feature gets a clean two-tier model with no
special-casing.

### Records

```
Session  (durable, ~/.claude-tui/sessions/<id>.json — atomic write, mirrors mission persistence)
  id: string
  name: string                  // Claude-set from the first terminal's first prompt
  status: "active" | "stopped"  // persisted; display status is richer (see Status Model)
  workspaceId?: string          // SEAM — wired when workspaces (#2) exist
  summary: string               // curated markdown primer — the magic-terminal cure
  notes: Note[]                  // authoritative, self-reported findings
  provisionalFindings: Note[]   // RESERVED SEAM — observer writes here later; empty for now
  terminals: TerminalRef[]
  createdAt: number
  updatedAt: number

TerminalRef  (inside the session record — the durable handle; the live PTY is runtime-only)
  id: string
  name: string                  // Claude-set from THIS terminal's first prompt
  cwd: string
  ccConversationId?: string     // Claude Code's own conversation id, for --resume reattach
  lastState: "active" | "idle" | "dead"

Note
  id: string
  text: string
  createdAt: number
  source: "self"                // later also "observer"
  status: "active" | "superseded"
  supersededBy?: string         // note id that corrected this one
```

The live PTY is **not** in the record — it's runtime-only state held by the renamed
`TerminalService`. The record is the durable shadow that survives app restart; the PTY is
spawned lazily from it.

---

## Persistence, Lifecycle & Resume

**Persistence.** One `~/.claude-tui/sessions/<id>.json` per session, written atomically
(tmp + rename), loaded on boot. Same pattern the mission layer uses.

**Lazy spawn — the critical rule.** On app open, render the sidebar tree **from disk only —
no PTYs spawn**. 15 stopped sessions with 40 terminals → **zero** `claude` processes at boot.
A terminal's PTY spawns **only when clicked** (or when a session is deliberately reopened).
This keeps reopen instant and is what makes "see everything, click what you need" viable.

**Lifecycle.** The **persisted `status`** is binary (PTY-presence):

- **active** — has ≥1 live PTY now.
- **stopped** — no live PTYs (closed terminals, or closed app). Fully restorable.

The richer **display label** (see Status Model) is *derived* from this plus the terminal list —
it is NOT a third stored value. One derived case deserves a name: an **empty-but-live session**
— a session whose terminals are all gone (`terminals.length === 0`) but which has **NOT been
killed** (created by `Ctrl+W` closing the last terminal). On disk it's just `stopped` with no
terminal refs; in the UI it stays selectable and shows a per-session **landing screen** (the
natural home for the Overview + a "start a terminal" affordance). "0 terminals" ≠ "gone" — only
`Ctrl+K` (confirmed) deletes the record.

**Resume (C-primary / A-fallback):** clicking a terminal in a stopped session →

- **Have `ccConversationId` AND CC history still exists** → spawn `claude --resume <id>` in its
  cwd. You land back in the real chat where you left off.
- **Missing / CC history gone** → spawn a fresh `claude`; its seed prompt immediately pulls
  `get_session_context` so it's primed with what the session knows. Degraded, never broken.

Durability never depends on CC internals (the session record is the source of truth); fidelity
is a bonus when CC's history is available.

**De-risking spike (in the plan, not blocking):** capturing `ccConversationId`. CC writes
transcripts to `~/.claude/projects/<project-hash>/<conversation-id>.jsonl`. Plan: after a
terminal spawns and CC creates its file, resolve the newest transcript for that cwd and record
its id. Verify the path/format on this machine before building the reattach path; the
A-fallback covers surprises.

**Migration:** trivial — today's terminals are runtime-only (nothing persisted), so there's no
old data to migrate. New session records start clean.

---

## The Context Engine (the heart)

Two MCP tools, one durable channel — both read/write the session record on disk.

- **`session_note`** *(write — the spine).* The working Claude calls this the moment it learns
  something load-bearing: a root cause, a gotcha, a ruled-out approach, a constraint. Appends an
  authoritative `Note`. Intent-driven: the investigating Claude *knows* when "oh, that's the
  bug" happens, and pins it at the source.
  - Signature: `session_note({ text: string, corrects?: string })`.
  - With `corrects: <noteId>` → flips the referenced note to `status: "superseded"`, sets its
    `supersededBy`, and records this note as the correction. (See "Wrong-then-corrected".)

- **`get_session_context`** *(read).* Returns the session's current primer. Ordering:
  1. **summary** — current truth (leads).
  2. **active notes** — standing findings.
  3. **ruled out / corrected** — a compact trailing section of superseded notes *with* their
     corrections ("~~bug is in X~~ → actually Y"). Preserved as knowledge, clearly not-current,
     so it informs without misleading.
  (Once the observer exists, validated provisional findings also surface here.)

**How a terminal is wired (the "hijack").** Every spawned terminal already gets a seed prompt;
we extend it with a session-aware preamble (roughly):

> You're a terminal in session «name». Call `get_session_context` now to load what prior
> terminals discovered. As you work, call `session_note` whenever you learn something a fresh
> terminal would otherwise re-discover — root causes, gotchas, dead-ends, constraints. If you
> discover an earlier note was wrong, call `session_note` with `corrects` to set the record
> straight — don't leave a stale finding active. Before you finish a chunk of work, refresh the
> session summary.

Mechanism in one line: **read on entry, write on insight.** No file pollution, no burned primer
turn, always live.

**summary vs. notes:**

- **notes** — raw authoritative findings; append-only, cheap, timestamped. Always captured.
- **summary** — the *curated* running state (goal, where things stand, key decisions, open
  questions). Refreshed on **idle-flush**: when a terminal goes idle (same idle signal the
  mission layer's `waitForIdle` uses), **that same terminal's Claude** folds its new notes +
  what just happened into the summary as its last act before going quiet. No second Claude, no
  separate process — the terminal that did the work distills it.

**Token discipline:** new terminals pull the *summary* (curated, small), not the raw transcript.
Raw terminal output stays queryable on demand (existing `getOutput`) for when a terminal needs
to dig. This is the "summary as default, transcript on demand" decision made concrete.

### Wrong-then-corrected findings

A finding that later proves wrong is **demoted to ruled-out, never deleted** — "we thought it
was X, it's not, here's why" stops a fresh terminal from re-investigating X. Three mechanisms,
increasing precision:

1. **Summary self-heals (passive).** The summary is *regenerated* on idle-flush by a Claude who
   now knows better, so a wrong finding stops appearing as current truth. Because
   `get_session_context` leads with the summary, this alone covers the common case.
2. **Explicit correction (precise).** `session_note({ corrects })` flips the old note to
   `superseded` and links the correction.
3. **Observer flag (future).** Once built, the observer can detect contradictions ("note 3
   conflicts with what terminal 2 just did") and surface them for validation via the reserved
   seam.

---

## The Observer (reserved seam — NOT built here, prioritized followup)

Captured so #1 leaves the right hole for it:

- **Why it's a separate, higher tier:** an observer's value is the *outside / aggregate* view —
  blind spots ("you assumed the API was the bottleneck but never measured it"), contradictions
  across terminals, cross-cutting patterns ("three terminals hit the same flaky test"). A
  *per-terminal* observer is redundant with self-report; value scales with how much it sees that
  a single worker can't — so it belongs at session/workspace level, after those tiers exist.
- **Trust model:** self-reported notes are **authoritative** (auto-promoted). Observer findings
  are **provisional** inferences → land in `provisionalFindings`, surfaced for validation (by
  Claude or the user) with a promote/dismiss action before being promoted anywhere.
- **The seam in #1:** the `provisionalFindings: Note[]` slot + the promote/dismiss action in the
  Overview panel. Empty until the observer ships.

---

## Navigation & UI

**Sidebar — the session tree (two-level):** each session is a row showing name + status dot +
derived status label. Sessions with **2+ terminals** get an expand caret; expanding reveals the
terminals **by name**, each clickable to jump to it. **One-terminal sessions show no caret** (a
single clickable row — no nesting clutter).

```
▾ Fix auth race                ● 2 Terminals Working
    • repro the failing test          ○ Idle
    • patch session middleware        ● Adding 5 methods to SessionClass
▸ Refactor billing webhook     ○ Stopped
  POC: mission observer        ○ Idle           (one terminal — no caret)
```

**TabBar — the selected session's terminals** as tabs (the same set the sidebar dropdown lists —
two surfaces onto the same thing). Selecting a session swaps the tabbar to its terminals.

**Main area — the focused terminal's chat** (xterm, unchanged in spirit). **Split view** still
works, scoped to two terminals *of the same session*.

**Session Overview panel** (rendered via the existing panel system) — the pull-up bird's-eye,
*not* the default view. Shows: the live **summary** (markdown); **active notes** + a collapsed
**ruled-out** section; the **terminal list** with reattach/reopen buttons; a **"Push context to
workspace"** button (SEAM — disabled until workspaces exist). Also the content of the
empty-but-live session's landing screen.

**New-session naming flow:** create session → spawns its first terminal → you type the first
prompt → Claude names **both** the terminal (from that prompt) and the session (from the same
first prompt of the first terminal). Until named, a placeholder ("Untitled session").

### Keymap (two tiers)

| Shortcut | Action |
|----------|--------|
| `Ctrl+N` | New **session** (spawns with one terminal) |
| `Ctrl+T` | New **terminal** in the selected session; if none selected / on home landing → new terminal in a *new* session |
| `Ctrl+W` | Close the **terminal** window; if it was the last, the **session stays alive** and shows its landing screen (NOT killed) |
| `Ctrl+K` | Kill the **session** entirely (**confirmation dialog**) |
| `Ctrl+1–9` | Switch **session** |
| `Alt+1–9` | Switch **terminal** within the active session (intercepted at app level before the PTY; classic terminal-tab convention) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle terminals within the active session |
| `Ctrl+H` | **Retire & continue** (explicit handoff — see below) |
| Existing panel/drawer/palette shortcuts | Unchanged |

> Note: bare `Shift+1–9` was rejected — it collides with typing shifted symbols (`!@#…`) in the
> focused terminal. `Alt+1–9` chosen; fall back to `Ctrl+Shift+1–9` only if Alt interception
> fights the terminal in practice.

---

## Status Model (three layers)

1. **Session dot** — green (pulsing) / yellow / dim **aggregate**: green if *any* terminal is
   working, yellow if all idle, dim if stopped.
2. **Terminal dot** — each terminal's own `active`/`idle`/`dead` dot (the existing per-terminal
   activity model, now at the terminal tier).
3. **Live activity line ("rich presence")** — a short, live "what's happening right now" string
   under each terminal row: *"Adding 5 methods to SessionClass"*, *"Searching the web for xterm
   scrollback"*, *"Planning the migration"*. Clears to "Idle" when quiet. The session row (when
   collapsed) surfaces its busiest terminal's line.

**Session derived label** (shown on the row): **"[n] Terminals Working"** (n active) ·
**"Idle"** (live but quiet) · **"Stopped"** (on disk, nothing spawned) · **"Empty"** (no
terminals).

**Activity-line source — A-primary + B-fallback:**

- **A) Self-reported (intent-level)** — a tiny `set_terminal_activity("…")` tool; the seed
  prompt tells Claude *"set a one-line activity before each significant action — a short phrase,
  only when your focus changes."* Matches the desired examples (intent, not raw tool calls).
  Source of truth.
- **B) Parsed (fallback)** — when the narrated phrase goes stale (Claude is heads-down and
  hasn't narrated) while work is clearly happening, fall back to the latest parsed Claude Code
  activity line from captured output ("● Edit(sessions.ts)") so the row never looks frozen.

---

## Implicit Handoffs (#6 folds in here)

Handoffs stop being a manual ritual and become the **default behavior of the model**. Spinning
up a fresh terminal (`Ctrl+T`) in a session **auto-pulls `get_session_context`**, so it already
knows the root causes, gotchas, and ruled-out paths. The knowledge lives in the *session
record*, not the terminal — a fresh terminal is never a blank slate. That *is* the handoff
value, now native.

**One explicit escape hatch retained — `Ctrl+H` = "retire & continue":** force an idle-flush so
the summary is maximally current → open a fresh primed terminal → retire the bloated one. One
keystroke for the deliberate "start clean, lose nothing" move.

---

## Testing (mirrors the mission layer: DI + vitest + MCP-harness E2E)

**Unit (DI'd services, `now`/timers injected):**

- Session record persistence — atomic write (tmp + rename), load on boot.
- Lazy spawn — loading records spawns **zero** PTYs.
- Status derivation — aggregate session label from terminal states ("[n] Terminals Working" /
  Idle / Stopped / Empty).
- Note lifecycle — append; `corrects` flips target to `superseded` + sets `supersededBy`.
- `get_session_context` output ordering — summary → active notes → ruled-out (with corrections).
- Activity line — self-report set/clear; parsed fallback engages when narration is stale.
- Empty-but-live session — `Ctrl+W` on the last terminal leaves the session alive; `Ctrl+K`
  removes it.

**E2E (via `scripts/mcp-client.mjs` against the running app, as proven for missions):**

- Spawn a session + terminals, self-report notes, refresh summary on idle.
- Close + reopen the app → records reload, sidebar renders with **no** auto-spawn → click a
  terminal → `--resume` reattach (or primed fallback) → `get_session_context` returns the
  accumulated knowledge.

---

## Seams & Future Alignment (reserved, not built)

- **Observer** → `provisionalFindings` slot + promote/dismiss action. **Prioritized followup**,
  after sessions + workspaces.
- **Workspace push** → "Push context to workspace" button, stubbed until #2.
- **Mission alignment** (noted only) → a mission's workers are conceptually a session's
  terminals; a future pass could unify them.

---

## Architecture Summary

| Layer | Change |
|-------|--------|
| `electron/services/sessions.ts` → `electron/services/terminals.ts` | RENAME the current file/class to the per-**terminal** service (`SessionService`→`TerminalService`, `SessionInfo`→`TerminalInfo`); runtime PTY state only |
| `electron/services/sessions.ts` (new file, same name reused for the new meaning) | NEW `SessionService` — the durable **container**: record CRUD, atomic persist, status derivation, note lifecycle, summary/idle-flush orchestration, lazy spawn + resume. Holds a reference to `TerminalService` for spawning/killing PTYs |
| `electron/mcp/tools.ts` | New tools: `session_note`, `get_session_context`, `set_terminal_activity`; rename terminal-level tools; keep names coherent with the two tiers |
| `electron/ipc.ts` + `electron/preload.ts` | New/renamed channels for the two tiers |
| `src/App.tsx` | Two-tier state (sessions ⊃ terminals); rename `Session` type; new keymap |
| `src/components/Sidebar.tsx` | Two-level tree (expand caret for 2+ terminals; activity lines; aggregate status) |
| `src/components/TabBar.tsx` | Tabs = selected session's terminals |
| New: Session Overview panel | summary + notes + ruled-out + terminal list + push-to-workspace (stub) |
| `~/.claude-tui/sessions/<id>.json` | New durable store |

Follows existing patterns throughout (Service → IPC → MCP → Preload → Renderer), and reuses the
mission layer's proven mechanisms: atomic on-disk records, DI for testing, idle detection, and
seed-prompt "hijack" for wiring Claude behavior.
