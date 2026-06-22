# CAPP-83 — "Every Level of a Claude Second Brain" → context-engine findings

> **Purpose:** hand-off doc for the context-engine architect. Cross-walks an external
> YouTube framework (a 5-level "Claude second brain") against ClaudeTUI's context engine.
> **Provenance:** [CAPP-83](https://ryan1431.atlassian.net/browse/CAPP-83) · video "Every Level of a
> Claude Second Brain Explained". Analysis produced by a code-grounded multi-agent workflow,
> then **re-verified against the current tree at `1f704ce`** (the commit that shipped "The Lexicon" v1).
> **Status:** the original analysis was run against `d4e3820` — *before* CAPP-86. This doc reconciles
> it with what has since shipped, so most "actionables" are now **already designed or built**. Read §2 first.

---

## 1. Bottom line for the architect

Two takeaways:

1. **Strong convergence — treat it as independent validation.** An outside-in analysis of the
   video arrived at almost exactly the same plan the architect already wrote in
   `context-engine-design.md`: recall-first, **lexical not vector**, per-session JSON stays
   source-of-truth, capture/graph/embeddings deferred as ratify-gated phases, scope-default-to-workspace.
   The shipped `RecallService` (CAPP-86) *is* the analysis's top recommendation. Nothing here asks to redesign that.

2. **One material gap the shipped v1 and the design doc do NOT cover: kill-time data loss.**
   `RecallService` recalls only **live** sessions; `killSession` permanently deletes the record. So the
   second-brain's corpus silently shrinks every time the user hits Ctrl+K. This is the one item worth
   acting on now (§3.1). Everything else is either already-phased or a zero-cost flag.

---

## 2. Crosswalk — video level → current ClaudeTUI state (verified @ `1f704ce`)

| Video level | Maps to | Current state | Code / doc anchor |
|---|---|---|---|
| **L1 Files / router** | conversation resume + routing | **Covered** | `terminals.ts` path-routed resume; `folderConversations.ts`; `SERVER_INSTRUCTIONS` (`mcp/server.ts`). *Flag: our own `CLAUDE.md` is now a ~700-line dump — §3.2.* |
| **L2 Wiki / index (within session)** | the context engine | **Covered** | `sessions.ts` `setSummary` / findings ledger w/ `corrects`→`supersededBy` / `getContext` primer / Session Overview panel. |
| **L2 Wiki / index (across sessions)** | "have we learned this before?" | **SHIPPED — CAPP-86** | `electron/services/recall.ts` `RecallService.recall(query, scope)` + `summary()`; lexical scorer; `recall` MCP tool; RecallPanel. *This was the analysis's #1 actionable ("search_knowledge"). Done.* |
| **L3 Vector / semantic** | embedding recall | **Designed, ratify-gated** | design doc **Phase 2** (Transformers.js + all-MiniLM, local-only, optional `embedding?` on Note). Scorer is already a pluggable seam (`RecallScorer`) so it's an additive swap. Analysis agreed: **don't build until lexical recall measurably fails.** |
| **L4 Knowledge graph / wiki** | typed entities + traversal | **Designed, ratify-gated** | design doc **Phase 4** "The Atlas" (`links?: KnowledgeLink[]`, `corrects` as first edge). Analysis recommended **skip-until-pain**; the video author themselves doesn't run a graph. §3.5 has a wrinkle. |
| **L5 Autonomous cadence** | self-syncing | **Partial (orchestration strong, knowledge weak)** | `MissionService`/Supervisor = real L5 continuity. Knowledge-capture cadence = design doc **Phase 3** "The Ledger" (ambient capture into the dormant `provisionalFindings` seam), ratify-gated. §3.4. |

### Capture-first ("The Ledger") = the analysis's auto-capture actionable
The analysis's "idle-flush distills findings itself" idea is the design doc's **Phase 3**. Same seam
(`provisionalFindings`, dead today), same gating (structured-engine + noise-tuning), same ordering
(after recall proves demand). The analysis adds one **design constraint** for whoever builds it — §3.3.

### Things the design doc got right that the analysis only later credited
- **Lexical-first because of subscription login** (no API key → semantic must be local) — the design
  doc's framing is cleaner than the analysis's "privacy" framing and is the correct reason embeddings wait.
- **Primer enrichment** (`## Related from other sessions`, gated default-OFF) — a genuinely good idea the
  analysis did *not* propose; it makes inheritance cross-session without bloating the default primer.
- **Scope default = workspace** already resolves the analysis's cross-workspace-leak worry.

---

## 3. Net-new signal (what the design doc / v1 don't yet cover)

### 3.1 — Kill-time data loss: the corpus silently shrinks ⟵ **act on this**
**Verified:** `killSession` (`sessions.ts:557-565`) does `this.sessions.delete(id)` **and** `unlinkSync` the
JSON; `list()` (`sessions.ts:970`) returns only live sessions; `RecallService` indexes
`deriveRecallIndex(listSessions())` (`recall.ts:111,201`). **Therefore a killed session's summary +
entire findings ledger (active *and* ruled-out) vanish from disk and from the recall corpus, permanently.**

The design doc's load-bearing premise — *"the corpus is ALREADY populated by every session ever run"*
(§2) — is actually "every session **not yet killed**." Ctrl+K is deliberate teardown the user hits
constantly (often on wrong-path sessions, but also on *finished* ones), so the highest-signal findings —
including the **ruled-out / disproven** ones the doc itself calls "uniquely high-leverage" — are exactly
what gets destroyed.

**Options for the architect (pick one):**
- **(a) Tombstone instead of delete** — on `killSession`, mark the JSON archived/retired rather than
  `unlinkSync`, and have `RecallService` keep indexing retired sessions (filter them out of the *active*
  session list but not the recall corpus). Smallest change; preserves ruled-out signal; no new store.
- **(b) Graduate on retire** — promote active notes + final summary into a durable cross-session store
  *before* teardown (the design doc's reserved "Push context to workspace" seam). Heavier; introduces the
  second store the Lexicon deliberately avoided.
- **(a) is recommended** — it keeps source-of-truth singular and is purely subtractive-of-a-delete.

This is **not** in any of the doc's Phase 2–5 plans (Phase 5 mentions "NotesService→session linking,"
a different thing). It is a prerequisite for the Lexicon to mean what it says.

### 3.2 — "Route, don't dump": our own `CLAUDE.md` is the anti-pattern (zero-cost)
The video's L1 rule is *CLAUDE.md is a router, not a data dump.* Ours is ~700 lines — it became the data.
Thinning it into a true router (key-file tables + "where things live" + pointers, push detail into linked
docs) is the most on-video, lowest-cost improvement available and improves every session's token budget.
Not a context-engine ticket per se, but the architect owns the routing surface.

### 3.3 — Design constraint for Phase 3 capture: reach live, don't ingest
The video's sharpest principle is **evergreen context vs noisy connections**: ingest only durable
knowledge; reach volatile state *live*. ClaudeTUI already embodies this and it's uncredited —
`effectiveActivity`/`parseActivityLine`, the live-computed attention queue, read-only-live git tools all
reach volatile state instead of caching it. **Hand this to whoever builds Phase 3 as an explicit guardrail:**
the Observer should distill *durable* turn-outcomes (error→fix, disproven hypotheses), **not** snapshot the
transcript tail into the ledger — that would ingest exactly the noise the principle says to keep live, into
a seam (`provisionalFindings`) whose human-review action (Promote/Dismiss) is *still disabled in the UI*.
**Un-disable the Promote/Dismiss stub before automating ingestion into it.**

### 3.4 — Maintenance / staleness has no surface (the L2-killer)
The video's loudest L2 warning: *stale context silently kills value.* Our durable stores have
**correctness** decay (supersede/`corrects`) but no **freshness** decay — no last-reviewed, no age signal,
no "is this still true?" surface. As the corpus grows (and especially once 3.1 retains killed sessions),
recall will start returning confidently-stale hits with no way to flag them. Worth a Phase-5 line:
a recall hit could carry `createdAt` age (it already has it — `recall.ts:37`) and the panel could
de-emphasize / let the user retire stale entries.

### 3.5 — Phase 4 "Atlas" wrinkle: the linked wiki may already exist outside the app
Before building an in-app knowledge graph, note the **strongest linked-typed L2 wiki the project's agents
already use is the Claude Code harness memory dir** (`~/.claude/projects/.../memory/` — YAML frontmatter
`type:` + `[[wikilinks]]` + supersession). It's a harness feature, invisible to the app and not
workspace-aware — but it means the "typed nodes + backlinks" value is partly already realized for the
*author-agent*. Decision input for the Phase 4 ratification: is the Atlas a **user-facing** product surface
(justifiable), or are we rebuilding the dev scratchpad in-product (off-thesis)? The analysis leaned toward
**let the harness memory be the linked wiki; don't rebuild it** unless there's a user pain, not a dev convenience.

### 3.6 — Holistic privacy posture (partially addressed)
The design doc internalized the privacy constraint for the *embedding* decision (local-only). But there's
still **no `docs/roadmap` privacy posture** for the whole second-brain — every durable finding already
flows through Anthropic on the subscription path. The video raises this explicitly. Not urgent; worth one
paragraph in the design doc so the L3 deferral reads as a *posture*, not an accident.

---

## 4. The video framework (condensed reference)

Five levels, with one governing rule: **pick the lowest level that fixes an actual pain — climbing isn't
better, it's just more cost.**

1. **Files & folders** — routed plain markdown; test = *"can the agent AND I find it again?"*; CLAUDE.md routes.
2. **Wikis (context & index)** — linked/indexed context for *relationships*; rots if not maintained.
3. **Vector / semantic search** — meaning-based retrieval; **blind to whole-doc/aggregate questions** ("summarize all", "how many") because it returns chunks, not the document.
4. **Knowledge graphs** — typed entities + traversal; high build/maintain cost; author doesn't use one.
5. **Autonomous cadence** — self-syncing; **last**, only after the manual layer works ("don't automate what doesn't work manually").

Cross-cutting principles worth keeping: *work backwards from the question* (design retrieval before storage);
*route, don't dump*; *evergreen context vs noisy connections* (ingest durable, reach volatile live);
*lean on automemory*; *per-folder level-mixing is fine* (one store needn't be one level).

---

## 5. Recommended next actions (architect's call)

1. **Decide kill-time retention (§3.1)** — recommend tombstone-not-delete so the Lexicon corpus stops
   shrinking. Smallest viable ticket; unblocks the doc's own "every session ever run" premise.
2. **Un-disable Promote/Dismiss (§3.3)** before any Phase-3 ambient capture; fold the
   "distill-durable-not-snapshot-volatile" guardrail into the Phase-3 spec.
3. **Backlog one-liners:** thin `CLAUDE.md` into a router (§3.2); add a freshness/age signal to recall hits
   (§3.4); one privacy-posture paragraph in the design doc (§3.6).
4. **Phase 4 ratification (§3.5):** weigh in-app Atlas against the already-existing harness wiki before committing.
5. **No action:** L3 vector (Phase 2, gated) and the standalone L4 graph remain correctly deferred — the
   analysis and the design doc agree.

---

### Code anchors (verified @ `1f704ce`)
- `electron/services/recall.ts` — `RecallService`, `deriveRecallIndex` (`:111`), `lexicalScorer` (`:82`), `scopeFilter` (`:156`), `summary` (`:238`).
- `electron/services/sessions.ts` — `killSession` delete+unlink (`:557-565`), `list()` live-only (`:970`), `addNote`/`setSummary` emits (`:1090`/`:1147`).
- `docs/roadmap/context-engine-design.md` — "The Lexicon" design doc; Phases 2–5 in §5.
- Dead seams referenced: `provisionalFindings` (sessions.ts); Promote/Dismiss disabled in `src/components/panels/SessionOverviewPanel.tsx`.
