# CLAUDE.md Coexistence Layer — READ (Context Inspector) + EXPORT (Portability)

**Status:** Design (final, post-adversarial-review). Produced by the `claudemd-coexistence-design`
workflow (3 maps → synthesis → 3-lens critique → revise; 24 issues, 16 blocker/major). Composes with
the already-decided Option A inject (`--append-system-prompt`, file-backed; full design in
`docs/roadmap/context-autoload-sync-design.md`). Specifies the two *additive* relationships with the
user's own native config — **READ** (a read-only inspector of the context Claude eats) and **EXPORT**
(opt-in portability so raw `claude` outside our app can consume the workspace brain) — plus the
data-loss, propagation, and double-load reconciliations. Anchored against HEAD `6c993fe`.

**The three relationships:** **READ** (read-only inspector; never write native files) · **INJECT**
(Option A auto-load, already decided; this composes + reconciles the double-load) · **EXPORT**
(opt-in materialization of the workspace brain into a file the *user* owns and `@import`s; we never
edit their CLAUDE.md).

**The four LOCKED owner decisions (baked in):** (1) Inspector v1 = the *lighter* inspector (discover
native files + our primer); full @import/precedence resolution is a deferred pre-release slice.
(2) Export stays up to date via live regen. (3) Storage = app-owned source of truth + EXPORT (a
derived projection, never a relocation); the store **must be version-controlled/cloud-backed**.
(4) Inspect-only — adopting a workspace with an existing CLAUDE.md does **not** auto-seed our
instructions from it.

> **What the critique changed:** the inspector's source set was materially incomplete (omitted the
> **managed-policy** tier — highest precedence — and unconditioned **`.claude/rules/`**; wrong
> **MEMORY.md** path derivation; missing comment-strip / fenced-@import / `claudeMdExcludes`
> fidelity). The double-load reconciliation rested on an **unsound premise** (CLAUDE.md loads as a
> *user message*, our flag as the *system prompt* — different channels, so "byte-identical → dedup"
> is wrong), and its detection was a desync-prone stored flag → **the marker scan is now MANDATORY,
> fresh at every inject, default-safe-to-inject**. The backup story now pins **untagged → always in
> the local-git net** and makes export **strictly one-directional**. The propagation nudge's mechanism
> is pinned (stdin prompt, not magic re-injection).

---

## A. READ — the Context Inspector

### A.1 What it shows

For a workspace, folder **F** = `WorkspaceService.get(id)?.dir` expanded+validated
(`workspaces.ts:435-447`; `null` for missing/no-folder/stale). The inspector enumerates the complete
launch-time native context + our primer, by precedence:

| # | Tier | Source | v1? |
|---|---|---|---|
| **0** | **Managed policy** (highest, cannot be excluded) | OS managed `CLAUDE.md` + `claudeMd` in `managed-settings.json` | ✅ |
| 1 | User-global memory | `~/.claude/CLAUDE.md` | ✅ |
| 2 | User-global rules (unconditioned) | `~/.claude/rules/*.md` without `paths:` | ✅ |
| 3 | Parent-chain memory | walk up from F, **bounded at git root** | ✅ |
| 4 | Project memory | `F/CLAUDE.md` or `F/.claude/CLAUDE.md` | ✅ |
| 5 | Project rules (unconditioned) | `F/.claude/rules/*.md` without `paths:` | ✅ |
| 6 | Project-local override | `F/CLAUDE.local.md` | ✅ |
| 7 | Claude native auto-memory | `<autoMemoryDir>/memory/MEMORY.md` (git-root keyed; cap "200 lines / 25 KB") | ✅ |
| 8 | @imports inside the above | `@./path`, `@~/path` | ❌ (deferred — recursive expansion + cycle guard) |
| 9 | Nested / path-scoped rules (`paths:`) | subdirs of F | ❌ (deferred — lazy/conditional, labeled) |
| **10** | **Our injected primer** | live via the **truncating** `buildInjectedContext` path | ✅ |

**Critique fixes baked in:**
- **MEMORY.md is git-root-keyed**, not raw-cwd: resolve `gitToplevel(F)` and encode *that*; honor an
  `autoMemoryDirectory` override. Do NOT reuse `encodeProjectDir(F)` (`terminals.ts:34` — correct for
  *transcripts*, wrong for auto-memory).
- **Managed policy + unconditioned rules are launch context**, not lazy — render "none" when absent,
  never omit (the completeness claim depends on showing empty tiers).
- **Source #10 fidelity:** render the primer **through the same truncating pass** the inject uses
  (else the inspector shows the untruncated brain while the spawn injects a capped one). And once §E
  ships, an **adopted** workspace's tier #10 must self-attribute the workspace portion under the host
  `@import` ("delivered via your @import, not our flag — de-duped").
- **`claudeMdExcludes`:** the parent walk must mark excluded ancestors visibly ("excluded by
  claudeMdExcludes"), never silently show or drop. (Full settings-chain merge deferred.)
- **Fidelity transforms:** strip block-level `<!-- … -->` comments + skip code-fenced `@imports`
  before display, so render == injected. (This is also why EXPORT's identity marker is an HTML
  comment — Claude strips it, our file-scan reads it.)
- **Folderless/untagged:** F null → render only #10 + a note ("Folderless — only the Mission Control
  primer applies; machine-global tiers 0/1/2 still shown").

### A.2 Phase boundary — v1 (discovery) vs deferred (resolution)

**v1:** enumerate tiers 0,1,2,3,4,5,6,7,10 as `{tier, path, exists?, capped-excerpt, imports[] (raw,
outside-fence), excluded?}`, precedence-ordered; @imports shown **literally** with a first-class count
("contains N @imports — bodies also load but are not expanded here"); nested/path-scoped in a
labeled "conditional" section. **No merge, no effective view.** Verbatim in-panel honesty copy so v1
doesn't overclaim ("Files Claude loads at launch, in precedence order. Imported files listed but not
expanded. Full resolved view coming soon.").

**Deferred (pre-release):** @import expansion (~4 hops + cycle guard); full settings-chain merge;
precedence/override + the **effective merged context**. **Shared work** with §E's upgrade from
marker-scan to grep-the-resolved-chain adoption detection.

**Stable backend contract** — read-only `electron/services/contextInspector.ts`
`inspectWorkspaceContext(workspaceId)` returns `{folder, gitRoot, adopted, sources[{tier, path,
exists, content, imports, excluded?, truncatedNote?, resolved?(deferred)}], effective?(deferred)}`.
v1 leaves `resolved`/`effective` undefined; completeness grows across phases without contract change.

### A.3 Render + open

Companion panel `context-inspector` (4-step recipe; read-only, modeled on `SessionOverviewPanel`, NOT
the editable memory panel): one collapsible section per tier, precedence top-to-bottom, "none"
placeholders, "excluded" badges, honesty header. Opened from **WorkspaceSwitcher** — a second
always-visible 📄 "Context" button next to "Workspace memory" (NO hover-reveal). New `context:inspect`
IPC + preload accessor; optional MCP `inspect_workspace_context`. Data fetched main-side, passed as
seed props — fully static (no companionApi, no live-refresh; a Refresh button re-invokes).

### A.4 Read-only + privacy

Inspector service exposes only `existsSync`/`readFileSync` — no write path into native files
anywhere. Honest read set: **F, F's ancestors up to the git root, `~/.claude/*`, and OS managed-policy
paths** — all read-only, no network, single device. Same posture as workspace memory (not a
confidentiality boundary; nothing leaves the device).

---

## B. EXPORT — portability

### B.0 What it is + honest scope

Materializes the **workspace tier ONLY** (`instructions` + `findings[]`) — excludes the per-session
tier (a per-directory file is structurally workspace-scoped; there's no "current session" when raw
`claude` boots in a folder). This exclusion is the keystone of the §E double-load fix. Built via one
shared pure `buildWorkspacePrimer(workspaceId)` feeding **both** inject and exporter (can't drift).

**Honest "not locked in our app" scope:** raw `claude` outside the app reads a snapshot **as fresh as
the last memory change made while Mission Control was open** (regen fires off the in-process
`onMemoryChanged` seam, which only fires while the app runs). App-independence holds only for
**folder-bound, explicitly adopted** workspaces. Mitigation: **regenerate all adopted exports on app
launch** (self-heals exports stale from while the app was closed).

### B.1 Format

```markdown
<!-- mission-control:workspace-memory v1 workspace=<workspaceId> -->
<!-- AUTO-GENERATED by Mission Control. Overwritten on the next memory change.
     One-way projection of the app's store — edits here are NOT read back. -->
# Workspace memory
## Standing instructions
<instructions>
## Durable findings        # pinned first, then active, then ruled-out
- 📌 <pinned> / - <active> / - ~~<ruled-out>~~ → <correction>
```
The leading HTML comment is the **identity marker** (workspaceId + schema): regen confirms "our file,
safe to overwrite"; §E detects a user `@import` of it. Claude strips it on injection (invisible to
Claude, readable by our `readFileSync` scan). The "edits NOT read back" line makes the
one-directional invariant legible.

### B.2 Location — OWNER DECISION 1

| Mode | Path | Notes |
|---|---|---|
| **A. In-folder, gitignored (DEFAULT)** | `<F>/.claude-tui/workspace-memory.md` | **Gitignore-first:** write `/.claude-tui/` to `.gitignore` *before* the file lands; **declining = don't export** (never untracked). Closes the `git add -A`-grab + worktree-worker hazard. |
| **B. In-folder, committed** | `<F>/.claude-tui-memory.md` | Brain travels with the repo, but: leaks half-formed agent findings to history; per-promote regen = noisy diffs; **a constantly-rewritten tracked file under `isolateWorkers` is a merge-conflict generator.** **DEFERRED + HARD-disabled when `isolateWorkers` is on.** |
| **C. User-chosen path** | any | The only option for untagged/folderless; default `~/.claude-tui/exports/<workspaceId>/workspace-memory.md` (outside any repo). |

> **DECISION 1 recommendation: Mode A (gitignore-first) default; Mode C always; Mode B deferred AND
> hard-blocked under `isolateWorkers`.** Team-sharing (B) is legit but collides with the isolated-worker model.

### B.3 Untagged / folderless (honest limitation)

Untagged sessions (the global `__untagged__` bucket) + folderless workspaces have **no in-folder
landing site**. Disable Modes A/B (with a one-line explanation, never a silent no-op); allow **Mode C
only**. The untagged export is **default-OFF** (max blast radius — wiring it into `~/.claude/CLAUDE.md`
makes *every* raw `claude` on the machine eat cross-project findings; warn explicitly at wire-time).
Untagged adoption config keys on `UNTAGGED_STEM` (no Workspace record to hold it), and §E's skip path
must check the same sentinel.

### B.4 Live regen (Decision 2)

`ExportService` subscribes to the confirmed every-mutation seam:
`workspaceMemoryService.onMemoryChanged((W) => exporter.regenerate(W))`. `onMemoryChanged` fires from
`persistAndEmit` on every mutation incl. `promoteFindings` (`workspaceMemory.ts:254/272/283/294/370`)
— **exactly the owner's driver, no new trigger.** `regenerate`: no-op if W not exported; re-validate F
(+ confirm Mode A's gitignore entry, else skip+surface); `buildWorkspacePrimer` → **temp-then-rename
with Windows retry-on-EPERM backoff** (a reader holding the dest); listener **catches its own errors**;
**only rewrite if the body changed** (skip no-op git churn).

### B.5 No-corruption adoption flow (hardened)

**Invariant: we produce ONLY our own file; we NEVER edit the user's CLAUDE.md without explicit,
reversible consent.** (1) **Default:** we write the file + show the exact `@import` line with a "Copy
line" button — we touch nothing of theirs. (2) **Opt-in one-time insert** (a "Wire it in for me"
button): appends ONLY a delimited `<!-- mission-control:import start/end -->` block to
`CLAUDE.local.md` (default) — **CRLF-agnostic match + preserve the file's EOL** (else duplicate
blocks), **read-modify-rename with a change-guard** (abort if the user edited it meanwhile),
**reversible "Unwire"** that refuses to auto-remove if the user hand-edited inside the block,
**single user-initiated main-window action, NOT MCP-exposed** (no concurrent-agent races). Tests:
double-run → one block; CRLF file → no duplicate; Unwire with user content inside → refusal. (3)
**Never silently edit.** If the user never wires it: the export sits inert, regenerated, and our
inject still works (the §E marker scan finds no `@import` → workspace tier stays in the inject).

---

## C. PROPAGATION — the realistic cross-session story

The owner's example ("promote in A → others consume") spans **two distinct freshness problems**:

| Case | Mechanism | Auto? |
|---|---|---|
| **(i) NEW session spawned after the promote** | `recallService.invalidate()` ran → next `getIndex()` re-derives the union incl. A's finding; `buildInjectedContext` reads the live store fresh at spawn. Export extends this to raw `claude`. | ✅ **YES, automatic** |
| **(ii) ALREADY-RUNNING session B** | B's payload froze at B's spawn (launch snapshot — true of every seam incl. CLAUDE.md @import). The `workspace:memory-changed` push reaches B's renderer chrome, **never B's Claude process** (`ipc.ts:183-190`, verified). | ❌ **NO** (by design) |

**Case (ii) — v1 = a pinned, honest nudge (not magic):** on a memory change for W, mark every
already-running terminal whose session `workspaceId` is W (scoped by `workspaceId`, never
`getActiveId()`) with a pending delta; surface a quiet **Agent Rail KNOWS** affordance ("Workspace
memory updated — re-prime to pull"). **"Re-prime" injects a stdin bracketed-paste instruction to the
running agent to call `get_session_context`** (reuses the existing idle-flush prompt path) — it
**prompts the pull, it does not itself inject the finding.** True zero-touch propagation to a live B
is **out of scope for v1**. **Adopted-mode freshness race:** since the workspace tier then lives in a
separately-regenerated file, **gate adopted-workspace spawns on an "export settled" barrier** (await
any pending `regenerate(W)`) + extend the nudge to adopted in-app running sessions.

---

## D. DATA-LOSS — ONE coherent backup story

Three artifact classes; **exactly one is the backup:**
- **EXPORT** = a per-workspace materialized file the user owns, for **portability**. A *derived, lossy,
  truncated* projection. **STRICTLY one-directional: app JSON → file, NEVER file → app store** (so a
  committed Mode B blob can never diverge from synced JSON).
- **SYNC pillar** (Slice 3 of the autoload-sync doc) = a `SyncService` committing the **source-of-truth
  JSON subset** to a private GitHub repo with record-level merge. **This is the backup**, not export.
- **`context/<terminalId>.md`** = a machine-local inject artifact, **never synced**.

**The urgent gap (verified):** `saveVersioned` overwrites in place (`workspaceMemory.ts:225`) — the
store is a single local copy with **no version history**. A bad `editFinding`/delete is unrecoverable
**today**.

> **OWNER DECISION 2 — pull a local-git down-payment forward (Slice D1).** `git` is already a hard
> runtime dep (worktrees), so `git init` + periodic `git commit` of the **entire** curated
> `~/.claude-tui` subset at **`~/.claude-tui/.local-history/`** gives free local versioned history
> (undo bad edits/deletes) in the gap between Slice 1 and the full Slice-3 sync. **Same mechanism as
> sync, remote-less — one coherent story.** **Recommendation: yes, before full GitHub sync.**

**Coverage + path separation:** D1 snapshots the **entire** memory + curated-sessions subset
(decoupled from the sync/export allow-list — a purely-local history is a data-loss net, not an exfil
surface). **The untagged "All" bucket — highest-value, least-recoverable — MUST be in the local net
by default** (else it has zero backup). D1's local repo (`~/.claude-tui/.local-history/`, full, never
pushed) and the Slice-3 sync repo (a distinct dir containing only the allow-listed subset) **never
share a working tree**, so a `push` can never exfiltrate a local-only/untagged bucket. Export files
are **never synced by us** (the user version-controls them in their own repo).

---

## E. THE DOUBLE-LOAD RECONCILIATION (definitive)

**Hazard:** user adopts the export (`@import`) → Claude folds the workspace primer in via
project-memory; **simultaneously** our `--append-system-prompt` injects the same tier → eaten twice.

**Corrected framing:** the two land in **different channels** (CLAUDE.md = a *user message*; Option A
= the *system prompt*) — Claude **cannot** dedup them, and **byte-identity is NOT the mechanism.** The
marker scan is load-bearing.

**The fix — split tiers, gated on a MANDATORY fresh marker scan:**
- **Always split:** inject delivers the per-**SESSION** tier (which a static per-folder file can't
  represent); export delivers the per-**WORKSPACE** tier (the only tier a per-directory `@import` can
  carry).
- **Detection decides whether the inject ALSO includes the workspace tier:** *not adopted* (default)
  → inject = workspace + session; *adopted* → inject = session only, workspace arrives via the
  `@import`. → workspace tier appears **exactly once**, session tier **always present**.
- **Detection = a v1 REQUIREMENT, fresh at every inject, default-SAFE:** exact-string grep for our
  marker over the host files the inject already reads — **project CLAUDE.md, CLAUDE.local.md, bounded
  parent CLAUDE.md, AND `~/.claude/CLAUDE.md`** (a literal scan — no @import expansion, inside v1's
  boundary). **When uncertain, INJECT** (a wasted double-load is recoverable; missing context is
  silent — the worse failure). A stored flag is demoted to a hint only for unreachable Mode-C custom
  paths (an explicit reversible "I've wired this myself" toggle). Deferred upgrade: grep the
  fully-resolved chain (shares the inspector's pre-release resolution).
- **Promoted-twin suppression must survive the session-tier-only build (verified `recall.ts:174-198`):**
  a promoted finding exists as BOTH a workspace finding (export) AND an origin session note (session
  tier), so the tiers *do* overlap for promoted findings. The session-tier-only build **takes the
  workspace findings as input to compute the `promotedKeys` suppression** even though it doesn't emit
  them. Test: *promote N to W, adopt export, spawn → N appears exactly once (in the @import file),
  zero times in the inject's session section.*

---

## F. Phasing → buildable units

**Prereq:** Slice 1 (Option A auto-load) shipped, incl. the shared `buildWorkspacePrimer`, the
truncating inject, the `pinned` field, and the session-tier-only build that still takes workspace
findings as the `promotedKeys` suppression input.

| Slice | Unit | Depends on |
|---|---|---|
| **D1** | **Local-git down-payment** — `git init` + periodic commit of the entire curated `~/.claude-tui` subset at `~/.claude-tui/.local-history/` (untagged always in; never pushed). **Orthogonal, closes the urgent data-loss gap.** | none |
| **I1** | **Inspector v1** — `contextInspector.ts` (tiers 0–7,10; git-root MEMORY.md; `claudeMdExcludes`; comment-strip + fence-skip; "none" for absent; truncation-parity + adoption-aware #10), IPC+preload, panel+route, switcher button, honesty copy. Read-only. **✅ SHIPPED (CAPP-98):** `ContextInspectorService` (inspect-only — `existsSync`/`readFileSync`/`readdirSync`, no native-file write path), `context:inspect` IPC, main+companion preload accessors, `inspect_workspace_context` MCP tool, the `context-inspector` companion panel + the WorkspaceSwitcher "Context" button. #10 ships as a plain truncated render with a `TODO(E2)` for adoption self-attribution. | Slice 1, E2 (for #10 adoption awareness — ship #10 in two passes if E2 lags) |
| **E1** | **Export v1** — shared `buildWorkspacePrimer`, `ExportService` (regen + atomic-write + Win retry + change-guard), Mode A (gitignore-first) + Mode C (untagged default-OFF + warning); one-directional header; copy-@import button; regen-on-launch. | Slice 1 |
| **E2** | **Adoption + double-load reconcile** — mandatory fresh marker scan (incl. `~/.claude/CLAUDE.md`), split-tiers default-safe-to-inject, promoted-twin suppression + test, corruption-hardened reversible insert/Unwire (non-MCP), untagged keyed on `UNTAGGED_STEM`. | E1 |
| **P1** | **Propagation nudge** — mark in-W running terminals on `workspace:memory-changed`, quiet Agent Rail "re-prime to pull" → stdin prompt to `get_session_context` (reuses idle-flush); "export settled" spawn barrier. | E1, E2 |
| **Deferred (pre-release)** | Inspector full chain-resolution + the grep-resolved-chain adoption upgrade (shared); Mode B (hard-blocked under `isolateWorkers`); the full GitHub **sync pillar** (the real backup). | I1, E2, D1 |

**Suggested order:** **D1 first/parallel** (orthogonal, urgent, no spike) → I1 → E1 → E2 → P1.

---

## G. Owner decision agenda

1. **Export default location** — Mode A (gitignore-first) default; Mode C always; Mode B deferred + hard-blocked under `isolateWorkers`. **Rec: adopt.**
2. **Data-loss down-payment (D1)** — local-git snapshot of the full `~/.claude-tui` curated subset at `~/.claude-tui/.local-history/`, before full GitHub sync. **Rec: yes (urgent).**
3. **Double-load reconcile** — split-tiers gated on a mandatory fresh marker scan, default-safe-to-inject, promoted-twin suppression preserved. **Rec: adopt.**
4. **Propagation for running sessions** — quiet Agent Rail nudge that prompts a `get_session_context` pull (no auto-inject/respawn). **Rec: adopt; honest label.**
5. **Inspector v1 scope** — discovery-only, @imports literal, but the FULL launch-context source set (managed + unconditioned rules + git-root MEMORY.md + `claudeMdExcludes`) + fidelity transforms; nested/path-scoped + effective-view deferred. **Rec: adopt.**
6. **Untagged/folderless export** — Mode C only, default-OFF, machine-wide warning, keyed on `UNTAGGED_STEM`. **Rec: adopt.**

---

## Residual honest limitations (stated, not hidden)
- v1 inspector lists launch *files* + their @import *lines* but does NOT expand imported *bodies* or
  show the merged *effective* context (pre-release).
- Already-running sessions don't auto-consume a promote — they get a nudge that prompts a pull.
  Zero-touch propagation to a live session is out of scope for v1.
- Untagged/folderless have no in-folder export; Mode C only, default-OFF.
- Raw `claude` outside the app reads a snapshot only as fresh as the last memory change made *while
  the app was open*.

*Anchors: `workspaceMemory.ts:223-227/254/272/283/294/370` (every-mutation `onMemoryChanged`), `:225`
(in-place overwrite = the data-loss gap), `:94-176` (untagged sentinel/normalization);
`workspaces.ts:435-447` (folder resolve); `terminals.ts:34` (`encodeProjectDir` — wrong for
auto-memory); `ipc.ts:183-190` (memory-changed push is renderer-only, no agent touch);
`recall.ts:174-198` (`promotedKeys` suppression — the §E session-tier contract).*
