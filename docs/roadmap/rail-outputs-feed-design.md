# Agent Rail OUTPUTS feed — design (CAPP-132)

> Status: DECIDED (architect call under owner's autonomous grant, 2026-07-07).
> Pull signal: owner ask 2026-07-07 — "agents output links, files, etc. in the agent
> rail. Each output enters the rail like a queue, first in first out. The queue shows
> a history of all the agent's output. This is the original vision for the agent rail."

## 1. What this is

A new **OUTPUTS** section in the Agent Rail: a chronological (FIFO) history of the
**deliverables** a session's agents have produced — links, files, and short notes.
Not progress beats, not tool chatter, not status: *artifacts you might want to open*.

## 2. Reconciling with the Beacon design's feed rejection

`agent-rail-design.md` §5 rejected the chronological-feed frame ("The Margin") for two
reasons: (a) it re-creates the transcript's clock and gets noisy, and (b) its beats
depended on agents voluntarily calling a tool. OUTPUTS answers both:

- It is **one section**, not the rail's frame. NOW / COST (and later WORKING / KNOWS /
  AWAITING) are unchanged. The rail stays a calm sectioned dashboard.
- It carries **deliverable artifacts only** — a turn that edits 30 files while
  researching produces a handful of coalesced entries, not a play-by-play.
- **Capture does not depend on agent cooperation** (see §4) — the objection that
  killed the Margin's beats is dissolved, not ignored.
- The **tier-1 contract is untouched**: an output entry is never a blocking gate,
  never an approval, never an actionable duplicate of the sidebar queue.

## 3. Entry model

```ts
interface RailOutput {
  id: string                     // uuid, minted by SessionService
  ts: number                     // epoch ms
  terminalId: string             // minting terminal (display-only; ids are ephemeral)
  kind: "link" | "file" | "note"
  title: string                  // display label (basename / link text / note title)
  url?: string                   // kind=link
  path?: string                  // kind=file — absolute path
  text?: string                  // kind=note — short markdown body (capped ~2000 chars)
  source: "agent" | "derived"    // explicit post_output vs stream-derived
}
```

Scope: **per work session** (deliverables are session-level; entries are tagged with
the minting terminal). The rail shows the focused session's feed.

## 4. Capture — the "how does the agent actually use it" decision

Owner suggested a hook. **Decision: no hooks.** For structured terminals *we are the
harness* — every stream-json event already flows through
`TerminalService.onStructuredEvent`. Hooks would (a) put config in the user's native
Claude files (exactly what the retrenchment stopped doing), (b) add per-machine setup
fragility, and (c) still miss anything the agent doesn't route through the hook. Two
capture paths instead:

**A. Derived (guaranteed, zero agent cooperation)** — in `onStructuredEvent`:
- `tool_use` with name `Write` / `Edit` / `NotebookEdit` → **file** entry from
  `input.file_path` / `input.notebook_path`.
- `result.result` (final assistant text) → **link** entries from markdown links +
  bare URLs.
- Buffered per turn, flushed at `result`: one FIFO batch per turn, files in
  touch-order then links; deduped per (turn, kind, target) — Write then Edit of the
  same file is ONE entry.

**B. Explicit (deliberate deliverables)** — new MCP tool **`post_output`**
`{kind, title, url? | path? | text?}`, identity-bound (the server already resolves
sid/tid from the per-terminal token), so an agent can post "the PR", "the report",
"summary of findings" with a proper title. `SERVER_INSTRUCTIONS` (PILLAR 2) gains a
paragraph telling agents to post deliverables. An explicit entry beats a derived
duplicate in the same turn (better title); derived is the safety net, explicit is the
quality path. Legacy xterm terminals get path B only (they connect to MCP too).

## 5. Storage & flow

- `outputs: RailOutput[]` on the **persisted work-session JSON**
  (`~/.claude-tui/sessions/<id>.json`) — the feed is the durable "history of all the
  agent's output", surviving respawns and app restarts. Capped at **200 per session**,
  FIFO eviction (oldest dropped).
- Flow: TerminalService derives → service event `{type:"output", id: terminalId,
  draft}` → SessionService maps terminal→session, mints id/ts, appends, persists,
  emits. Explicit tool → `SessionService.addOutput` directly.
- Renderer event: dedicated `worksession:outputs-changed (sessionId, outputs)` —
  outputs stay OUT of the `worksession:updated` snapshot (no bloat on every
  activity emit). Accessor `getOutputs(sessionId)` for mount-time pull.
- Wire channels (container ops → `worksession:*`): `worksession:get-outputs`,
  `worksession:remove-output`, `worksession:clear-outputs`, event
  `worksession:outputs-changed`. Main-window preload only (the rail lives there;
  this is not a panel, so PanelApi parity does not apply). MCP: `post_output`.

## 6. UI (Agent Rail, between NOW and COST)

- Section header: `OUTPUTS` label + count + always-visible **Clear** text button.
- Rows, chronological FIFO (oldest top → newest bottom), autoscroll pinned to newest
  unless the user has scrolled up. Row = kind glyph (🔗 link / 📄 file / 📝 note) +
  title (truncated) + compact time + always-visible **Open**/**Reveal** text action +
  always-visible ✕ remove. Link → `open_external`; file → `reveal_path`; note →
  expands inline (visible chevron).
- Empty → the section is absent entirely (calm rail; no "no outputs yet" filler).
- **No hover-reveal anywhere** (standing rule). **Stream-reveal flicker trap** applies:
  animate only the arrival edge of a NEW entry (stable ids, monotonic list, no
  re-fire on remount).
- Collapsed-spine unread dot: deferred (follow-up with AWAITING phase; noted, not built).

## 7. Tests

- Pure derivation lib (turn buffer → entries: coalescing, dedupe, link extraction,
  explicit-beats-derived) — hermetic node tests.
- SessionService: append / cap-at-200 / persist round-trip / terminal→session mapping.
- Renderer: pure ordering + pin-to-newest decisions; component render smoke.
- e2e: rail shows a posted output for a mocked stream (hermetic — no real claude.exe).

## 8. Explicitly out of scope (v1)

- Unread-dot on the collapsed spine; edit/reorder of entries; cross-session outputs
  browser; image-kind entries; panel-opening entries (a `show_panel` link-out can be
  a later kind).
