# THE ATLAS — Interactive Context Graph (design, Phase 4)

*A visual lens over the two-tier "Lexicon" brain (workspace memory ∪ live session findings,
CAPP-87). Produced by the `atlas-graph-design` design workflow (3 maps → synthesis → 3-lens
adversarial critique → revise; 24 issues, 13 blocker/major). This is the post-critique design:
ruthlessly cut of eye-candy, re-baselined against HEAD (CAPP-94 shipped), and honest that the v1
that earns its keep is a **list-mode corpus view first, graph second**. Contentious calls are
surfaced as OWNER DECISIONS with recommendations — not silently chosen.*

> **Re-baseline note (load-bearing — verified against HEAD):** killSession HARD-deletes the origin
> session (`sessions.ts:558-567`), no tombstone; `RecallEntry` carries **no finding id** and
> resolves supersession to *text* not a link (`recall.ts:36-56,200`); the recall handler scopes via
> `workspaceIdOf(sessionId)`, never `getActiveId()` (`worksession-handlers.ts:134,141`); and
> **`WorkspaceMemoryPanel` already shipped as the editable findings home** (CAPP-94/U6). The design
> is written around these facts, not the draft's assumptions.

---

## 0. Thesis

The biggest source of the Atlas's claimed value is a single flaw in an existing surface:
**RecallPanel returns nothing on an empty query**, so no surface answers *"what does this workspace
know, at rest?"*. Closing that — plus rendering the one genuinely-invisible-today fact
(**provenance**: a memory finding came FROM a specific session note) — does **not** require a graph.
It requires a **~20-line "corpus mode" on RecallPanel** plus a **provenance caption on
WorkspaceMemoryPanel**. That is the real minimum-viable Atlas. The **interactive graph itself is a
VISION/DELIGHT bet** on the owner's stated "eventually an interactive graph like in the video"
aspiration — it is *not* pain-justified, and this design says so plainly. If the owner funds the
graph anyway (a legitimate choice), it ships as a **read-only, zero-dep, static-tiered SVG
navigation lens that sits BESIDE the list, never replaces it** — reading findings is always denser
in a list, and the graph's only unique capability (2D adjacency) is weak at the project's real
corpus size (tens of nodes, often fewer due to thin-notes friction).

---

## (A) The distinct job — honest, and shrunk

The honest jobs table, graded by the sharp question (*does it need 2D spatial adjacency, or just
no-query + grouping — a **list** feature?*):

| Job | Needs 2D adjacency, or just no-query+grouping? | Best surface | Verdict |
|---|---|---|---|
| "What does this workspace know, at rest?" | no-query + group-by-(session,tier) | **List (RecallPanel corpus mode)** | List wins — cheap |
| See a finding's **PROVENANCE** (memory ← origin session) | 1:1 relation = a caption/column | **Caption on WorkspaceMemoryPanel** | List/caption wins |
| Spot orphaned / duplicate knowledge | sort-by-(text, then degree) | **List (sorted)** | List wins — dupes scatter in a node cloud |
| See the corrections subgraph | already rendered `old → new` inline | **List (already done)** | List wins |
| Is this knowledge stale? | per-finding scalar → sort-by-age | **List (`findingFreshness` text)** | List wins — text richer than a color ramp |
| Read the text of many findings | density | **List** | List wins decisively |
| Navigate the cross-tier shape at a glance | **genuinely needs 2D adjacency** | **Graph** | **Graph's only honest win — and weak at tens of nodes** |

**Six of seven jobs are won by a list** that does no-query + grouping + sorting. Only the seventh —
a *spatial* read of the cross-tier shape — needs a graph, and at the real corpus size even that is
marginal. **The Atlas's distinct job, told honestly, is narrow and partly aspirational.** Build the
list value first; fund the graph as a delight bet, eyes open.

---

## (B) v1 node / edge model — derivable today, over RAW inputs (NOT RecallEntry)

> **Correction forced by the critique (verified):** the deriver **cannot** consume `RecallEntry[]` —
> it carries no finding id (same-text findings collide; React keys/selection break) and resolves
> supersession into *text*, discarding the `supersededBy` **link**. The deriver runs over the **RAW**
> `WorkSession[]` + `MemoryFinding[]` and **shares only the dedup PREDICATE** with `deriveRecallIndex`,
> not its output.

**Nodes (v1, zero schema change):** `workspace` (`ws:<id>`), synthetic `ws:__all__` (untagged),
synthetic `ws:orphan:<idPrefix>` (a memory finding whose workspaceId has no live workspace —
deferred delete-cleanup), `session` (`sess:<id>`), `finding — session note` (`note:<sid>:<nid>`,
preserving `Note.id` + `supersededBy`), `finding — workspace memory` (`mem:<findingId>`). **Namespaced
ids are load-bearing** — the `(originSessionId, originNoteId)` dedup maps a suppressed live origin
note to its surviving memory twin only with stable, namespaced ids (never text-derived).

**Owner-choice node attributes:** emit a `summary` node kind (session summary / workspace
instructions — `deriveRecallIndex` indexes these as first-class `status:"summary"`; free, keeps
graph == recall corpus); make a **deliberate call** on `provisionalFindings` (emit as a dimmer
`provisional` status **or** explicitly exclude with a one-line rationale — don't leave them silent).

**Nodes declined:** `terminal` (runtime/volatile — turns a knowledge map into a process monitor;
OFF, not even a toggle); `file`, `tag` (don't exist in the schema — out of v1).

**Edges (v1):**
- **belongs-to** finding→session, session/memory-finding→workspace (`workspaceId ?? "__all__"`, +
  orphan minting so it never dangles).
- **promoted-from** memory-twin → origin **SESSION** node (NOT a second origin-note node — the origin
  note is collapsed into the twin by dedup; **drop the edge if the origin session is out of scope or
  deleted** — never a dangling line).
- **supersedes** corrector → superseded, from the `supersededBy` **link**. **Cross-tier resolution
  required:** if a ruled-out session note's corrector was *promoted*, the corrector's live node is
  suppressed by dedup — draw the edge to the corrector's **memory twin** (via the same origin-pair
  map). Fallback: keep per-tier + render the orphaned ruled-out node's **correction text as an
  attribute** so it's never lost.

**Deferred (need a schema add):** `file-ref`, `shared-tag` — require the optional
`links?: KnowledgeLink[]` on `Note` (design doc §5) + capture discipline.

---

## (C) Data path — pure deriver over raw inputs; cache + scope reuse

A pure node-free `src/lib/atlasGraph.ts` (mirrors `workspaceMemoryView.ts`): `deriveAtlasGraph(
workspaces, sessions, memoryFindings, scope, caller) → { nodes, edges }`, applying the **shared
extracted `promotedOriginKeys` predicate** (so it can't drift from `deriveRecallIndex`) and
`scopeFilter` **before** emitting. `AtlasNode` carries **both** `createdAt` (origin age) and
`promotedAt` (graduation age).

**Cache (critique-resolved):** do NOT add a separate cache. Memoize the graph on `RecallService`
under the **existing `invalidate()`** (`private atlasCache` keyed by `(scope, callerWorkspaceId)`,
cleared alongside `this.index`) — shares the exact `worksession:updated` / `workspace:memory-changed`
invalidation seam, no new push wiring.

**IPC/MCP seam:** `RecallService.atlasGraph(scope, caller)` (+ a `listWorkspaces()` injection); one
`worksession:atlas` handler that **mirrors the recall handler exactly** —
`caller.workspaceId = workspaceId ?? recallService.workspaceIdOf(sessionId)`, **NEVER `getActiveId()`**
(+ a test: an atlas for a session in ws-A returns only ws-A nodes even when ws-B is active). Exposed
on both preloads. **MCP: prefer NOT adding `"atlas"` to `show_panel` for v1** (open renderer-side
only, mirroring the worktree-review precedent, so the agent isn't invited to spam its own context map).

**Scope:** default `workspace` via the caller's OWNING workspaceId; pills Session/Workspace/All;
untagged → its own "All / untagged" cluster; orphaned buckets surface in `all` scope only.

**Scale (corrected):** the real corpus is single-digit-to-low-tens of finding nodes per workspace
(design-doc estimate + CAPP-83 thin-notes risk) — which kills any physics argument and weakens the
"spot clusters at a glance" value (with ~25 nodes you can read the list).

---

## (D) Render + the dependency decision (OWNER CHOICE — collapsed)

**Precedent (decisive):** every viz panel in this repo is hand-rolled, zero-dep (`ChartPanel`
inline-SVG; `HeatmapPanel` `<table>` + hand-written ramp); `package.json` has no d3/canvas/graph lib;
Transformers.js was RATIFY-gated.

> **Static tiered SVG, zero deps, period. Physics is OUT OF SCOPE, not "deferred." A canvas lib
> (react-force-graph/cytoscape/d3-force) is declined.** Keep `layoutAtlas(graph) → positionedNodes` a
> pure, swappable seam so a future contributor *could* add force layout — but don't put a dependency
> decision in front of the owner for a feature the design rates as polish at a ~tens-of-nodes corpus.

**The load-bearing testability fact:** the repo has **no visual-regression harness** — every e2e
assertion is a DOM locator, no `toHaveScreenshot`, on a Windows CI already fighting Chromium
STATUS_BREAKPOINT. So "screenshot diffs" is not an available fallback — a canvas Atlas would be the
one companion panel with no e2e assertion that its content rendered, in a codebase whose e2e culture
exists *because a blank-render bug shipped once*. **SVG keeps the Atlas inside the DOM-locator e2e
culture** (`<circle data-node-id>` is clickable; edge counts assertable).

**Render constraints (perf moved INTO the MVP):** stable-key layout (positions a pure function of
node **identity** + tier, NOT array order; test: add one finding, assert pre-existing nodes keep
coordinates); cap rendered finding nodes per session with a "+N more" aggregate above a threshold;
pan/zoom via a **single `<g transform>`** (panning never re-renders the node tree); selection
highlight via **one root CSS class** + descendant selectors; a U1 perf bench (~16ms budget over a
generated fixture). **Freshness:** carry both `createdAt` + `promotedAt`; render `findingFreshness`
TEXT on the selection rail — NOT node color (a single color is lossy and weaker than text). Labels
truncate at node size → "read this finding" is always a click-to-read hand-off; **the graph is a
navigation lens beside the list, never a replacement.**

---

## (E) Interaction — read-only v1 vs. editable (OWNER CHOICE)

No hover-reveal (every action a visible control). v1 (recommended): node click → selection +
highlight + a side detail rail (full text + `findingFreshness` + explicit buttons); node click →
**hand off to an existing panel** (session/finding → SessionOverview; workspace → the editable
WorkspaceMemoryPanel); always-visible `+`/`−`/Fit zoom controls; explicit filter pills (copy
RecallPanel); SVG nodes carry `role`/`aria-label` + a keyboard-navigable node-list fallback.

> **Re-baselined (critique):** the editable "home for promote/edit" the draft cited as the future
> justification **already shipped** (WorkspaceMemoryPanel + SessionOverview push). Editable-in-graph
> would RE-IMPLEMENT promote/edit/delete a second time inside an SVG with worse density/accessibility.

- **Option R (strongly recommended): read-only navigation v1; DROP "editable-in-graph" (Phase 4c).**
  Editing is reached by handing off to the panel that already exists.
- **Option E (editable-in-graph):** only if the owner specifically wants in-place graph editing.
  **If chosen:** mutations MUST source `workspaceId` from the **selected node's** attribute (the "All"
  node → `null`), never the active workspace or scope pill, or an edit misroutes.

---

## (F) Phasing → buildable units (list value FIRST, graph as a funded bet)

**PHASE 4.0 — "Corpus mode" (the real minimum-viable Atlas, NO graph; ~a day, no new panel/lib/IPC/enum):**
- **L1 — RecallPanel empty-query corpus view:** empty query → render the full *scoped* index (already
  comes through the recall IPC + `scopeFilter`), grouped by session/tier, sorted by recency, + a
  sort-by-text option (dupes adjacent) + `formatAge` freshness. Delivers at-rest corpus, staleness,
  dup-spotting with zero new surface.
- **L2 — provenance caption:** on WorkspaceMemoryPanel, render `"Promoted from <sessionName>"` under
  each finding carrying `originSessionId`, clickable → `openSessionOverview`. ~10 lines.

**Gate:** ship 4.0, put it in front of the owner, and **measure whether the residual spatial job
still wants a graph** after the killer fact (provenance) is visible as a caption.

**PHASE 4.1 — "The Atlas" graph (the VISION/DELIGHT bet, only if funded after the 4.0 gate):**
read-only, per-workspace static-tiered SVG context-map panel beside the list.
- **U1** `src/lib/atlasGraph.ts` — pure `deriveAtlasGraph` (raw inputs, namespaced ids, shared
  `promotedOriginKeys`, cross-tier supersede resolution) + pure stable-key `layoutAtlas`. Tests:
  node/edge counts, dedup parity with recall, scope filtering, position stability across re-derive,
  the perf bench.
- **U2** `RecallService.atlasGraph()` + memoized `atlasCache` cleared in the existing `invalidate()` +
  `worksession:atlas` IPC (mirrors recall scope) + preload accessors (both windows).
- **U3** `case "atlas"` in `CompanionApp.tsx` + label. (MCP enum: per decision #6, likely skip for v1.)
- **U4** `src/components/panels/AtlasPanel.tsx` — SVG render, selection rail, scope/type/status pills,
  `+`/`−`/Fit, freshness-via-text-on-rail, the four perf measures, `.atlas-panel` CSS.
- **U5** e2e (DOM locators): N node `<circle>`s render; a `promoted-from` edge element exists; click a
  node hands off to overview.

**DELETED from the roadmap (critique):** ~~physics / d3-force~~ (out of scope, not deferred);
~~editable-in-graph~~ (the editable home already shipped; reached by hand-off).

**PHASE 4.2 — new edge/node types (only schema-touching piece, correctly last):** `file-ref`,
`shared-tag`, `note:`-links via the optional `links?: KnowledgeLink[]` on `Note` — gated, only if a
*user* pain appears.

**HARD PREREQUISITE (provenance durability):** killSession hard-deletes origin sessions, so
`promoted-from` dangles for **kept** (curated, highest-value) findings — making the "killer edge"
decorative in steady state. **Before the provenance edge is worth building, EITHER** (a) tombstone
origin sessions, **OR** (b) **store `originSessionName` ON `WorkspaceFinding` at promote time** (a
tiny additive field) so provenance survives deletion as a label — which again argues provenance
belongs in a **caption**, not an edge. **(b) is the cheaper unlock; ship it WITH Phase 4.0's caption.**

---

## (G) The owner decision agenda

1. **Framing — PAIN-justified or VISION bet?** No user pain is cited for a level-4 graph (CAPP-83 §4:
   "pick the lowest level that fixes an actual pain"; §3.5 leaned "let the harness memory be the
   wiki, don't rebuild it"). The only motivation is the owner's aspirational "interactive graph like
   in the video." **Recommendation: name it honestly as a VISION/DELIGHT bet, fund it as one, and
   only after the Phase-4.0 list MVP ships the actual jobs.**
2. **Ship Phase 4.0 (corpus mode + provenance caption) FIRST, then decide on the graph.**
   **Recommendation: yes** — 6 of 7 jobs, ~a day, no new panel/lib, and it's the honest gate.
3. **Visualization dependency (if funded): static tiered SVG, zero deps.** Physics/canvas out of scope
   (corpus is ~tens of nodes; no visual-regression harness → canvas = silent e2e hole). **Decline B/C/D.**
4. **Read-only vs. editable-in-graph: read-only; DROP editable-in-graph.** The editable home already
   shipped. (If E anyway: source `workspaceId` from the selected node.)
5. **Node/edge scope:** {workspace, session, finding(active/ruled-out/memory)} + {belongs-to,
   promoted-from(→session), supersedes(cross-tier-resolved)}, all derivable today. terminal OFF; emit
   a `summary` node; make a deliberate `provisionalFindings` call; file-ref/tag OUT.
6. **MCP exposure: do NOT add `"atlas"` to `show_panel` for v1** — open renderer-side only.
7. **HARD PREREQUISITE — provenance durability: store `originSessionName` on `WorkspaceFinding` at
   promote time** (ship with the 4.0 caption). (Tombstoning whole sessions is the heavier alternative.)
8. **Per-workspace default** (reuse `scopeFilter` via the caller's OWNING workspaceId, never
   `getActiveId()`); "all" opt-in; untagged is its own cluster; orphaned buckets in "all" only.

---

## (H) Risks

- The graph remains a **delight bet**, not a pain fix — its unique capability (2D adjacency) is weak
  at ~tens of nodes. Mitigated by gating it behind the Phase-4.0 list MVP.
- Even read-only, a heavy workspace can produce a large SVG — mitigated by the in-MVP node cap +
  single-`<g>`-transform pan + CSS-class selection.
- Provenance durability depends on the `originSessionName`-on-promote prerequisite shipping with the
  caption; without it the killer fact decays as sessions are deleted.

*Anchored against HEAD `ceabb65`. See `docs/roadmap/context-engine-design.md` §5/§8 and
`docs/roadmap/CAPP-83-second-brain-video-analysis.md` §3.1/§3.4/§3.5/§4.*
