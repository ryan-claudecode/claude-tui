# Workspace Memory Tier + Delete-Time Keep/Trim/Edit Flow — FINAL Implementation Plan (CAPP-87)

This is the authoritative plan. Every adversarial **blocker** and **major** from the
design-lock workflow (`wf_f723ca75-251`, 36 issues / 22 blocker-major across 4 critique
lenses) is incorporated into the design below; each **minor/nit** is explicitly resolved or
deferred in section (J). All anchors verified against the live tree on 2026-06-22.

> Origin: ratified two-tier brain decision (owner, 2026-06-22) — "brain as a sum of session
> JSONs is a *view*, not a *store*"; we add a first-class, durable workspace-level tier, with a
> delete-time prompt that defaults to promoting **all** findings but lets the user trim/edit
> before promoting.

---

## (A) Ratified two-tier model summary — also appended to `docs/roadmap/context-engine-design.md`

> ### The two-tier brain: Workspace Memory + live session findings
>
> The Lexicon now has **two** durable knowledge tiers. The brain a fresh agent inherits is
> **workspace memory (always present) ∪ live session findings (derived, as today)**.
>
> 1. **Workspace Memory** — a NEW first-class tier: durable, workspace-level standing
>    context/instructions plus *promoted findings*, persisted with the **workspace**, NOT with
>    any session. It survives **all** session deletion. Stored as one file per workspace under
>    `~/.claude-tui/workspace-memory/<workspaceId>.json` (a sentinel file for the untagged "All"
>    bucket), owned by a NEW `WorkspaceMemoryService`. Editable directly by the user and
>    writable by agents via new MCP tools.
> 2. **Live session findings** — the existing per-session `notes[]`/`summary` ledger in
>    `~/.claude-tui/sessions/<id>.json`, owned by `SessionService`, derived into recall by
>    `RecallService` exactly as today.
>
> **The bridge — promotion.** A session finding can be *promoted* up to workspace memory. This
> is the mechanism that decouples knowledge from session lifecycle. A promoted finding is a
> structural copy of the origin `Note` plus provenance (`originSessionId`, `originNoteId`).
> Promotion does **not** remove or supersede the origin note — both coexist; recall de-dups them
> so each logical finding is counted exactly once (de-dup key = the **(originSessionId,
> originNoteId)** pair).
>
> **Promotion is workspace-bound to the OWNING session.** A finding belongs to a session, and
> that session has a stamped `workspaceId`. Promotion (delete-time, standalone MCP, or the
> overview push button) always resolves its destination from the **owning session's**
> `workspaceId` — never the caller's workspace and never the global active selection. Silent
> cross-workspace re-homing is rejected.
>
> **Delete-time decision (no silent default).** Killing a session (Ctrl+K / sidebar ✕) opens a
> **blocking main-window modal** offering **Keep & delete** (promote the dying session's
> findings to its workspace memory) vs **Delete everything** vs **Cancel**. "Delete everything"
> is *exactly today's `killSession` semantics* — it deletes the session record + PTYs, NOT the
> Claude transcript on disk (worded honestly in the modal). The Keep flow defaults to promoting
> **all** findings (active *and* ruled-out — ruled-out findings are the highest-value rescue) but
> presents a reviewable, editable, per-row-deletable list, every row pre-selected. **Workspace
> memory is never at risk in this dialog** — only the dying session's own findings.
>
> **Scope/privacy posture (explicit).** Workspace memory participates in `RecallService` scoping
> identically to notes: default `workspace` scope (no cross-workspace leak), invisible under
> `session` scope, and returnable under the explicit `all` opt-in (documented, rare). The
> untagged "All" bucket is a **global, cross-project shared scope** — documented as such. Agent
> writes from an untagged session land in the untagged bucket; they never fall back to the
> global active UI selection (that would be a cross-workspace write leak).
>
> **LATER (out of scope, do not architect against):** an interactive graph ("The Atlas") will
> visualize both tiers and become the home for promote/edit. Nothing here precludes it —
> promotion and editing are service methods the Atlas can reuse.

---

## (B) Final data model + storage location (+ migration)

**Location:** `~/.claude-tui/workspace-memory/<workspaceId>.json`, one file per workspace, owned
by NEW `electron/services/workspaceMemory.ts`. Mirrors the per-session layout and uses the
identical `saveVersioned`/`loadVersioned` envelope (`persist.ts:118`/`:47`). The "survives ALL
session deletion" guarantee is **structural**: `killSession`'s `unlinkSync` only touches
`sessions/<id>.json` (verified `sessions.ts:564`) — no kill path touches `workspace-memory/`.
**The workspaces registry stays at `SCHEMA_VERSION = 2`, untouched** (no hot-path bloat on the
high-frequency discovery/rescan `persist()` at `workspaces.ts:253-261`).

**Untagged bucket — collision-proof sentinel** (resolves blocker "`__all__` can collide with a
real workspace id"). The untagged bucket is keyed **internally by a non-string sentinel**
(a module-private constant `UNTAGGED_KEY` that is NOT a valid workspaceId). It maps to the
filename `__untagged__.json` via a single `fileFor()` function that **rejects** any real
`workspaceId` equal to the sentinel stem. Defensively:
- Every public method (`getMemory`/`setInstructions`/`addFinding`/`editFinding`/`deleteFinding`/
  `promoteFindings`/`deleteForWorkspace`) treats `null`/`undefined` as the untagged bucket and
  **rejects a literal string equal to the sentinel stem** (throws / no-ops with `logWarn`).
- `WorkspaceService.loadAll()` (`workspaces.ts:220-247`) gains a guard: a persisted/hand-edited
  workspace whose `id` equals the sentinel stem is **refused** (logged + skipped).

**Schema:** greenfield `SCHEMA_VERSION = 1`, `MIGRATIONS: Migration[] = []` (same posture as
`sessions.ts`). Forward-compat is safe: `loadVersioned` loads a newer-than-supported file as-is
without migration or read-repair (verified `persist.ts:79-86`). A missing file → `getMemory`
returns an empty record.

**`source` union — pinned to the SUPERSET before any code lands** (resolves major "source type
domain contradiction"). A directly-authored finding (user/agent) and a promoted finding (copied
`self`/`observer`) must both be representable at `SCHEMA_VERSION=1` with no later coercion:

```typescript
// electron/services/workspaceMemory.ts
export const SCHEMA_VERSION = 1
export const MIGRATIONS: Migration[] = []

/** Provenance of a workspace finding. PINNED SUPERSET so promote (copies "self"|"observer"
 *  verbatim from a Note, sessions.ts:79) AND direct authoring (user/agent) are both valid
 *  at v1 with no migration. */
export type FindingSource = "self" | "observer" | "user" | "agent"

export interface WorkspaceFinding {
  id: string                    // RE-MINTED at this tier (note-<now>-<rand>, sessions.ts mint scheme)
  text: string
  createdAt: number             // ORIGIN finding's createdAt copied as-is; === promotedAt for authored
  source: FindingSource         // copied through for promotions; "user"/"agent" for direct authoring
  status: "active" | "superseded"   // "superseded" == ruled-out, carried verbatim
  supersededBy?: string         // re-pointed to the WORKSPACE twin id within a batch (see below)
  // provenance (NEW at this tier):
  originSessionId?: string      // undefined for an agent/user-authored finding
  originNoteId?: string         // the session Note.id copied from — half of the DE-DUP KEY (§C)
  promotedAt: number            // when graduated/authored (DISTINCT from createdAt — freshness signal)
}

export interface WorkspaceMemoryRecord {
  workspaceId: string           // the real id; the untagged bucket's record carries the sentinel stem internally only
  instructions: string          // durable standing context/instructions (workspace-tier analogue of session summary)
  findings: WorkspaceFinding[]
  createdAt: number
  updatedAt: number
}

export interface PromoteEntry {
  text: string
  originSessionId?: string
  originNoteId?: string
  createdAt?: number
  status?: "active" | "superseded"
  supersededBy?: string         // origin Note.supersededBy (a session note id), rewritten on promote
  source?: FindingSource
}
```

**Supersede (corrects) link — graph closed over its own ids** (resolves minor "orphaned-corrector
downgrade mutates meaning"). On a promote batch: re-mint every finding id first, building an
`oldNoteId → newFindingId` map; rewrite any in-batch `supersededBy` through the map. **If the
corrector is NOT in the batch (user trimmed it): keep `status:"superseded"` and set
`supersededBy: undefined`** — do NOT downgrade to `active` (that would resurrect a disproven
claim as true knowledge). `getOverview`/`getContext` already tolerate a corrector-less superseded
note by omitting the arrow (verified `sessions.ts:1172`, `:1202-1203`), so a bare strikethrough
renders correctly with no dangling lookup. The recall renderer must do the same (§C / §J).

**Idempotency on (originSessionId, originNoteId)** (resolves major "crash/kill-twice
double-promote"). `promoteFindings` is idempotent: before minting, it checks whether a workspace
finding with the same `(originSessionId, originNoteId)` already exists in the target record. If
so it **updates that finding in place** rather than minting a second. This closes both the
crash-replay window (promote saved, kill not yet unlinked → restart → kill-Keep again) and the
"kill twice choosing Keep" path. Authored findings (no `originNoteId`) always mint fresh.

**Every mutator lazy-loads-or-creates first** (resolves nit "never-read workspace clobber").
Each mutator resolves the target record through the same lazy-load-or-empty path `getMemory`
uses **before** mutating, so a promote into a workspace whose file was never read appends rather
than overwriting on-disk findings.

---

## (C) RecallService union + de-dup — EXPLICIT double-count resolution

`RecallService` derives its entire index from `listSessions()` only (`recall.ts:111-144`,
`:201`) and is read-only by contract. We add a **second injected source** — never reaching into
the memory service directly.

### C1. Index/type additions
- `RecallEntry` (`recall.ts:28-40`): add `source: "note" | "summary" | "workspace-memory"`; add
  optional `originSessionId?` and `originNoteId?`.
- `RecallSummary` (`recall.ts:48-57`): add **always-present** `workspaceMemory: { findings:
  number; ruledOut: number }` (never omitted — keeps the shape uniform so existing `toEqual`
  assertions are updated once; see §G).

### C2. Combined derive — MANDATED single signature (resolves major "rename-or-add wavering breaks suppression")
There is no "separate function" option. The signature is **`deriveRecallIndex(sessions,
memoryFindings)`** — the suppression in C3 requires the session-note pass to already know the
full promoted-origin set. `getIndex()` (`recall.ts:200-203`) becomes:

```ts
private getIndex(): RecallEntry[] {
  if (this.index === null)
    this.index = deriveRecallIndex(this.listSessions(), this.listWorkspaceMemory().flatMap(m => m.findings))
  return this.index
}
```

Each `WorkspaceFinding` emits one entry: `{ sessionId: "__workspace_memory__", sessionName:
"Workspace memory", workspaceId: <normalized>, text, status (active|ruled-out), source:
"workspace-memory", createdAt, originSessionId, originNoteId, correction? }`.

**Untagged workspaceId normalization** (resolves the blocker + its minor twin). The emitted
`workspaceId` MUST be the **scope value**, not the storage key: `workspaceId: record.workspaceId
=== <sentinel stem> ? undefined : record.workspaceId`. `scopeFilter` matches workspace scope by
`(e.workspaceId ?? undefined) === (caller.workspaceId ?? undefined)` (`recall.ts:166`); an
untagged caller has `caller.workspaceId === undefined`, so the untagged bucket's entries must
carry `undefined` to match. The sentinel/`__untagged__` string must never reach `scopeFilter`.

### C3. THE DE-DUP — each promoted finding counted EXACTLY ONCE

**Risk A — origin-note double-count in the union index.** A promoted finding whose origin
session still exists yields two entries (the live `Note` + the workspace-memory copy). **De-dup
key = the (originSessionId, originNoteId) PAIR** (resolves major "bare note-id collision
suppresses a different workspace's note"), NOT a content hash (the Keep flow lets users edit
text, so an edited promotion would never hash-match) and NOT a bare note id. In the combined
derive:

```ts
const promotedKeys = new Set(
  memoryFindings
    .filter(f => f.originSessionId && f.originNoteId)
    .map(f => `${f.originSessionId}|${f.originNoteId}`)
)
// when emitting a session note entry, skip iff BOTH session id and note id match:
if (promotedKeys.has(`${s.id}|${n.id}`)) continue
```

The workspace-memory copy wins; the origin note is suppressed from the **index** (never deleted
from disk). Promotion does NOT remove/supersede the origin note — the live note legitimately
shows in the caller's "This session" digest; the workspace copy is the durable twin.

**Best-effort caveat — supersede-after-promote** (resolves major "de-dup fails when origin
re-summarized"). Suppression covers the unchanged-origin case. If, after promotion, the origin
note is *itself* superseded in-session (a new note with a new id corrects it), the live finding's
id no longer matches `originNoteId`, so both can surface. This is **documented as best-effort,
workspace-memory-wins-on-the-original**. A test pins the chosen behavior. We do not chase the
supersession chain (revisit with the Atlas).

**Risk B — cross-tier double-count between the two rail digests.** `summary()` excludes the
caller's own session by `e.sessionId === caller.sessionId` (`recall.ts:255`). A workspace-memory
entry has a synthetic `sessionId`, so a finding *promoted from the caller's own session* would
slip the check. Fix `recall.ts:255`:
```ts
if (caller.sessionId && (e.sessionId === caller.sessionId || e.originSessionId === caller.sessionId)) continue
```

### C4. `summary()` loop restructure — memory counted in its OWN branch BEFORE the continue (resolves major "same-loop contradiction")
The Risk-B `continue` skips the whole iteration, so workspace-memory counting cannot live after
it. Restructure so workspace-memory entries are handled in a **dedicated branch placed BEFORE**
the self/origin `continue`, and the cross-session accumulation is guarded with `e.source !==
"workspace-memory"` (resolves major "recentRuledOut picks a workspace-memory entry" + "phantom
session in count"):

```ts
for (const e of scoped) {
  if (e.source === "workspace-memory") {
    // Memory digest: exclude only findings promoted FROM the caller's own session
    // (its live note already shows in "This session"); still count agent/user-authored
    // memory and memory promoted from OTHER sessions.
    if (caller.sessionId && e.originSessionId === caller.sessionId) continue
    if (e.status === "ruled-out") wmRuledOut++
    else if (e.status === "active") wmFindings++
    continue   // never feeds sessionIds, findings, ruledOut, or recentRuledOut
  }
  // ── cross-session ("other sessions") digest, unchanged except the origin guard ──
  if (caller.sessionId && (e.sessionId === caller.sessionId || e.originSessionId === caller.sessionId)) continue
  sessionIds.add(e.sessionId)
  if (e.source === "note" && e.status === "active") findings++
  else if (e.status === "ruled-out") { ruledOut++; /* recentRuledOut update */ }
}
return { sessions: sessionIds.size, findings, ruledOut,
         workspaceMemory: { findings: wmFindings, ruledOut: wmRuledOut },
         ...(recent ? { recentRuledOut: recent } : {}) }
```

Guarantees: workspace memory never adds a phantom session to `sessions`, never feeds the
cross-session `recentRuledOut`, and the memory digest excludes only the caller's just-promoted
finding.

### C5. Scope + privacy posture (explicit decisions)
- **`session` scope:** the synthetic `sessionId` never matches a real session → workspace memory
  is **invisible under `session` scope** (deliberate; documented inline in `scopeFilter`).
- **`workspace` scope (default):** memory matches its real (normalized) `workspaceId`; untagged
  callers see only the untagged bucket. No cross-workspace leak.
- **`all` scope:** memory participates identically to notes — returnable cross-workspace. An
  **explicit, documented opt-in** (resolves major "`all`-scope surfaces every workspace's
  memory"): one paragraph in `scopeFilter` + the `recall` tool description. A test asserts it.
- **Untagged bucket = GLOBAL shared scope:** documented in the design doc and the editor UI
  (resolves minor). We do NOT infer a workspace from terminal cwd (deferred to CAPP backlog).

### C6. Rail third KNOWS group — FULL renderer chain (resolves major "third KNOWS group unplumbed" + major "deriveKnowsRecall has no slot")
Adding `workspaceMemory` to the backend `RecallSummary` does nothing until the renderer chain
carries it:
- `src/lib/agentRail.ts`: add `workspaceMemory?: { findings: number; ruledOut: number }` to
  `KnowsRecallInput` (`:211-217`); add a new `KnowsWorkspaceMemory` interface; add
  `workspaceMemory: KnowsWorkspaceMemory | null` to `RailKnows` (`:253-261`); add a pure
  `deriveKnowsWorkspaceMemory(rs)` helper with its **OWN non-empty test** (`rs.workspaceMemory.
  findings > 0 || rs.workspaceMemory.ruledOut > 0`) — do NOT reuse `deriveKnowsRecall`'s gate
  (`rs.sessions <= 0`, `:319`) which would wrongly hide memory when no other session contributed
  (memory is "always present"). Fold into `deriveKnows`'s `hasContent` (`:286`).
- `src/hooks/useAgentRailKnows.ts`: pass the new digest through to `deriveKnows`.
- `AgentRail.tsx`: render the third group.
- **Fix the stale doc-comments** at `agentRail.ts:206-217` + `:243-244` (resolves nit) — they
  claim `summary()` "counts EVERY session / has no exclude-self," already false (`recall.ts:255`
  excludes the caller). Correct them.

### C7. Primer + invalidation wiring
- **Primer closure (`ipc.ts:78-84`):** add the origin exclusion `&& h.originSessionId !==
  sessionId`. Decision (resolves minor): the primer block stays titled "Related from other
  sessions" and **does include** workspace-memory hits as legitimate cross-context knowledge. A
  test pins that a user-authored (no-origin) memory entry is eligible.
- **RecallPanel + `renderRecallHit` audit (resolves minor):** confirm both render a
  `source: "workspace-memory"` / synthetic-`sessionId` hit acceptably (citation "Workspace
  memory") and a corrector-less superseded hit shows a bare strikethrough (no dangling arrow).
- **Invalidation (resolves both construction-order majors):** see §D2 for the pinned construction
  order. Memory writes invalidate recall via a new `onMemoryChanged` seam →
  `recallService.invalidate()` + a renderer push. `listWorkspaceMemory()` reads the in-memory
  `Map` only (no disk re-read), matching the in-memory derive posture.

---

## (D) Service / IPC / MCP / preload surface (named)

### D1. `WorkspaceMemoryService` (NEW — `electron/services/workspaceMemory.ts`)
Constructor `{ dir?: string; now?: () => number }` (dir defaults to
`~/.claude-tui/workspace-memory`). In-memory `Map<string, WorkspaceMemoryRecord>` cache; lazy
per-id load. Every mutator: lazy-load-or-create the target record, mint/re-mint ids, set
timestamps, `saveVersioned`, then `emitMemoryChanged(workspaceId)`. The untagged sentinel is
rejected as an explicit `workspaceId` arg everywhere.

```typescript
getMemory(workspaceId: string | null): WorkspaceMemoryRecord
setInstructions(workspaceId: string | null, text: string): WorkspaceMemoryRecord
addFinding(workspaceId: string | null, text: string, source: "user" | "agent"): WorkspaceFinding
editFinding(workspaceId: string | null, findingId: string, text: string): boolean
deleteFinding(workspaceId: string | null, findingId: string): boolean
promoteFindings(workspaceId: string | null, entries: PromoteEntry[]): WorkspaceFinding[]  // re-mint ids, rewrite in-batch supersededBy, idempotent on (originSessionId, originNoteId)
listWorkspaceMemory(): Array<{ workspaceId: string; findings: WorkspaceFinding[] }>        // in-memory, for RecallService injection
deleteForWorkspace(workspaceId: string): void                                              // unlink one real workspace's file; REFUSES the untagged sentinel (logWarn)
onMemoryChanged(cb: (workspaceId: string) => void): () => void                             // callback seam, mirrors WorkspaceService.onActiveChanged
```
> The **derive** step (§C2) is the single place that normalizes the untagged key to `undefined`
> on the emitted `RecallEntry`.

### D2. Construction order — PINNED in `ipc.ts` (resolves both construction-order majors)
- Add `export const workspaceMemoryService = new WorkspaceMemoryService()` at **module scope**,
  right after the other `export const` services (near `ipc.ts:48`), **BEFORE** the
  `recallService` forward-`let` block (`:62`). `BrowserWindow`-free → module-scope safe.
- Change RecallService construction at `ipc.ts:86`:
  ```ts
  recallService = new RecallService(() => workSessionService.list(), () => workspaceMemoryService.listWorkspaceMemory())
  ```
- **Inside `setupIpc(win)`**, register:
  ```ts
  workspaceMemoryService.onMemoryChanged((workspaceId) => {
    recallService.invalidate()
    if (!win.isDestroyed()) win.webContents.send("workspace:memory-changed", workspaceId)
  })
  ```
- **Workspace-delete memory cleanup is wired at the IPC HANDLER level, NOT via a WorkspaceService
  seam** (resolves both "WorkspaceService.delete has no hook" majors). `WorkspaceService.delete()`
  only emits active-changed, and only for the active workspace (`workspaces.ts:389`).

> **DECISION on workspace-delete semantics** (resolves major "deleteForWorkspace inverts the
> durable-tier invariant"). `WorkspaceService.delete()` removes only the registry entry; it does
> NOT delete or re-tag the workspace's session files (`workspaces.ts:378-391`). Wiping curated
> memory while the feeding sessions persist inverts "memory is the durable tier."
> **Resolution: workspace delete does NOT auto-wipe memory** in v1. The memory file is left
> **orphaned-but-recoverable** on disk. `deleteForWorkspace` is still implemented (for a future
> explicit "delete workspace AND its memory" affordance and for tests) but is **not**
> auto-invoked. Conservative, data-safe.

### D3. `SessionService` read helpers (NEW — `electron/services/sessions.ts`)
```typescript
getPromotableFindings(sessionId: string): PromoteEntry[]
getPromotableFinding(sessionId: string, noteId: string): PromoteEntry | undefined
```
`getPromotableFindings` maps the dying session's `notes` (active AND superseded) into
`PromoteEntry[]`, carrying `originNoteId = n.id`, `originSessionId = sessionId`, `createdAt`,
`source`, `status`, `supersededBy`. **Decision on `provisionalFindings`:** v1 promotes only
confirmed `notes`; `provisionalFindings` (observer seam, unconfirmed) are **excluded** and
documented. Pure reads.

### D4. Promote-then-kill orchestration (atomic, handler-level)
```ts
// worksession-handlers.ts
ipcMain.handle("worksession:kill-with-promote", (_e, sessionId: string, editedEntries: PromoteEntry[]) => {
  const wsId = workSessionService.get(sessionId)?.workspaceId ?? null   // OWNING session's workspace (get() at sessions.ts:969)
  workspaceMemoryService.promoteFindings(wsId, editedEntries)            // FIRST — if this throws, the kill below never runs
  workSessionService.killSession(sessionId)                             // sessions.ts:557
})
```
If promote throws, the session survives with findings intact (fail-safe). Idempotency (§B) makes
a crash between the two calls safe on the next Keep.

### D5. IPC channels
`electron/ipc/workspace-handlers.ts` (thread `workspaceMemoryService` into `deps`):
```
workspace:get-memory            (workspaceId|null) -> WorkspaceMemoryRecord
workspace:set-instructions      (workspaceId|null, text)
workspace:add-finding           (workspaceId|null, text, source)
workspace:edit-finding          (workspaceId|null, findingId, text)
workspace:delete-finding        (workspaceId|null, findingId)
workspace:promote-findings      (workspaceId|null, entries)
```
`electron/ipc/worksession-handlers.ts`:
```
worksession:promotable-findings (sessionId) -> PromoteEntry[]    // the Keep modal's editable list
worksession:kill-with-promote   (sessionId, editedEntries)       // atomic promote-then-kill (§D4)
```
The existing `worksession:kill` stays as the "Delete everything" path.

### D6. MCP tools (extend `registerWorkspaceTools`, `workspaces.ts:42-55` — consume the now-used `_workSessions`/`_identity`)
```
get_workspace_memory          { workspace_id?: string }
add_workspace_memory          { text: string, workspace_id?: string }       // source: "agent"
set_workspace_memory_context  { context: string, workspace_id?: string }
promote_finding               { note_id: string, session_id?: string, workspace_id?: string }
```
**Workspace resolution — no global-active fallback** (resolves blocker "agent writes leak across
workspaces" + blocker "promote_finding wrong workspace"):
- `add_workspace_memory` / `set_workspace_memory_context`: destination = the caller's bound
  session's workspace ONLY: `workSessions.get(identity.sessionId)?.workspaceId`. When `undefined`,
  write to the **untagged bucket**. **Never** fall back to `workspaces.getActiveId()`. If
  `workspace_id` is supplied explicitly, validate against `workspaces.list()` and reject unknown.
- `promote_finding`: destination = the OWNING session's workspace: `owner = session_id ??
  identity.sessionId; wsId = workSessions.get(owner)?.workspaceId`. Reject if the note isn't found
  via `getPromotableFinding(owner, note_id)`. If `workspace_id` differs from the owner's
  workspace, **reject** (no silent cross-workspace re-homing).
- `_identity.sessionId` is the **work-session container id** (`server.ts:162`), so `get()`
  resolves correctly.
- Update `SERVER_INSTRUCTIONS` (`electron/mcp/server.ts`) with a "Workspace memory" group line.

### D7. preload (`electron/preload.ts`, main window)
Accessors: `getWorkspaceMemory`, `setWorkspaceInstructions`, `addWorkspaceFinding`,
`editWorkspaceFinding`, `deleteWorkspaceFinding`, `promoteWorkspaceFindings`,
`getPromotableFindings`, `killWorkSessionWithPromote`; listener `onWorkspaceMemoryChanged(cb)`.
Add all to the `Window.api` type in `src/App.tsx`.

---

## (E) Delete-time prompt + promote-with-edit UI + workspace-memory editor

### E1. Delete-time KEEP / DELETE — MAIN-window blocking modal (tier-1 gate, NOT companion)
All kill entry points funnel through **`handleKillSessionById`** (`useSessions.ts:263-272`);
`handleKillSession` (Ctrl+K, `:276-279`) delegates to it; the sidebar ✕ calls it directly.
**Replace `window.confirm`** with a main-window React modal `src/components/KillSessionModal.tsx`,
cloning the `PermissionPrompt` overlay pattern (`position:fixed .permission-overlay
role="dialog" aria-modal="true"`), rendered near the existing `<PermissionPrompt>` mount.

**State home — pinned:** `pendingKillId` + `confirmKill` live in **App.tsx**. `useSessions`'s
`handleKillSessionById` calls an injected `requestKill(id)` setter instead of `window.confirm`.
**Awaiter audit:** grep callers; today only Ctrl+K + sidebar ✕ (both fire-and-forget). Three
always-visible buttons (no hover-reveal): **Keep & delete**, **Delete everything**, **Cancel**.

### E2. Promote-with-edit — the editable list IS step 2 inside `KillSessionModal`
On open, fetch `getPromotableFindings(pendingKillId)` and **snapshot into local state** (model on
`WorktreeReviewPanel`'s captured-list + `DiffPanel`'s per-row selection). Render with **every row
pre-checked**; each row = checkbox + inline-editable controlled `<input>` + always-visible per-row
**Delete**. Footer: **Keep & delete** → `killWorkSessionWithPromote(id, checkedEditedEntries)`;
**Delete everything** → `killWorkSession(id)`; **Cancel** → clear `pendingKillId`. Empty-findings:
"No findings to keep"; Keep ≡ Delete.

**Modal copy is honest about "Delete everything"** (resolves major "transcript persists"). Word it
**"Delete this session's saved findings and record"**, not a clean-wipe promise. A test asserts
`killSession`'s on-disk footprint is unchanged.

**Race handling:** (1) session mutates while open → promote from the opened-time snapshot;
(2) session killed out from under the modal → `onWorkSessionRemoved` (`useSessions.ts:162-165`)
auto-closes + toast; (3) atomicity via the single `worksession:kill-with-promote` handler; (4)
interception stays UPSTREAM (renderer/IPC) — never add silent promotion inside `killSession`.

### E3. Workspace-memory EDITOR — companion panel (primary) + sidebar entry point
New panel type `workspace-memory` via the 4-step recipe: `src/components/panels/
WorkspaceMemoryPanel.tsx`; `case "workspace-memory"` in `CompanionApp.tsx`; add to the
`show_panel` type enum in `electron/mcp/tools.ts`; `.workspace-memory-panel` CSS. Sectioned layout
modeled on `SessionOverviewPanel` but EDITABLE: a `<textarea>` for `instructions` + explicit
**Save**; a findings list with always-visible per-row **Edit/Delete**; an **Add finding** control;
per-finding `createdAt` + `promotedAt` age (freshness signal).

**Pinned-target write path** (resolves major "editor writes to global active workspace / race").
The panel **captures the concrete `workspaceId` (or untagged) at open time** and passes it
EXPLICITLY on every mutation IPC — NEVER re-derives from `getActiveId()` at save time.

**Live-refresh keys on `workspaceId`, not `props.id`** (resolves minor). The
`workspace:memory-changed` push carries the changed `workspaceId`; `CompanionApp` matches the open
panel on `props.workspaceId`.

**Entry points:** an always-visible **"Workspace memory"** button in `WorkspaceSwitcher`
(`Sidebar.tsx:153-163`). App.tsx handler mirrors `jumpToReviewRef`/`jumpToMissionRef`. Also wire
the pre-existing disabled `SessionOverviewPanel` "Push context to workspace" button to promote
that session's findings into its owning workspace.

---

## (F) File-by-file change list (with file:line anchors)

**NEW files**
- `electron/services/workspaceMemory.ts` — service + types; `SCHEMA_VERSION=1`, `MIGRATIONS=[]`;
  `saveVersioned`/`loadVersioned` (`persist.ts:118`/`:47`); untagged sentinel + `fileFor()`
  guard; idempotent `promoteFindings`; `onMemoryChanged` (mirrors `workspaces.ts:298-308`).
- `electron/services/workspaceMemory.test.ts`
- `src/lib/workspaceMemory.ts` — pure promote-mapping + supersede-rewrite helpers.
- `src/lib/workspaceMemory.test.ts`
- `src/components/KillSessionModal.tsx` (+ `.kill-session-modal` CSS)
- `src/components/panels/WorkspaceMemoryPanel.tsx` (+ `.workspace-memory-panel` CSS)

**Edited**
- `electron/services/recall.ts` — `RecallEntry` `:28-40`; `RecallSummary` `:48-57`; constructor
  `:185-188`; `deriveRecallIndex` `:111-144`; `getIndex` `:200-203`; `summary()` `:247-276`
  (incl. `:255` origin exclusion).
- `electron/services/sessions.ts` — new `getPromotableFindings` + `getPromotableFinding` (near
  `getOverview` `:1164`); no `killSession` change (`:557-566` stays).
- `electron/ipc.ts` — module-scope `workspaceMemoryService` (near `:48`); RecallService second
  param `:86`; `onMemoryChanged → invalidate + push` inside `setupIpc`; primer closure `:78-84`;
  thread the service into the two handler registrars.
- `electron/ipc/workspace-handlers.ts` — accept `workspaceMemoryService`; 6 memory channels;
  `workspace:delete` unchanged re: memory (NO auto `deleteForWorkspace`).
- `electron/ipc/worksession-handlers.ts` — `worksession:promotable-findings`,
  `worksession:kill-with-promote`.
- `electron/mcp/tools/workspaces.ts` — consume `_workSessions`/`_identity` (`:42-55`); 4 new tools.
- `electron/mcp/server.ts` — `SERVER_INSTRUCTIONS` +"Workspace memory".
- `electron/mcp/tools.ts` — `show_panel` enum +`"workspace-memory"`; thread the service through.
- `electron/preload.ts` — accessors + `onWorkspaceMemoryChanged`.
- `src/App.tsx` — `Window.api` types; `pendingKillId` + `confirmKill`; `<KillSessionModal>`;
  thread `requestKill`; "Workspace memory" open handler; `onWorkspaceMemoryChanged`
  mount/cleanup; wire `SessionOverviewPanel` push button.
- `src/hooks/useSessions.ts` — `handleKillSessionById` `:263-272` calls injected `requestKill`;
  auto-close guard via `onWorkSessionRemoved` `:162-165`.
- `src/lib/agentRail.ts` — `KnowsRecallInput` `:211-217`; `KnowsWorkspaceMemory` +
  `RailKnows.workspaceMemory` `:253-261`; `deriveKnowsWorkspaceMemory` + fold into `deriveKnows`
  `:286`; fix stale doc-comments `:206-217`, `:243-244`.
- `src/hooks/useAgentRailKnows.ts` — surface the new digest.
- `src/components/AgentRail.tsx` — render the third KNOWS group.
- `src/components/Sidebar.tsx` — "Workspace memory" button in `WorkspaceSwitcher` `:153-163`.
- `src/components/CompanionApp.tsx` — `case "workspace-memory"` + live-refresh on `props.workspaceId`.
- `src/components/panels/SessionOverviewPanel.tsx` — enable "Push context to workspace" `:94-96`.
- `src/components/panels/RecallPanel.tsx` — confirm memory/synthetic/corrector-less hits render.
- `docs/roadmap/context-engine-design.md` — append §A.

---

## (G) Test plan (unit + e2e)

**Unit (Vitest — `npm test`, the gate):**
- `workspaceMemory.test.ts`: round-trip per real id + untagged bucket; missing file → empty;
  forward-compat (`schemaVersion>1` loaded as-is); each mutator persists + emits; **lazy-load-
  before-mutate** append; `promoteFindings` re-mints, rewrites in-batch `supersededBy`, keeps
  orphan correctors as `superseded`/`supersededBy:undefined`; **idempotency** (same pair twice →
  one finding); `deleteForWorkspace` unlinks real id, **refuses the untagged sentinel**; explicit
  sentinel rejected at every public method.
- `src/lib/workspaceMemory.test.ts`: pure promote-mapping, supersede graph closure, edited-text
  promotion, idempotency-merge.
- `recall.test.ts` (extend): union includes memory; **DE-DUP by pair** (promoted-from-live-session
  once); **collision test** (same bare note id across two workspaces); `summary()` excludes
  promoted-from-caller; no phantom session; cross-session `recentRuledOut` never picks memory;
  `workspaceMemory` digest counts; **untagged normalization** (`undefined`, not sentinel); ws-A
  caller doesn't see untagged; `session` scope excludes memory; `all` scope returns it cross-ws;
  supersede-after-promote best-effort pinned. **Update the existing exact-equality test
  (`recall.test.ts:273`)** + grep other full-summary `toEqual`/`toStrictEqual`.
- `agentRail.test.ts` (extend): third group renders when ONLY memory exists (`sessions===0`);
  hidden when memory empty.
- `getPromotableFindings`/`getPromotableFinding`: active+superseded with provenance;
  `provisionalFindings` EXCLUDED; single-note resolution; not-found → undefined.
- `workspace-handlers.test.ts` / `worksession-handlers.test.ts` (extend): the 8 channels;
  `kill-with-promote` resolves OWNING workspace, promotes-then-kills, doesn't kill on promote
  failure; `workspace:delete` doesn't touch memory; `killSession` footprint unchanged.
- `workspaces.test.ts` (MCP, extend): writes go to the caller's bound workspace (untagged →
  untagged bucket, NEVER getActiveId); `promote_finding` lands in OWNING workspace even cross-ws;
  mismatched/unknown `workspace_id` rejected.

**e2e (Playwright Electron smoke — hermetic via `USERPROFILE` temp home):**
- new `workspace-memory.spec.ts` (or extend `structured.spec.ts`): kill a seeded session →
  `KillSessionModal` renders pre-checked editable list + three visible buttons; **Keep & delete**
  promotes (assert via reopened panel / `get_app_state`); **Delete everything** skips promote;
  open the editor panel from the switcher and assert sections + controls render and are **statically
  visible (NO hover-reveal)**.

**Acceptance per unit:** `npm test` green + `npm run build` clean; UI units also `npm run e2e` green.

---

## (H) Dispatchable BUILD UNITS (dependency order; each worktree-isolatable)

- **U1 — Workspace-memory store + promote (FOUNDATION).** `workspaceMemory.ts` +
  `src/lib/workspaceMemory.ts` + types (PINNED `FindingSource` superset) + per-id persistence +
  untagged sentinel/guard + idempotent `promoteFindings` (re-mint/supersede-rewrite/orphan-keep)
  + lazy-load-before-mutate + `onMemoryChanged` + `deleteForWorkspace` (sentinel refusal).
  **Gate:** both new test files green; `npm test` + build clean. No IPC/UI.
- **U2 — SessionService read helpers.** `getPromotableFindings` + `getPromotableFinding` (active +
  superseded → `PromoteEntry`; `provisionalFindings` excluded). **Gate:** unit green; build clean.
  (Parallel with U1; tiny.)
- **U3 — IPC + MCP + preload surface.** Module-scope `workspaceMemoryService` + PINNED
  construction order; thread into the two registrars; 6 workspace + 2 worksession channels; atomic
  `kill-with-promote`; 4 MCP tools (no getActiveId fallback, reject mismatched/unknown); 
  `SERVER_INSTRUCTIONS`; preload accessors + `onWorkspaceMemoryChanged`; `onMemoryChanged →
  invalidate + push`. **Depends on U1 + U2. Gate:** handler + MCP tests green; `npm test` + build.
- **U4 — RecallService union + de-dup + rail.** Second constructor param; combined
  `deriveRecallIndex(sessions, memoryFindings)` with pair suppression + untagged normalization;
  `summary()` memory-branch-before-continue + cross-session guard + origin exclusion +
  always-present `workspaceMemory`; **update `recall.test.ts:273`**; primer `originSessionId` fix;
  RecallPanel/`renderRecallHit` audit; full rail chain; fix stale doc-comments; `useAgentRailKnows`.
  **Depends on U1 (types) + U3 (wired service). Gate:** extended `recall.test.ts` + `agentRail.
  test.ts` proving exactly-once de-dup (both risks + collision + untagged-normalization) green.
- **U5 — Delete-time Keep/trim/edit modal (UNBLOCKS THE DELETE-TIME KEEP FLOW).**
  `KillSessionModal.tsx`; rework `handleKillSessionById` → injected `requestKill`; `pendingKillId`/
  `confirmKill` in App; snapshot + race auto-close; honest "Delete everything" copy; no
  hover-reveal; awaiter audit. **Depends on U1 + U2 + U3.** **Gate:** `npm test` + build +
  `npm run e2e` (kill→modal→Keep/Delete, no hover-reveal) green.
- **U6 — Workspace-memory editor panel + entry points.** `WorkspaceMemoryPanel.tsx`
  (pinned-target write path); panel type/enum + `CompanionApp` case + CSS; live-refresh on
  `props.workspaceId`; `WorkspaceSwitcher` button + open handler; enable `SessionOverviewPanel`
  push button. **Depends on U3. Gate:** `npm test` + build + `npm run e2e` (panel renders, controls
  statically visible) green.

**Dispatch:** U1 ∥ U2 → U3 → U4 → (U5 ∥ U6). **U5 is the unit that unblocks the delete-time Keep
flow** (and it requires U1 + U2 + U3 first).

---

## (I) Ticketing

- **CAPP-87** (umbrella) — re-scoped to the full Workspace Memory tier + delete-time
  keep/trim/edit flow; children = the six build-unit tickets below.
- **CAPP-86** ("The Lexicon" v1, shipped) — closing note: v2 adds the second durable tier under
  CAPP-87; RecallService becomes a UNION de-duped by the `(originSessionId, originNoteId)` pair.
- Six build-unit child tickets (U1–U6) + three deferred backlog tickets (the Atlas; explicit
  workspace-delete memory disposition + orphaned-session re-tagging; cwd→workspace inference for
  untagged-session writes). Real Jira keys assigned at creation (CAPP-88 is already taken/Done).

---

## (J) Disposition of every minor/nit

- **promote_finding single-note helper** — RESOLVED: `getPromotableFinding` (§D3).
- **Audit all `source`/`status` consumers** — RESOLVED: RecallPanel + `renderRecallHit` + primer
  audited (§C7, §F).
- **`handleKillSessionById` awaiters / hook-App boundary** — RESOLVED: state in App, `requestKill`
  injected, awaiter grep, fire-and-forget documented (§E1).
- **Live-refresh keys on `props.id`** — RESOLVED: keys on `props.workspaceId` (§E3).
- **Editor opens against global active / race** — RESOLVED: pinned-target write path (§E3).
- **`__all__`/sentinel collision** — RESOLVED: non-string sentinel, `fileFor()` guard,
  public-method rejection, `loadAll()` guard, `deleteForWorkspace` refusal (§B, §D1).
- **Untagged scopeFilter normalization** — RESOLVED: derive normalizes sentinel→`undefined` (§C2).
- **`provisionalFindings` in promote** — RESOLVED: excluded in v1, documented + tested (§D3).
- **SERVER_INSTRUCTIONS / per-connection registration** — RESOLVED: group line added (§D6).
- **Forward-compat read-repair edge** — RESOLVED: loaded as-is; mutators lazy-load-or-create (§B).
- **Orphaned-corrector downgrade mutates meaning** — RESOLVED: keep `superseded` + drop
  `supersededBy`; renderers tolerate (§B).
- **`deleteForWorkspace` callback seam / inverts durable tier** — RESOLVED: handler-level design,
  NOT auto-invoked on workspace delete in v1 (memory orphaned-recoverable); backlog ticket for the
  explicit affordance (§D2).
- **Stale agentRail doc-comments** — RESOLVED: corrected in U4 (§C6).
- **Untagged bucket = global shared scope** — RESOLVED: documented; cwd inference deferred (§C5).
- **Crash-window double-promote** — RESOLVED: idempotency on the pair (§B).
- **De-dup fails after re-summarize** — RESOLVED as documented best-effort (§C3).

This plan is buildable as written: every constructor signature, channel, tool resolution rule,
and de-dup key is pinned, and every blocker/major has a concrete, anchor-verified resolution.
