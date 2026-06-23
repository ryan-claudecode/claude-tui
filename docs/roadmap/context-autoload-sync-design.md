# Auto-Loaded Brain + Workspace Sync — Design (CAPP-87 follow-on)

*Produced by the `native-context-autoload-sync-design` workflow (3 maps → synthesis → 3-lens
adversarial critique → revise; 24 issues, 15 blocker/major; 4 ship-stopper blockers fixed). Two of
three map readers were rate-limited mid-run, but the critics read the spawn/sync code directly and
the design is line-cited throughout. Anchored against HEAD `44374fe`.*

## 0. Thesis

The brain we shipped (CAPP-87) is **PULL**: an agent must call `get_session_context`/`recall`, or the
owner must prompt "read the memory." This makes it **PUSH** — a fresh chat in a session/workspace
already holds its curated context, injected *behind the scenes* via a native seam our own renderer
provably does not surface — and makes the same curated files the unit of cloud sync, so a fresh chat
on a **second device** already knows too. The two threads compose because the auto-load payload is
built **entirely** from `~/.claude-tui/workspace-memory/<W>.json` + `~/.claude-tui/sessions/<S>.json`
— exactly the durable state sync moves. Sync the files → the local builder regenerates the payload.
**No sync-specific code in the auto-load path.**

**Top-level corrections from the critique:** (1) **inline transport is unshippable** — `shellWrap`
space-joins args with zero quoting, so a markdown payload is shredded *and* a shell-injection vector
(findings are partly agent-authored); file-backed transport is **mandatory**, gated on a live capture
of the flag's real behavior. (2) **Auto-load ships ALONE** as Slice 1 (no persistence/schema), with
sync demoted to a separately-designed epic whose defaults invert to local-only.

---

## (A) The auto-load mechanism

### A.1 Seam choice — all three pass the visibility constraint *in our renderer*; decided on operational fit

Verified against the OWNER VISIBILITY CONSTRAINT in our own code (`streamEvents.ts`), not just Claude Code:

| Seam | Injects via | Visible in **our** renderer? | Footprint |
|---|---|---|---|
| **`--append-system-prompt`** | the system prompt | **No** — our reducer bubbles only `assistant`/`user` (`streamEvents.ts:225/239`); system-prompt text emits no stream event. | Per-spawn flag in our `args`; **zero repo/global footprint**. |
| **SessionStart hook** (`additionalContext`) | hook stdout/JSON | **No** — `hook_*` are `system` subtypes our reducer drops (`:218-220`). | Out-of-process; writes the user's `~/.claude/settings.json`; global ordering vs the user's own hooks. |
| **`@import` in `CLAUDE.local.md`** | project-memory auto-load | **No** — folded into context, not streamed. | Writes a file **into the repo working tree** — collides with worktree workers (WW-2) + users' own files. |

> **DECISION 1 — seam: `--append-system-prompt`, file-backed (A.2), both engines, every spawn.**
> vs `@import` (writes into arbitrary/worktree repo trees — bad for a tool spawning into many cwds);
> vs SessionStart hook (global out-of-process side-effect; re-fires on `/clear`/`/compact`; can't see
> which terminal is spawning). The system-prompt flag touches zero repo files and rides our existing
> per-spawn arg builder (we already re-pass `--model` on resume, `terminals.ts:1226-1229`).
> **Accepted tradeoff:** cleanest fresh spawn, but it does **not** re-inject on an in-session
> `/clear`/`/compact` (those are Claude's lifecycle, not our spawn path) — mitigated by the pull path
> (A.5) + an explicit re-prime (Decision 5).

### A.2 Transport — file-backed is MANDATORY (the load-bearing correction)

`shellWrap` (`terminals.ts:586-597`) does `[command, ...args].join(" ")` into a single
`powershell.exe -Command` / `bash -l -c` string with **zero quoting/escaping**. A multi-KB markdown
payload (spaces, newlines, `# $ \` ; | & ( ~~ →`) is word-split, `$`-interpolated, and
**command-injected** — and the payload is partly agent-authored, so a finding containing `$(...)` or
`; rm` would execute at the *next human's spawn*. The codebase already proves this wrapper is unsafe
for free text: `--allowedTools` is hard-filtered to `/^[A-Za-z0-9_]+$/` for exactly this reason
(`terminals.ts:1257-1258`).

**Transport spec:** write the payload to `~/.claude-tui/context/<terminalId>.md` (per-terminal, no
contention, regenerated every spawn); pass **one** argument referencing it (exact form gated on the
DECISION 0 spike — `--append-system-prompt @<path>` vs `--append-system-prompt-file <path>` vs
read-and-pass-contents). **Regardless, harden `shellWrap` to be argv-safe before this ships** (spawn
the exe with a real argv, or PowerShell `-EncodedCommand` base64 on Windows / single-quoted arg on
POSIX). **Until `shellWrap` round-trips a payload containing `$`, backtick, `;`, newline, and `(`
intact, no version of this feature is safe to ship.** The `context/` dir is **never synced**.

### A.3 Spawn wiring

`buildInjectedContext(sessionId, { resume }): string` — pure over `WorkspaceMemoryService` +
`SessionService` + a **shared warmed** `RecallService` index (A.7); reads in-memory caches, no sync fs
in the hot path. Inject in `createHeadless` (`terminals.ts:1222`) and `spawnXterm` (`:1095`) before
`--mcp-config`/`shellWrap`. Every respawn path routes through these bodies (`reopenTerminal:631`,
`handoffTerminal:578`, `respawnHeadlessRef:815`), so resume is covered.

### A.4 Resume semantics

> **DECISION 6 — resume: inject a SHORT POINTER on resume, the full snapshot only on fresh spawn.**
> A `--resume` replays a transcript that already absorbed the *original* launch snapshot; re-appending
> a *current-disk* snapshot layers contradictions over prior reasoning and re-pays the budget. On
> resume, inject a minimal stamped pointer ("Durable context may have changed since launch (snapshot
> <hash>). Call `get_session_context` for the live view."). Fresh-spawn full payload is what kills the
> anti-pattern; resume is a continuation.

### A.5 Staleness — auto-load = startup baseline; pull tools = live refresh

The injected payload freezes at spawn (true of every seam). Keep both paths, distinct roles:

| Path | Role | When |
|---|---|---|
| **Auto-push** (new) | Silent startup baseline | Every fresh spawn (full) / resume (pointer) |
| **`get_session_context`** (exists) | Live refresh **as a delta** | Mid-session; after `/clear`/`/compact` |
| **`recall`** (exists) | Targeted "have we learned X?" | Query-driven |

**Double-injection made real:** the shared builder makes the snapshot and the tool return identical
bytes — so an early `get_session_context` would re-dump them as a *visible* tool result. Fix:
`get_session_context` returns a **delta** against a hashed launch snapshot threaded into the session
env (or "No changes since launch snapshot"). A hermetic test asserts the no-change short form.

### A.6 Gating verifications before merge

The visibility claim is **reasoned, not live-captured** — every other load-bearing fact in this repo
(model-pin-on-resume, BO-3 permission wire shapes) was live-captured. **Two spikes gate the feature:**
1. **DECISION 0 — live-capture the flag.** Run real `claude -p --append-system-prompt "SENTINEL …"`
   (and the `@path`/`-file` variant) with stream-json; grep the raw NDJSON (`init`/`assistant`/`user`/
   `result`/sub-`stream_event`) for the sentinel. Confirm (a) it never surfaces as a turn, (b) it does
   not echo into our `init` meta-event, (c) the `@path` expansion behavior. Commit as a fixture.
2. **xterm path** (different renderer — raw PTY bytes): one-off live spawn with a sentinel; confirm it
   never appears in PTY output on fresh **and** `--resume`. If it can leak, **restrict auto-load to the
   structured engine** (the default) and skip injection on the xterm fallback.

### A.7 Build cost under fan-out

Auto-restore restores **all** terminals in parallel; rebuilding `deriveRecallIndex` (a union over all
sessions + memory) per spawn is O(N²)-ish. `buildInjectedContext` **reuses a single warmed
`RecallService` index** (already `loadAll`-warmed), async reads from the `WorkspaceMemoryService`
cache, and **memoizes the workspace tier per `workspaceId` per restore batch** (identical for every
terminal in a workspace). Perf assertion on N=20 parallel restore.

---

## (B) The curated payload

### B.1 Markdown shape (two labeled tiers; firehose excluded by construction)

```markdown
# Context for this session
> Auto-loaded by Mission Control. Launch snapshot — call get_session_context for the live view.

## Workspace standing instructions        # omit if empty; field length-capped
<WorkspaceMemoryRecord.instructions for W>

## Durable workspace findings              # PINNED first, then active, then ruled-out
- 📌 <pinned finding>
- <active workspace finding>
- ~~<ruled-out finding>~~ → <correction>

## This session: <S.name>
### Summary
<S.summary>                                # omit if blank
### Findings
- <active note text>
### Ruled out / corrected
- ~~<note>~~ → <correction>

_(N older findings omitted — call get_session_context to see all)_   # only when truncated
```

**Build by reuse:** workspace tier = the recall union filtered to `scope:'workspace'` with
`caller={ workspaceId: S.workspaceId }` (keeps `source==="workspace-memory"`) + `getMemory(W).
instructions` — sourcing from the **union** is mandatory for free de-dup (a promoted finding isn't
double-counted, `recall.ts:174-178`). Session tier = factor `getContext`'s first three sections
(`sessions.ts:1235-1250`) into a **shared pure helper** both paths call (can't drift); **exclude** its
`## Related from other sessions` block (firehose-adjacent — keep pull-only).

### B.2 Scope — no cross-workspace leak, pinned against `getActiveId`

`buildInjectedContext` sources `workspaceId` **from the spawning session record (`S.workspaceId`),
NEVER `getActiveId()`** (mirrors the CAPP-87 promote defense) — a session spawned while a *different*
workspace is active injects *its own* brain. Tested. Untagged sessions get only the untagged "All"
bucket — a deliberate global cross-project scope that is also a cross-**device** exfil vector once
synced, so its auto-load push is tied to the same opt-in as untagged sync (B.2/C.4).

### B.3 Cost cap + truncation priority (keep value, not recency)

Hard **8 KB cap** (`context.injectMaxBytes`, default 8192; measured worst-case from a real seeded
workspace replaces the asserted estimate; per-terminal cost multiplies across concurrent terminals).
Per-item caps (instructions ~1.5 KB; each finding length-capped so one essay-finding can't dominate).
**Truncation order (oldest/foundational findings are often the load-bearing HARD RULES, so don't evict
them):** (1) pinned — **never evicted**; (2) instructions; (3) session summary; (4) active workspace
findings, **keep oldest first**; (5) session active notes, newest-first; (6) ruled-out last. Omission
marker counts both tiers + signals a `get_session_context` call.

> **DECISION 7 — add `pinned: boolean` to `WorkspaceFinding`** (additive, default false), surfaced in
> the editor, so load-bearing findings are never evicted — the only honest importance signal
> (`promotedAt`/`createdAt` are recency, not importance).

---

## (C) The sync pillar (a separate follow-on epic)

### C.1 Unit of sync — portable vs machine-local (every stripped field)

| Path | Sync? | Notes |
|---|---|---|
| `workspace-memory/<W>.json` | ✅ | The durable tier. **Untagged `__untagged__.json` LOCAL-ONLY by default** (C.4). |
| `sessions/<S>.json` | ✅ **whitelist** | Keep `{id,name,status,workspaceId,summary,notes,eventLog,createdAt,updatedAt}` + terminal membership names/count. **Strip from every TerminalRef:** `ccConversationId`, absolute `cwd`, runtime model/effort pins, activity, PTY ids. An imported session whose workspace isn't folder-bound (C.5) is **non-spawnable until bound**. Round-trip test: no absolute path / no `ccConversationId` survives. |
| `workspaces.json` | ⚠️ partial | uuid + name + schemaVersion + memory linkage; **re-resolve the folder path per device** (C.5). |
| `layouts.json` | ✅ paths remapped | |
| `context/` | ❌ **never** | Machine-local per-spawn artifact; regenerated locally — preserves the "sync moves source JSON, builder regenerates payload" invariant. |
| `missions/`, `config.json` | ❌ out of v1 | worktree/branch-tied; per-device scan paths. |
| `~/.claude/projects/` transcripts | ❌ never | Machine-local, Claude-owned. We emit curated text only; `--resume` cleanly falls back to a fresh primed terminal when a transcript is absent (import blanks `ccConversationId`). |

### C.2 Transport

> **DECISION 2 — GitHub private repo (a) for v1**; state-root configurable so folder-sync (b) is a free
> fallback; own service (c) deferred. (a): we already drive git, free, versioned, **a commit DAG we use
> for merge causality**, user owns the data. (b): last-writer-wins file clobbering — escape hatch only.
> (c): backend to build/secure — premature. **Caveat:** a configurable `~/.claude-tui` root touches
> every service's path resolution **and the e2e USERPROFILE-override hermeticity** — defer it until
> confirmed it doesn't break the hermetic override.

### C.3 Conflict / merge — don't trust wall clocks; `updatedAt` must be load-bearing

Git line-merge is wrong for JSON. Merge at the **record level** with a pure, hermetically-tested fn:
- **`updatedAt` is absent/never-bumped today** — a `Note` has only `createdAt`; `editFinding`/
  `setInstructions` mutate text with no clock. So two devices editing the same id are
  byte-indistinguishable → union-by-id silently loses one. **Fix (Slice 2):** add `updatedAt`, bump it
  on **every** mutation path, **seed missing clocks from `createdAt`/`promotedAt` (not epoch)**.
- **Causality via the git DAG**, not raw wall clocks (LWW lets the fast-clock device always win).
- **Genuine concurrent edits are NOT silently resolved** — same id, both edited, no ancestry winner →
  keep both as siblings + surface "· (also edited on another device — review)" in the editor.
- **Deletes need tombstones** (`deletedAt`) or union-by-id resurrects a deleted finding from a stale
  copy. Hermetic fixture: delete-on-A + present-on-B stays deleted after merge.
- The merge is a **pure function over two file trees** → hermetically testable; the unit a future
  service (c) reuses.

### C.4 Privacy — defaults INVERTED to local-only

Curated text only (never raw transcripts/code/secrets — inherits the CAPP-87 curation boundary).
**The draft made GitHub the default + local-only an opt-OUT — wrong.** Final: workspaces and the
untagged "All" bucket are **LOCAL-ONLY until explicitly opted in (allow-list)**; the untagged global
bucket needs a **separate** toggle (highest-leak), and its auto-load push is also default-off until
that toggle is on. Pre-push **preview** of exactly what will leave the device. Pushed history is
permanent — document it + a "rotate the brain repo" escape.

### C.5 Path re-resolution + workspace identity

Synced `workspaces.json` carries uuid + name, not a usable path. On device 2, first activation
**prompts once to bind a local folder** (reuse the WS-H single-folder UI), persists the device-local
path keyed by uuid. Atomic registry+memory pull (both or neither; startup reconcile flags orphans).
Same-project/different-UUID: offer to **merge into the imported UUID** rather than minting a parallel
bucket (`__untagged__.json` is the one shared filename and merges fine).

### C.6 How auto-load regenerates after sync

Pull → JSON lands in `~/.claude-tui` → next spawn, `buildInjectedContext` reads it. **No sync-specific
code in the auto-load path** — it can't tell a synced file from a local one. The `context/` artifact is
regenerated from the *local* home + terminalId, so no device-1 absolute path crosses.

---

## (D) Phasing → buildable units

**Slice 1 — Auto-load. Ships FIRST and ALONE; fully resolves the owner-observed anti-pattern.** No new
persistence/schema (except additive `pinned`, optional within the slice).
- **DECISION 0 spike (live-capture the flag) — gates everything.**
- `shellWrap` made argv-safe (the blocker) + a round-trip test over `$`/backtick/`;`/newline/`(`.
- The shared per-session markdown builder (workspace union + session helper) + warmed-index reuse +
  per-item caps + value-ordered truncation; file-backed `context/<terminalId>.md`; injection in
  `createHeadless` + `spawnXterm` (fresh = full, resume = pointer).
- `get_session_context` reframed to return a **delta** vs the launch snapshot.
- Visibility regression tests (structured reducer + xterm live spawn).

**Stop after Slice 1.** Treat sync as a separate epic with its own design pass once auto-load is proven.

**Slice 2 — Sync foundation (additive, independently valuable, hardens the local model):** `updatedAt`
bumped on every mutation + tombstones (`deletedAt`) + seeded clocks; the pure record-level merge fn +
hermetic tests. No transport yet.

**Slice 3 — GitHub sync transport** (gated on Slice 2): `SyncService` (snapshot curated subset →
commit/push to a private repo; pull + merge; re-resolve paths); allow-list opt-in per workspace +
separate untagged toggle + pre-push preview; MCP `sync_push`/`pull`/`status` + an explicit (no-hover)
Sidebar "Sync" surface; defer the configurable state-root until the e2e hermetic override is confirmed.

**Slice 4 (later):** missions/config sync; own service; `/clear`-routed re-injection if the staleness
gap proves painful.

---

## (E) Owner decision agenda

| # | Decision | Recommendation |
|---|---|---|
| **0** | **Live-capture `claude -p --append-system-prompt` (+ `@path`/`-file`) before any build** | **Accept — gate the feature on it** (the missing live-capture the design rests on). |
| **1** | **Seam** = `--append-system-prompt`, file-backed, both engines, every spawn | **Accept** (weak mid-life refresh tradeoff acknowledged). |
| **2** | **Sync transport** = GitHub private repo v1; configurable root → folder-sync fallback; service deferred | **Accept**; defer configurable root until e2e hermetic override confirmed. |
| **3** | **File-backed transport + argv-safe `shellWrap` = MANDATORY** (inline is unshippable + an injection vector) | **Accept — required to function.** |
| **4** | **Untagged "All" bucket = LOCAL-ONLY by default** for both sync *and* auto-load push; separate opt-in | **Accept** (inverts the draft's opt-out). |
| **5** | **Mid-session re-injection?** No forced respawns; add an explicit user-triggered "re-prime this terminal" control | **Accept** — explicit, not automatic. |
| **6** | **Resume** = short pointer on resume, full snapshot only on fresh spawn | **Accept.** |
| **7** | **Add `pinned: boolean` to `WorkspaceFinding`** so foundational findings are never truncated | **Accept** — the only honest importance signal. |
| **8** | **Sync v1 scope** = memory + sessions(curated whitelist) + layouts(remapped); missions/config out | **Accept.** |
| **9** | **Path re-bind UX** = prompt-once folder bind per synced workspace (reuse WS-H) + same-project merge offer | **Accept.** |

---

## (F) Risks + what the critique changed

**Blockers fixed (were ship-stoppers):** inline transport shreds the payload + is a shell-injection
vector → file-backed mandatory + argv-safe `shellWrap`; the visibility claim was reasoned not
live-captured → DECISION 0 gates on a real NDJSON sentinel capture; no merge clock exists →
`updatedAt` load-bearing + git-DAG causality + sibling conflicts, never silent loss; sync defaults
leaked cross-project data to a permanent remote → defaults inverted to local-only allow-list.

**Major fixes:** `@path` expansion was assumed → verified in the spike; resume re-injected a divergent
snapshot → short pointer; per-spawn build was O(N²) → shared warmed index + memoized workspace tier;
truncation dropped the most foundational findings → value-ordered (pinned never evicted); double-inject
asserted not enforced → delta-returning `get_session_context`; cross-workspace safety → pinned to
`S.workspaceId`; session import carried PTY/cwd/conversation state → whitelist transform + non-spawnable
unbound sessions; the `context/` file could be synced → never synced, regenerated locally.

**Residual risks accepted for v1:** mid-life staleness between respawns of one long-lived terminal
(mitigated by the delta pull + explicit re-prime); per-terminal token tax × concurrent terminals
(mitigated by caps + a scale-down knob, validated by a measured worst-case); git-merge UX for genuine
concurrent edits (surfaced as review-it siblings, not silent loss).
