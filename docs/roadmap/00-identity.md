# ClaudeTUI — Identity

> This document is the north star for all roadmap work. Every work item links back here.
> When a work item leaves a decision open, make the choice that best serves this thesis.

## Thesis

ClaudeTUI is **the workbench where agent work is durable and agents are first-class UI citizens.**

Not "an app where you can open Claude terminals." The terminal is the substrate, not the
product. The product is what no terminal — and no single-session CLI — can offer.

**The moat is one idea: the app is a persistent, multi-agent world that agents render into.**
Everything defensible is a facet of that. The three pillars below are not co-equal features —
they are three views of the same moat, in priority order.

1. **Agent-rendered UI** *(bidirectionality — the lead pillar).* In every competing tool the
   human drives the app and the app drives the agents. Here, **agents drive the app back**: they
   render panels, show diffs, block on forms, raise toasts, route the user's attention. This is
   the one thing nobody else is doing, and it is defensible **because of the context it lives in** —
   a persistent desktop window holding *many* concurrent agents. A single-session CLI can't grow
   into this; the surface only makes sense when there's a durable canvas and more than one agent to
   render. The companion window + panel/form system are this pillar.
2. **Continuity** *(the durability spine).* Work outlives any single context window. Sessions
   accumulate knowledge (findings, corrections, summaries) that survives restarts, context
   exhaustion, and usage limits. A terminal is disposable; the *work* is durable. Foundational —
   we lead on it today, but assume competitors converge here. The context engine
   (`electron/services/sessions.ts`), conversation resume, idle-flush summaries, and Ctrl+Shift+H
   handoff are this pillar.
3. **Orchestration** *(continuity applied to many agents).* Missions: durable on-disk goals,
   dispatched workers, a code-level supervisor that guarantees liveness across crashes and usage
   limits. **The defensible half is the durability — "code guarantees continuity; Claude provides
   intelligence."** The *throughput* half (running N worktrees in parallel) is convergent and is
   ceded to competitors (Conductor, Crystal, vibe-kanban); do not mistake parallelism for the moat.
   Built ON TOP of pillars 1 and 2, not beside them.

## The decision filter

Before adding, keeping, or polishing anything, ask:

> **Does this make agent work more durable, or make agents better UI citizens?**

This sorts work into **three** buckets, not two:

- **Moat** — yes to the question above. Cross-session memory, attention routing, agent-rendered
  panels/forms, the supervisor loop. Invest here; this is the product.
- **Enabling substrate / table-stakes parity** — doesn't *itself* deepen the moat, but the moat
  can't exist without it. The custom-rendered chat surface is the clearest case: agents can only
  render rich UI *back* into the app once the app owns the render surface (you can't inject
  agent-rendered panels into a scraped xterm), and the chat has to be *usable* before any of it
  matters. Build these to a **usable** bar. Some ongoing polish here is fine — a cockpit you actually
  enjoy using has real value, especially for a solo builder — but keep it the **minority of
  effort**: the moat features are the priority, and surface polish must not crowd out the deeper work. Most of the BO-1..BO-8 rendering rebuild lives here: necessary and
  on-thesis as a *means*, but not the moat itself.
- **Cut** — neither, and not load-bearing for either. See the kill-list.

"It would be convenient" is not a reason. Claude Code already ships a full native toolset;
duplicating it adds token cost, model confusion, and maintenance burden while diluting what this
app is.

## Kill-list (deliberate non-goals)

The boundary that de-fuzzes most calls: **does the tool produce a user-facing surface, or do the
agent's own internal work?** Surfaces serve bidirectionality (keep); internal work belongs to the
agent's own shell/CLI (cut). That is why `diff_files` lives (an agent showing its work to the user)
while generic file read/write does not (the agent doing its own work).

- **Utility MCP tools** that duplicate Claude's native abilities: math, color, CSV/JSON
  transforms, regex testers, text transforms, encode/hash, file read/write/edit, generic
  process listing. Claude has these. They are being removed, not maintained.
- **Being a great general terminal.** We do not compete with Warp/tmux/WezTerm on terminal
  features. xterm.js at "good enough" fidelity is fine.
- **Being an IDE.** No file trees, no editors. Diff *review* panels exist because they serve
  bidirectionality (an agent showing its work), not because we edit files here.
- **Feature-completeness of the git surface.** Read-only structured git (status/log/diff)
  serves observability. Write-side git plumbing belongs to the agent's own shell.

## Positioning notes (context for choices)

- Competitors (Conductor, Crystal, Claude Squad, vibe-kanban) center on *throughput* —
  parallel worktree sessions with diff review. Our differentiation is *agent-rendered UI* and
  *continuity*; worktree isolation is on the roadmap as table stakes, not identity.
- **Anything that is "a UI over a Claude Code CLI feature" erodes as Claude Code improves.**
  Features that live *above* the CLI — cross-session memory, attention routing, agent-rendered
  UI, the supervisor loop — are the durable ones. Note: substrate/parity work (rendering Claude's
  own output, a model/slash/effort picker) *is* the eroding kind — that's expected; it's the floor
  we build to earn the moat, not the moat. Ship it to good-enough and return upward.
- Windows-first polish is a distribution wedge (serious competitors are Mac-first), but the
  codebase stays cross-platform. This is go-to-market, not identity — don't let it become a pillar.

## Tone & quality bar

- Warm Sand & Stone visual language, frameless, smooth — never blocky (see existing themes
  in `src/App.css`).
- An agent cockpit must be trustworthy: no silent failures, no data loss on upgrade, no
  forgeable identity, **and no runaway you can't stop** — an agent mid-edit must always be
  interruptible. Phase 0 exists entirely to earn this.
