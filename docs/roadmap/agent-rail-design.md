# Agent Rail — Design Doc ("The Beacon")

> Status: PROPOSED — pending owner ratification of the Open Questions.
> Scope: a persistent, narrow, collapsible **right-edge column in the MAIN window** dedicated to **agent-initiated** output and asks. The companion window (user-initiated rich panels) stays as-is per firm owner decision.

## 1. Purpose & the gap it fills

ClaudeTUI today has four would-be information surfaces, but only three exist in the main window and none of them is a stable "here is the live agent and exactly what it needs from me" anchor:

- **Left sidebar** = container + navigation state, and the canonical *urgent* interruption queue (NEEDS YOU). It is multi-session and tier-1-bearing. It is *which agent needs me, across everything*.
- **Center transcript** (`AgentView`) = the verbatim conversation. It is the *past* — a scrolling log on a conversational clock.
- **Bottom composer** (`AgentComposer`) = user input for new turns.
- **Companion window** (`CompanionService` / `PanelService`) = rich, **user-initiated**, on-demand detail (diff, markdown, table, kanban board, session overview, worktree review).

The missing surface is a calm, **present-tense, agent-state** column: what is the agent doing right now, what has it learned, what is it waiting on me for — that stays put on the right edge while my eyes are on code in the center. That is **The Beacon**.

The Beacon is also the deliberately-chosen **visibility home for the two next initiatives**: the context engine / "second brain" (the KNOWS section) and missions (the WORKING section). Building it now creates the surface those features will need anyway, so they don't each invent their own main-window chrome.

## 2. The owner's three questions, answered head-on

### Q1 — What UI is missing for hidden functionality? (highest-value gaps the rail should fill)

The hidden-functionality audit found ~15 backend capabilities with weak or no main-window UI. The rail should fill these, ranked by value-per-effort:

1. **Per-session cumulative cost** (HIGHEST value, ZERO backend). `ResultCost` (costUsd, totalTokens, input/output/cache token classes) is already parsed per turn in `src/lib/agentTranscript.ts` and shown only as inline per-turn `CostChips`. Nothing totals it. The rail's **COST** footer sums it for the focused session. This is the single biggest "data exists, no surface" win.
2. **Live single-line turn activity** (NOW). `effectiveActivity` / parsed tool-call line + `useGeneratingTerminals` already drive the sidebar dot; the rail surfaces the human-readable current action + elapsed as a stable anchor that doesn't scroll away.
3. **Active mission status as a glanceable pointer** (WORKING). Mission state (`mission:updated`, `useMissions`) is rich in the companion dashboard but invisible in the main window except a sidebar row; the rail shows goal + progress + a link, and is the home for Supervisor state (reaped / paused-on-usage-limit / resuming) that is today *silent*.
4. **Second-brain digest** (KNOWS). `getWorkSessionContext` / `getOverview` (summary, findings, ruled-out, provisional) is only reachable by opening a companion panel via a sidebar button. The rail surfaces counts + the most-recent ruled-out one-liner so duplicate exploration is glanceable.
5. **Non-blocking agent signals** (AWAITING). tier-2/3 `asked` / `error` / `finished` attention entries (the `AttentionEntry` shape is real: tier, kind, sessionId, terminalId) get a calm glance surface, and — uniquely — an **inline answer** for `asked`.

Explicitly **out of scope for the rail** (belong elsewhere, see Q2): session/mission *event logs* and *timeline* (companion timeline panel + the unimplemented `session_timeline` tool — fix separately), conversation-history browsing (a sidebar/companion concern), provisional-findings Promote/Dismiss actions (complete those in the SessionOverview panel), and tool-loop heatmaps (a richer companion analysis, not a glance).

### Q2 — Ways the agent interacts via the rail, and the right home for each

Verdict table (the rail is the home only where it is the *uniquely best* surface; everywhere else it is a pointer):

| Interaction | Best home | Rail's role |
|---|---|---|
| 1. Streaming progress (tokens/tools) | **Transcript** | NOW: one quiet mirror line ("Editing X · 3 tools · 0:47"), click to scroll to tail. Never duplicates prose. |
| 2. Blocking forms / permissions | **Companion + sidebar** | A non-actionable LINK row only ("Approve diff (5 hunks) → Open") that focuses the companion. **Decision never happens in the rail.** |
| 3. Clarification question (prose) | **Rail (unique) + composer** | AWAITING `asked` row with an **inline mini-composer** (the Desk borrow) wired to existing `sendAgentInput`, so the turn resumes in place. |
| 4. Findings / notes | **Rail + companion** | KNOWS counts + most-recent ruled-out; "Open context →" opens SessionOverview. |
| 5. Errors / warnings | **Sidebar (canonical) + rail (glance)** | AWAITING error row, red-tinted; the *intentional* redundancy (sidebar = act, rail = glance). |
| 6. Task completion + cost | **Rail + toast** | AWAITING `finished` row with cost summary; COST footer absorbs the running total. |
| 7. **Mission / kanban board LINK** | **Rail (lighthouse) → companion (board)** | **YES — see Q2a.** |
| 8. Context engine digest | **Rail + companion** | KNOWS section (counts + summary + link). |
| 9. Worktree review request | **Sidebar (tier-1, canonical) + companion** | Rail shows it ONLY as a non-actionable link, if at all — it is tier-1, so by contract it is sidebar-first. |
| 10. Stalled / reaped worker | **Sidebar + companion dashboard** | WORKING sub-line ("worker reaped 2m ago — task requeued") for glance. |
| 11. Proposed diff preview | **Companion** | Link row only. |
| 12. Model / effort switch | **Transcript + composer pickers** | No rail surface (agent-decided, transient). |

**Q2a — The kanban-LINK seed idea: ENDORSED, exactly as proposed.** The board is too high-bandwidth for a 300px column and already lives in the companion `MissionPanel`. The rail's **WORKING** section is a *low-bandwidth lighthouse*: goal excerpt (one line) + a thin done/total progress bar + status chip + worker count + one always-visible **"View board →"** link that calls `window.api.showPanel('mission', {id})`. It renders the current + next-1 task title at most — never the full grid. It updates in place off `mission:updated` and self-clears when the mission finishes. This is the exact low→high bandwidth pattern Cursor 3 / Zed / VS Code agent rails converged on, and it directly answers "where is my work?" without cluttering the rail.

### Q3 — Is UI on all four edges good or bad?

**Good — but only with hard guardrails.** Four-edge layouts are the modern agent-IDE norm (Cursor 3 Agents window, Zed agent panel, VS Code) and succeed when **each edge has one distinct, calm role with zero actionable duplication**. They fail when edges compete for attention, auto-reveal actions, or duplicate lists. The guardrails that make ClaudeTUI's fourth edge earn itself:

1. **One role per edge, no bleed.** TOP = terminal tabs. BOTTOM = user input. LEFT = container/navigation + the *urgent* interruption queue. RIGHT = *ambient* agent state. The right is not a second sidebar.
2. **The non-overlap contract (the sharpest rule).** Tier-1 BLOCKING entries (forms, permissions, worktree review) appear **only** in the left sidebar + companion — **never** as an actionable item in the rail. The one *intentional* redundancy is errors (sidebar = act, rail = glance-narrative); everything else appears in exactly one actionable place.
3. **No hover-reveal, ever.** Every control (chevron, ×, "View board", inline Send) is always visible. Hover may shift opacity ≤10%, nothing more.
4. **Calm by construction.** Warm Sand & Stone tokens reused from the proven attention-queue rows; one-liners + truncation; content updates are a ~200ms settle, never a flash or color-strobe; **the rail NEVER auto-expands on agent activity** (that would re-introduce notification fatigue — a collapsed spine only tints an unread dot).
5. **Collapse-friendly + responsive.** Collapses to a 32px spine; defaults to spine below 1400px window width to protect the transcript's reading width; state persists per-workspace.
6. **A live four-edge dogfood check is a merge gate** (see Risks): open a real agent session at 1440px and confirm eyes don't ping-pong and the transcript doesn't feel cramped.

## 3. The recommended column — "The Beacon"

A pure-presentation React column (`src/components/AgentRail.tsx` + a `useAgentRail` family of hooks), mounted as a **third flex sibling of `.sidebar` and `.main-area`** inside `.app` (confirmed: those two are siblings of the root flex row in `App.tsx`). Full-height; never nested inside `.main-area`.

### Sections (top → bottom)

1. **HEADER (~36px, sticky).** "BEACON" label (11px tracked uppercase, `font-display`) + always-visible collapse chevron. Also a frameless-window drag region.
2. **NOW (live turn, always present).** One line mirroring the active terminal's current action + elapsed ("Editing terminals.ts · 3 tools · 0:47"); thin pulse bar only while generating (driven by `useGeneratingTerminals`); "Idle · last: ran tests" when quiet. Click → scroll transcript to tail. A *mirror* of transcript state, never a copy of its content.
3. **WORKING (mission lighthouse — present only when a mission is active in the focused session).** Goal excerpt + progress bar + status chip + worker count + "View board →". Supervisor sub-line when non-nominal. Owner's kanban-LINK, realized.
4. **KNOWS (context digest — present only when the session has accumulated state).** Count chips (findings / ruled-out / provisional) + 1-line summary + the single most-recent ruled-out one-liner + "Open context →". The context-engine home.
5. **AWAITING (tier-2/3 only, scrollable, ~5 rows).** Non-blocking signals (asked / error / finished) as tier-tinted two-line rows with always-visible × dismiss and click-to-jump. **For an `asked` entry on the active terminal: an inline mini-composer** (textarea + Send) wired to `sendAgentInput` so you answer the clarification in place and the turn resumes — the one capability no other surface has. **Tier-1 entries are filtered out** (sidebar-only). This is the only section that borrows from both The Margin (settling, dismissable rows) and The Desk (inline answer).
6. **COST (footer, always present when there is turn data).** "$0.41 · 128k tok · 9 turns", summed renderer-side from `ResultCost`. No sparkline/alert in v1 (budget alert is a later opt-in).
7. **EMPTY STATE.** When NOW is idle and WORKING/KNOWS/AWAITING are empty: a single quiet "Agent idle · queue clear" line. Never auto-hides, never auto-expands.

### What it OWNS vs POINTS TO

- **Owns (sole home):** per-session cumulative cost; the present-tense single-agent activity mirror; the glanceable list of tier-2/3 non-blocking signals; and the inline answer of an `asked` clarification (the transcript composer is for new turns, not for resuming a parked question).
- **Points to (owns nothing — live links):** the mission board (companion `MissionPanel`), session context/findings (companion `SessionOverviewPanel`), all blocking forms/diffs/permissions/reviews (sidebar + companion).
- **Never:** the conversation (transcript), a panel gallery (companion), or the cross-session interruption list (sidebar). The rail reflects only the **active** terminal, so it never competes with the sidebar's multi-session queue.

### Collapse / width

- Expanded **300px** (320px on >1920px). Collapses to a **32px spine** showing a rotated label + expand chevron + (if any) a tiny tier-tinted unread dot for AWAITING.
- Toggle: header chevron + command-palette "Toggle the Beacon" + **Ctrl+Alt+B**. State persists per-workspace via the existing config write-path (same pattern as `theme.mode` / focus-mode).
- Defaults to spine below 1400px width (one-time soft hint). Width change eases 150ms. **Never auto-expands on activity.** Not drag-resizable in v1 (two fixed widths keyed to window size — deliberate calm/simplicity tradeoff).

### The agent → column mechanism

The Beacon is **a lens over seams that already flow to the main renderer** — no new service, no data ownership, confirmed against the code:

- **NOW** ← `onTerminalState` + `useGeneratingTerminals` + `effectiveActivity` (zero backend).
- **WORKING** ← `mission:updated` / `useMissions` (zero backend).
- **KNOWS** ← `getWorkSessionContext` / `getOverview` (existing IPC), made live by one **additive** `worksession:updated` emit mirroring `mission:updated` (or refresh-on-focus in the first cut).
- **AWAITING** ← `attention:updated` / `useAttention` snapshot, **filtered to tier-2/3** of the active terminal (tier-1 + mission/review-routed kinds excluded). Inline answer ← existing `sendAgentInput` → `agent:send-input` → `TerminalService.sendAgentMessage`.
- **COST** ← sum `ResultCost` (already parsed in `agentTranscript.ts`) over the active terminal's result blocks — pure renderer derivation.
- **Collapse/toggle** ← one new `ui:beacon` UiService event mirroring `setFocusMode`/`ui:focus-mode` + a config field. The documented "renderer-only UI action → MCP" recipe gives a free `set_beacon(open?)` MCP tool so Claude can open it if needed — but the default is **zero new agent plumbing**; the rail is a lens over what agents already drive.

Net new code: an `AgentRail` component family + one UiService method + one optional `worksession:updated` push. **No service rewrites; additive only; the app is byte-identical when the rail is collapsed-and-empty.** Matches the codebase's Service → IPC → MCP → Preload pattern exactly.

## 4. How it stays distinct from the companion window and the transcript

- **vs Companion (user-initiated, rich, on-demand):** the rail never embeds a panel. It posts a *link/pointer* that opens the companion (`showPanel(...)` / `focusCompanion()`). Companion = high-bandwidth detail the user pulls; rail = low-bandwidth state the agent pushes ambiently. Diffs, the kanban grid, the full session overview, forms — all stay in the companion.
- **vs Transcript (verbatim, conversational clock):** the rail mirrors the transcript's *NOW state* and links back ("jump to tail"), but never duplicates streamed prose. Workflow cadence (rail) and conversational cadence (transcript) run on different clocks; the rail lets you stop reading the firehose and still stay oriented.
- **vs Sidebar (urgent, multi-session, container):** sidebar = which agent needs me across everything + tier-1 gates (canonical). Rail = this active agent's ambient state. No actionable entry appears in both except errors (intentional dual glance).

## 5. Why Beacon over Margin/Desk (and what we borrowed)

- **Margin (chronological feed):** rejected as the *primary* frame — it re-creates the transcript's clock, risks triple-noise with sidebar + toast (its own authors flag this as "the design's sharpest edge"), grows long on busy sessions, and its richest beats depend on agents calling `agent_beat` or on heuristics for terminals that often self-report nothing. **Borrowed:** the settling, dismissable, tier-tinted row treatment lives inside AWAITING.
- **Desk (single-agent answer slot):** rejected as the *whole* frame — single-active-agent scoping is too narrow to be the entire column, and an always-present inline composer risks "type here or down there?" confusion. **Borrowed (its one unique superpower):** the inline reply for a parked tier-2 `asked`, promoted into AWAITING and visually framed as a *reply to a specific question*, not a general composer.
- **Beacon:** chosen as the skeleton because every section is a lens over an existing stable seam (purely additive, calm sectioned dashboard, degrades gracefully when empty), and it is the natural pre-wired home for both next initiatives.

## 6. Phased build plan

- **Phase 0 — Ratify (no code):** owner locks name, collapse floor, default visibility, and the non-overlap contract.
- **Phase 1 — Shell + NOW + COST + collapse (v1, ~1 day, ZERO backend):** mount the column; header + chevron; NOW from `useGeneratingTerminals`/`effectiveActivity`; COST from existing `ResultCost`; collapse-to-spine + per-workspace persist + palette toggle + Ctrl+Alt+B + sub-1400px auto-collapse; empty state. Byte-identical when collapsed. Cashes in the biggest hidden win (per-session cost) and proves the calm contract.
- **Phase 2 — WORKING (mission lighthouse, ~0.5 day, zero backend):** `useMissions`/`mission:updated` → goal + progress + chip + worker count + "View board →" `showPanel('mission')`. Delivers the kanban-LINK seed.
- **Phase 3 — KNOWS (context digest, ~0.5–1 day):** `getWorkSessionContext`/`getOverview` → counts + summary + most-recent ruled-out + "Open context →"; add the one additive `worksession:updated` emit (or refresh-on-focus). Context-engine home.
- **Phase 4 — AWAITING + inline answer (the Desk borrow, ~1 day):** tier-2/3 entries scoped to active terminal as settling dismissable rows reusing NEEDS-YOU styling; inline mini-composer on `asked` via `sendAgentInput`; tier-1 filtered out.
- **Phase 5 — Polish (later, optional):** Supervisor reap/pause sub-line (small additive snapshot field); opt-in per-session cost budget alert; a11y (labels, focus indicators); `set_beacon` MCP toggle.

## 7. Risks

1. **Four-edge crowding at ≤1440px** — mitigated by default-collapse below 1400px; **a live agent-session dogfood at 1440px is a merge gate** (verify eyes don't ping-pong, transcript not cramped).
2. **Sidebar/rail tier-2/3 overlap reading as duplication** — mitigated by an airtight tier-1-excluded filter and the "sidebar = act, rail = glance" framing; must be policed in review.
3. **NOW staleness** — it is a derived mirror; if `effectiveActivity` lags (headless terminal not self-reporting), the line can feel slightly behind the transcript. Same limitation the sidebar activity line already has; acceptable for a glance.
4. **Cost accuracy** — renderer-side summation resets on transcript rehydrate (BO-12) and misses scrolled-out turns. Accurate-enough for a glance, not an audit; a durable per-session total (a SessionService field) is a later option (see Open Questions).
5. **Three places cost appears** (inline CostChips, rail COST, future overview) — must be framed as per-turn vs per-session or it reads as redundant.
6. **KNOWS depends on the context engine actually accumulating state** — until agents reliably call `set_session_summary`/`session_note`, the section is often empty; it must degrade gracefully (count chips + summary simply absent), never look broken.
7. **Inline-answer composer confusion** — the AWAITING reply must be visually, unmistakably a *reply to a specific question* (quoted prompt + scoped Send), not a second general composer, or it muddies the bottom edge's role.

## 8. Open questions (must ratify before build)

See the `openQuestions` list — name, collapse floor, default visibility, inline-answer phasing, cost durability, the four-edge live-check gate, the `worksession:updated` push, and background-agent question scoping.
