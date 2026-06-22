# Context Engine v2 — "The Second Brain" Design Doc ("The Lexicon")

> Status: PROPOSED — pending owner ratification of the Open Questions.
> Pillar: #2 of the owner's north-star continuity initiatives (work outlives any single context window). Feeds the Agent Rail KNOWS section (CAPP-84) and will help define #3 (missions).
> Hard constraints honored: local desktop app; Claude SUBSCRIPTION login (no API key) → any semantic search must have a LOCAL option, so v1 is lexical-only; additive + low-risk; no hover-reveal; warm Sand & Stone.

## 1. What already exists (build on, do NOT redesign)

`SessionService` (`electron/services/sessions.ts`) is a well-built, durable PER-SESSION knowledge container persisted to `~/.claude-tui/sessions/<id>.json`. Each `WorkSession` holds:

- `summary` (rolling goal + current-state blurb)
- `notes: Note[]` — the finding ledger; a `Note` has `{ id, text, createdAt, source: 'self'|'observer', status: 'active'|'superseded', supersededBy? }`. `corrects` demotes a prior note to `superseded` (ruled-out) and links it forward — never deletes.
- `provisionalFindings: Note[]` — schema exists, **no ingestion path today** (dead seam).
- `eventLog?: SessionEvent[]` — durable life-history, capped at 500.
- `terminals: TerminalRef[]` — runtime PTY refs (engine/model/effort/activity).

Recall today = `getContext(sessionId)` builds a markdown primer (summary → `## Findings` → `## Ruled out / corrected` with `~~old~~ → new` rendering) injected into a spawning terminal's SERVER_INSTRUCTIONS. `getOverview()` powers the Session Overview companion panel. Capture today = three explicit MCP tools (`session_note`, `set_session_summary`, `set_terminal_activity`) plus the idle-flush summary-refresh prompt.

**The one real gap for a "second brain": knowledge is siloed per session.** There is no cross-session search, no index, no "have we learned this before?" across sessions/workspaces. Everything else (atomic persistence, robust `--resume`, idle-flush, event log, corrections) is solid and stays the source of truth.

### Two facts verified in code (they shape the plan)

1. `addNote` and `setSummary` **persist but do NOT emit `worksession:updated`** (the existing emits are all on terminal-lifecycle methods, lines ~300–911). So the Rail KNOWS live-refresh needs that one additive emit — it is the same emit the Agent Rail Phase 3 design already asked for, and it is required no matter which concept wins.
2. All sessions are loaded into an **in-memory `sessions` Map at boot**, so a derived cross-session index needs **no new disk format and no migration** — it derives for free and re-derives on restart.

## 2. Recommended direction — "The Lexicon" (recall-first, read-only)

A new **read-only RecallService** that indexes every finding/summary already living in the per-session JSON into one searchable corpus, so any agent (or the user) can ask "have we learned this before?" across all sessions and workspaces. **Lexical first; vector-ready by construction** (the scorer is a pluggable interface, so a later local embedding pass is an additive swap, not a rewrite).

**Why recall-first over capture-first ("The Ledger") or graph ("The Atlas"):** the corpus is ALREADY populated by every session ever run, so recall delivers value on day one with zero new capture, zero deps, zero persistence, zero schema change. It proves the search/MCP/panel surface and validates demand BEFORE we commit to noisier ambient capture (structured-engine-gated) or graph edges (capture-discipline-dependent). Capture-first is the right SECOND bet; graph is a later level-4 tier. Both are folded into this doc as ratify-gated phases.

### Capture (unchanged in v1 — deliberately)

This concept adds NOTHING to capture. Findings keep landing via the live MCP tools and idle-flush. The recall corpus is automatically every Note + summary those tools have ever written; a new finding joins the searchable set the moment it hits the `sessions` Map. The unimplemented provisional/observer seam is explicitly OUT of v1 scope (it is the complementary capture-first phase).

### Storage (zero new persistent store in v1)

Source of truth stays the per-session JSON files, already in the in-memory `sessions` Map. RecallService holds only a DERIVED in-memory index, invalidated on the existing `worksession:updated` push. It can never drift from or corrupt the canonical files and survives restart for free (re-derived on next load). Scales fine for the realistic corpus (tens of sessions × tens of notes). Only IF lexical proves insufficient does Phase 2 add an OPTIONAL `embedding?: number[]` field on `Note` via the existing versioned-persist envelope + a `SCHEMA_VERSION` bump — never a separate DB.

### Recall (three coordinated read-only surfaces)

1. **AGENT** — a new identity-bound `recall(query, scope)` MCP tool (scope `'session'|'workspace'|'all'`, default `'workspace'` so project A's findings don't leak into project B unless `'all'` is explicit) returns ranked cross-session hits: text + sessionName + status + the correction-arrow for ruled-out. An agent self-queries before re-exploring — directly attacking duplicate-exploration cost. **Ruled-out-aware results are the uniquely high-leverage signal**: surfacing what was DISPROVEN (with its correction) is exactly what stops agents re-walking dead ends, and that data already exists via `corrects`/`supersededBy`.
2. **PRIMER** — `getContext()` optionally appends a capped `## Related from other sessions` block (top 3–5 recall hits for the session's own summary/name), so a fresh terminal inherits relevant knowledge from OTHER sessions, not just its own. **Gated behind a config flag, default OFF**, so the default primer is byte-identical until ratified.
3. **RAIL KNOWS** — `RecallService.summary()` supplies the cross-session count digest (total findings / ruled-out across N sessions) + most-recent ruled-out one-liner the Agent Rail KNOWS section was designed for, made live by the new `worksession:updated` emit. "Open Recall →" opens the RecallPanel companion view for human deep-search.

## 3. Foundational v1 — the slice to build TONIGHT

Additive, dependency-light, gated. ~250 LOC backend + one panel, following the project's Service → IPC → MCP → Preload pattern. Six touchpoints:

1. **`electron/services/recall.ts` (NEW)** — RecallService. Takes a `listSessions: () => WorkSession[]` callback (decoupled/testable, mirroring SessionService's `getActiveWorkspaceId` injection). Derives an in-memory index from `SessionService.list()` — one entry per Note (active + superseded) and per non-empty summary, carrying `{ sessionId, sessionName, workspaceId, text, status, source, createdAt, correction? }`. Matching is dependency-free lexical (case-folded substring + token-overlap score, ranked by score then recency). Exposes `recall(query, scope, callerWorkspaceId?)` and `summary()`. Index rebuilt lazily / invalidated on `worksession:updated`.
2. **`electron/services/sessions.ts`** — append `this.emit("worksession:updated", this.withEffectiveActivity(s))` to `addNote` (after its `persist`, ~line 1115) and `setSummary` (after its `persist`, ~line 1125). Verified-missing today; required for KNOWS live-refresh.
3. **`electron/mcp/tools/worksessions.ts`** — register the `recall` tool (identity-bound; scope defaults to the caller's session/workspace), returning ranked hits with ruled-out correction-arrows (reuse `getContext`'s exact rendering). Mention recall in SERVER_INSTRUCTIONS.
4. **`electron/ipc.ts`** — one-line `worksession:recall` and `worksession:recall-summary` handlers → RecallService.
5. **`electron/preload.ts`** — `recall` / `recallSummary` accessors for the renderer KNOWS section, live off the existing `worksession:updated` listener.
6. **`src/components/panels/RecallPanel.tsx` (NEW)** — search box + results grouped by session + status filters + click-to-open the owning SessionOverview. Register `case "recall"` in `CompanionApp.tsx` PanelContent, add `"recall"` to the `show_panel` type enum in `electron/mcp/tools.ts`, add a `.recall-panel` block in `src/App.css` using existing Sand & Stone tokens. **No hover-reveal — every control explicitly visible.**

**Gating / out of scope for v1:** primer enrichment ships default-OFF (byte-identical default primer). NO persistence, NO embeddings/onnx/Transformers.js, NO provisional/observer ambient capture, NO graph edges, NO cross-workspace-by-default. NO change to `session_note`/`set_session_summary`.

**Hermetic test** (mirrors `sessions.test.ts` `opts.dir` injection): feed synthetic WorkSessions into RecallService; assert ranked hits, ruled-out-with-correction surfacing, and scope filtering. The app is byte-identical when `recall` is never called.

## 4. How it surfaces in the three named hooks

- **Rail KNOWS (CAPP-84):** cross-session digest from `RecallService.summary()` (counts across N sessions + most-recent ruled-out one-liner), live off the new emit, "Open Recall →" → RecallPanel. Fulfills the KNOWS section's stated cross-session ambition with zero new chrome.
- **`get_session_context` primer:** the gated `## Related from other sessions` block makes inheritance cross-session, not just within-session.
- **Missions (#3):** `recall(query)` gives a Conductor a "has this been solved before?" query — the capture/recall substrate missions build on.

## 5. Heavy / owner-judgment phases (need ratification)

- **Phase 2 — Local semantic search:** swap/augment the lexical scorer with local embeddings (Transformers.js + all-MiniLM-L6-v2, ~50ms/doc CPU, zero cloud tokens — subscription-safe). Optional `embedding?: number[]` on Note, lazy background compute, first real schema migration via the persist.ts Migration[] envelope. Closes the lexical gap. RATIFY: dependency tolerance + ~25MB bundle.
- **Phase 3 — Capture-first "The Ledger":** tap the stream events TerminalService already emits (add `else if (e.type === "stream")` in `attachTerminals`'s `onEvent` — the listener already receives but ignores them) to harvest turn-outcomes/error→fix into the dormant `provisionalFindings` (`source:'observer'`), wire the stubbed Promote/Dismiss buttons + MCP tools. Structured-engine-only (graceful xterm degrade); gated on the held CAPP-39 flip. RATIFY: capture-automation appetite + noise tuning.
- **Phase 4 — Graph/wiki "The Atlas" + cross-workspace:** optional `links?: KnowledgeLink[]` on Note (file:/session:/note:/tag:), `corrects` retrofit as the first edge type, derived adjacency index (getBacklinks/findingsForFile), browsable Atlas panel (force-graph deferred), explicit cross-workspace 'all' mode. Level-4 tier. RATIFY: graph value vs lexical sufficiency + edge-capture discipline.
- **Phase 5 — Polish:** backup/export tool (tar.gz sessions+notes+missions), incremental index update at scale, NotesService→session linking, level-5 autonomous reconciliation (heavily gated, far future).

## 6. Risks

1. **Lexical-only v1 misses semantic matches** ('parsing bug' won't find 'tokenizer crash') — bounded early value until Phase 2. Mitigated by the pluggable-scorer seam making the upgrade additive.
2. **Recall quality is hostage to capture quality** — thin/absent notes (the known adoption friction) = a thin corpus; recall-first does nothing to fix capture rate. This is why capture-first ("The Ledger") is the explicit next bet.
3. **Primer enrichment risks context bloat / off-topic injection** — kept gated, capped top 3–5, short, and default-OFF until ratified.
4. **Cross-session/workspace leakage** — a finding from project A surfacing in project B; mitigated by scope default = 'workspace', 'all' as explicit opt-in.
5. **In-memory re-derive on hot mutation paths** — fine at current scale; needs incremental update only if a single session reaches thousands of notes.

## 7. Open questions

See the `openQuestions` list — what to index, lexical-vs-vector trigger, cross-session scope default, primer enrichment default + cap, dependency tolerance for Phase 2, capture-automation appetite, graph value, and backup/export.

## 8. v2 — The two-tier brain: Workspace Memory + live session findings (CAPP-87, RATIFIED 2026-06-22)

The owner ratified a second durable tier. Motivation: "brain as a sum of session JSONs" is a
*view* (RecallService derives the cross-session digest on the fly from live sessions), **not a
store** — so there is nowhere to assert knowledge that should outlive any session, and killing a
session removes its findings from the workspace view. Full implementation plan (anchor-verified,
adversarially reviewed — 22 blocker/major resolved): `docs/roadmap/CAPP-87-workspace-memory-plan.md`.

The brain a fresh agent inherits becomes **workspace memory (always present) ∪ live session
findings (derived, as today)**.

1. **Workspace Memory** — a NEW first-class tier: durable, workspace-level standing
   context/instructions plus *promoted findings*, persisted with the **workspace** (one file per
   workspace under `~/.claude-tui/workspace-memory/<workspaceId>.json`, a sentinel file for the
   untagged "All" bucket), owned by a NEW `WorkspaceMemoryService`. It survives **all** session
   deletion. Editable directly by the user; writable by agents via new MCP tools
   (`get_workspace_memory`, `add_workspace_memory`, `set_workspace_memory_context`, `promote_finding`).
2. **Live session findings** — the existing per-session `notes[]`/`summary` ledger, unchanged.

**The bridge — promotion.** A session finding can be *promoted* up to workspace memory (a
structural copy of the origin `Note` + provenance `originSessionId`/`originNoteId`). Promotion does
NOT remove the origin note; recall de-dups them so each logical finding counts exactly once
(de-dup key = the **(originSessionId, originNoteId)** pair). Promotion is **workspace-bound to the
OWNING session** — never the caller's workspace, never the global active selection.

**Delete-time decision (no silent default).** Killing a session opens a blocking main-window modal:
**Keep & delete** (promote the dying session's findings to its workspace memory — defaults to
promoting *all*, but presents a reviewable, editable, per-row-deletable list) vs **Delete
everything** vs **Cancel**. Workspace memory is never at risk in this dialog — only the dying
session's own findings. "Delete everything" = today's `killSession` semantics (record + PTYs; does
NOT delete the Claude transcript on disk — worded honestly).

**Scope/privacy.** Workspace memory scopes identically to notes: default `workspace` (no
cross-workspace leak), invisible under `session`, returnable under explicit `all`. The untagged
bucket is a **global, cross-project shared scope** (documented). Agent writes from an untagged
session land in the untagged bucket — never a global-active fallback.

**Workspace-delete (v1 decision):** deleting a workspace does NOT auto-wipe its memory (wiping
curated memory while the feeding sessions persist on disk would invert "memory is the durable
tier"); the memory file is left orphaned-but-recoverable. An explicit "delete workspace AND its
memory" affordance + orphaned-session re-tagging is backlogged.

**Surfaces:** a third Agent Rail KNOWS group ("Workspace memory"), an editable companion panel
(`workspace-memory`), and the now-enabled SessionOverview "Push context to workspace" button.

**Build order (worktree-isolatable units):** U1 store+promote ∥ U2 SessionService read helpers →
U3 IPC/MCP/preload → U4 RecallService union+de-dup+rail → (U5 delete-time modal ∥ U6 editor panel).
U5 is the unit that unblocks the delete-time Keep flow.

**LATER (out of scope, not architected against):** the interactive graph "The Atlas" (Phase 4
above) visualizes both tiers and becomes the home for promote/edit.
