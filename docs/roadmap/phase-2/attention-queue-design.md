# Attention Queue — Design Spec

> Phase 2, feature 1. Brainstormed + approved 2026-06-11. Serves the identity thesis
> ([00-identity.md](../00-identity.md)): the app routes the user's attention; agents are
> first-class citizens who can both appear in and query that routing.

## Problem

A multi-session user constantly asks "who needs me?" Today the only signal is a pulsing
status dot per session. "Idle" conflates *finished* with *blocked waiting on a human*,
forms can sit unanswered for minutes, and nothing surfaces any of it when the user is in
another window.

## Decisions (settled in brainstorm)

1. **Triggers — all four, priority-tiered:**
   - Tier 1 `blocked` — a `show_form` is pending (mission checkpoints arrive via
     `show_form`, so they're the same kind; no separate checkpoint machinery in v1).
   - Tier 2 `asked` — terminal went idle AND the output tail shows Claude Code's
     input-prompt state (parsed).
   - Tier 2 `error` — an error/warning notification with session attribution fired.
   - Tier 3 `finished` — terminal went idle after a sustained active burst (≥10s
     guardrail) with no `asked` detection. Fresh spawns/blips never enqueue.
2. **Clearing:** focusing a terminal clears its tier-2/3 entries (`attention:seen`).
   Tier-1 entries clear ONLY when the form resolves (submit/cancel) — focus is not
   enough. Also cleared by: terminal/session kill, manual dismiss (hover ×).
3. **Placement:** sidebar section "NEEDS YOU (n)" pinned above WORKSPACES; absent
   entirely when the queue is empty.
4. **Away-from-app:** tier-1 enqueues also fire an in-app toast AND a Windows native
   notification (Electron `Notification`, main process) — the OS one only when the main
   window is not focused; clicking it focuses the app and jumps to the entry.
   Config: `attention.osNotifications` (default `true`).
5. **Architecture:** main-process `AttentionService` is the single source of truth
   (approach A). Renderer is a thin view. MCP-exposed.

## Data model

```ts
interface AttentionEntry {
  id: string            // stable per (kind, terminalId) — e.g. "blocked:term-3"
  tier: 1 | 2 | 3
  kind: "blocked" | "asked" | "error" | "finished"
  sessionId: string     // owning work-session
  terminalId?: string
  reason: string        // "form waiting", "asked you", error excerpt, agent's request text
  since: number         // epoch ms; wait time derives from this
}
```

- **Ordering:** tier ascending, then `since` ascending (oldest first within tier).
- **One entry per terminal:** a new signal for a terminal REPLACES its existing entry iff
  the new tier is higher (blocked > asked/error > finished); `since` is preserved across
  upgrades so wait time stays honest. Equal/lower-tier re-triggers refresh `reason` only.
- **No persistence:** the queue is runtime state. Pending forms don't survive restart;
  the queue rebuilds from live signals. Durable work-continuity is the session layer's
  job, not this surface's.

## Components

### AttentionService (`electron/services/attention.ts`)

Owns the queue + policy above. Subscribes to existing seams (constructor-injected,
fake-able in tests, matching the established service style):

- `PanelService` — gains `form:pending` / `form:resolved` events (it already holds the
  pending promise; this just makes the moments observable) → `blocked` enqueue/clear.
- `TerminalService` — state events (idle transition + activity-burst duration) and a new
  prompt-state detection (below) → `asked` / `finished`.
- `NotificationService` — error/warning notifications that carry a session id → `error`.
  Unattributable toasts behave exactly as today and never enqueue.
- API: `list()`, `dismiss(id)`, `seen(terminalId)` (clears tier-2/3 for that terminal),
  `request(sessionId, terminalId, reason)` (agent-initiated tier-2 entry).
- Emits `attention:updated` (full snapshot) to the main renderer on every change.
- Fires the tier-1 toast + OS notification (window-unfocused check lives here).

### Prompt detection (`electron/services/terminals.ts`)

A sibling of `parseActivityLine`: a pure exported function that, given the output tail at
the idle transition, answers "is Claude Code showing its input prompt / awaiting a
reply?". The exact pattern set is pinned during implementation against real transcript
tails (the work item requires fixture-based tests from captured output). TerminalService
emits the refined signal; policy stays in AttentionService.

### Renderer (`src/hooks/useAttention.ts` + `Sidebar.tsx`)

- Hook subscribes to `attention:updated`, exposes `{ entries, dismiss, jumpTo }`;
  `jumpTo` focuses session+terminal and sends `attention:seen`.
- Sidebar renders the "NEEDS YOU (n)" section from the hook; two-line rows
  (name / `reason · wait`), tier-tinted via theme tokens (all three themes), hover ×,
  ~30s wait-time tick. Section absent when empty.
- `Ctrl+J` jumps to the top entry (shortcuts overlay + CLAUDE.md updated).

### MCP (`electron/mcp/tools/sessions.ts`)

- `get_attention_queue` — read-only snapshot (lets a Conductor see if the human is
  backed up before raising another checkpoint).
- `request_attention` — agent enqueues itself with a reason (tier 2, `kind: "asked"`,
  reason prefixed as agent-requested); defaults to caller's identity like the other
  work-session tools. One line added to `SERVER_INSTRUCTIONS`.

### Config (`electron/config.ts`)

`attention: { osNotifications?: boolean }` (default true). Read via existing versioned
config loader; no schema bump needed (additive optional field).

## IPC / event flow

```
PanelService ──form pending/resolved──▶
TerminalService ──idle+burst / prompt-detected / killed──▶  AttentionService
NotificationService ──error w/ session id──▶                 │
MCP request_attention ─────────────────────▶                 │
                                                             ▼
                renderer ◀── attention:updated (snapshot) ── emit
                renderer ── attention:seen / attention:dismiss ──▶ service
                (tier 1) ── toast + OS Notification (if window unfocused)
```

New wire strings: `attention:updated`, `attention:seen`, `attention:dismiss` (+ preload
accessors). Follows the 4-step Service → IPC → MCP → Preload pattern from CLAUDE.md.

## Error handling

- Detection is best-effort: a parser miss degrades an `asked` into a `finished` (still
  visible, lower tier) — never a crash, never a blocked-state miss (tier 1 comes from
  PanelService's authoritative pending state, not parsing).
- OS notification failures (unsupported/disabled) are swallowed with a `logWarn`.
- All service handlers wrap in the established error pattern; renderer failures surface
  via the P0-5 toast path.

## Testing

- `electron/services/attention.test.ts` — fake emitters; covers: tier replacement +
  `since` preservation, burst guardrail (no enqueue <10s), focus-clears-tier-2/3 vs
  blocked-persists, form-resolve clears tier 1, dismiss, terminal/session-kill cleanup,
  ordering, `request()` entries.
- Prompt-parser unit tests against real captured transcript-tail fixtures (checked into
  the test file as strings).
- MCP tools: thin; covered via service tests. UI: manual smoke per project pattern
  (launch, trigger a form, watch section + toast + OS notification, Ctrl+J, dismiss).

## Delivery

| Item | Scope | Depends on |
|------|-------|-----------|
| AQ-1 | AttentionService + PanelService events + prompt detection + MCP tools + config + tests | — |
| AQ-2 | `useAttention` + Sidebar section + CSS (3 themes) + toasts/OS notifications wiring + Ctrl+J + docs | AQ-1 |

## Out of scope (v1)

- Persistence of queue across restarts; OS notifications for tiers 2/3; per-tier user
  configuration; snooze; companion-window rendering of the queue; distinguishing mission
  checkpoints from plain forms; sound.
