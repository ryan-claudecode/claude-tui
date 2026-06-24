# GitHub Sync Pillar — Design

*The remote sibling of D1 (`localHistory.ts`, CAPP-95). Where D1 is the local data-loss net, Sync is the real backup: it persists the curated brain to a PRIVATE GitHub repo so it survives a disk loss AND propagates across the user's devices.*

Status: design (revised after three adversarial reviews — data-loss/correctness, security/scope, simplicity/solo-dev-fit). Parent: `docs/roadmap/context-autoload-sync-design.md` (Slice 3) + `docs/roadmap/claudemd-coexistence-design.md` §D (the one-backup story). Solo-dev, single-user, Windows-first, private.

> **Review-resolution note.** All three critiques converged on one root cause: *deletion and identity are modeled at the record level, but the file / workspace / device lifecycle around them is not.* This revision closes that gap (file-level tombstones §C.3a, never-GC tombstones §C.7, structural concurrency via the merge-base §C.3c, non-portable `deviceId` §C.2), makes **pull-apply a first-class path independent of push** (§E.1/§C.4 — the B1 backup-doesn't-restore bug), moves the **live-store write to exactly once after a successful push** (§C.4), and fixes the auth-scheme/argv-leak (§A.1). A per-finding **blocker→resolution map** is in §I.

---

## 0. What it is + the one-backup-story relationship to D1 / export

There are three persistence mechanisms over the durable brain, and they are deliberately distinct:

| Mechanism | What | Where | Remote? | Scope | The story it tells |
|---|---|---|---|---|---|
| **Export** (`export.ts`, CAPP-99) | Human-readable Markdown projection | `~/.claude-tui/exports/` | no | curated, untagged default-OFF | **Portability**, not backup — read your brain outside the app |
| **D1 local history** (`localHistory.ts`, CAPP-95) | A separate git repo over a snapshot of the curated subset | `~/.claude-tui/.local-history/` | **never** | the WHOLE curated subset, **untagged always-in** | **Local data-loss net** — undo a bad edit, the local down-payment |
| **Sync** (THIS doc) | A separate git repo over an allow-listed subset, pushed to a private GitHub repo | `~/.claude-tui/.sync/` | **private GitHub** | a NARROWER, opt-in allow-list, **untagged default-OUT** | **The real backup** — survives disk loss + propagates across devices |

**The one-backup story (from `claudemd-coexistence-design.md` §D):** EXPORT is portability; **SYNC is the backup**; D1 is the local down-payment on Sync. `context/<terminalId>.md` is machine-local and is NEVER synced or exported. The untagged "All" bucket is the highest-value/least-recoverable data — and the sharpest tension in this pillar (§D).

**The load-bearing relationship to D1:** Sync reuses D1's skeleton — the SEPARATE git repo over a *snapshot copy* of the curated subset (never a git over the live dir), the `HARDEN` git-flag block, the `spawnSync("git", …)` runner, the `setReloadHooks` reload seam, and `flush()` on `before-quit`. Sync adds exactly three things D1 deliberately omits: **(1) a remote**, **(2) a record-level JS merge** that runs over the JSON before git ever sees a conflict, and **(3) an allow-list filter** on the mirror.

> **⚠ Mirror is NOT reused verbatim (resolves security-M4).** The earlier draft said Sync "reuses D1's `mirrorSubset` verbatim" *and* "copies files, never directories." Those contradict: D1's `mirrorSubset` is `rmSync(recursive)` + `cpSync(recursive)`, which **follows a symlink/junction at or below the cleared subdir** — exactly the recursive-traversal class that wiped the repo (MEMORY: worktree wipe, 2026-06-19). Sync therefore introduces its OWN **file-granular** mirror (`mirrorForSync`, §B.2): it enumerates `*.json` files, `lstat`s each (refusing + logging any symlink), and `copyFileSync`s file-by-file; the clear step `unlink`s known files rather than `rmSync(recursive)` on a dir. No `cpSync`/`rmSync(recursive)` anywhere in `SyncService`. This is the one place we deliberately do NOT inherit D1's helper.

**The invariant that makes a remote safe:** D1 and Sync are **two separate dirs, two separate repos, two separate working trees** (and both are separate from the user's primary project repos + worktrees). D1's tree is *full* (untagged always in — it's the only backup for the least-recoverable bucket and never leaves the device). Sync's tree is *allow-list filtered*. Because they never share a working tree, **a push from `.sync/` can never exfiltrate a bucket the user didn't opt to sync**, and D1's "mirror everything" posture can never leak into the pushed tree. This is why D1 was built with no remote: adding a remote to D1 would let a push carry the always-in untagged bucket. Sync is a *different clone* with a *selective, file-granular mirror*.

---

## A. Auth + repo provisioning

### A.1 Mechanism — fine-grained PAT + Electron `safeStorage` (recommended)

| Option | Friction | Security | Verdict |
|---|---|---|---|
| **Fine-grained PAT** (single-repo, Contents:RW), stored via Electron **`safeStorage`** | Low — one guided paste, once | Good — least-privilege, encrypted at rest (DPAPI on Windows) | **RECOMMENDED for v1** |
| `gh` CLI (`gh auth token`) | Zero IF installed — but the project depends on `git`, not `gh`; forcing a CLI install is *higher* friction than one paste | Good, but couples us to an external tool's auth state | Opportunistic fallback only |
| OAuth device flow | Medium — but requires a **registered GitHub OAuth App (a `client_id` we'd ship + maintain)** | Best UX-at-scale, but infra we don't want to own for a solo tool | **Deferred** (nicer UX, ship as Mode 2 later) |

**Why `safeStorage` over keytar:** `safeStorage` ships **in Electron core** — zero new native dependency (keytar would join node-pty in the `asarUnpack` + rebuild dance CLAUDE.md warns about). On Windows it encrypts via **DPAPI** bound to the OS user account; the ciphertext is useless if copied to another machine/user. Guard at startup: `if (!safeStorage.isEncryptionAvailable())` → refuse to *store* a token (degrade to local-only D1, surface a Settings warning), never block the app.

**Storage shape** — a new file `~/.claude-tui/sync-credentials.json` (NOT `config.json`, which is user-editable + export-adjacent). This file is **per-device, never synced, never copied between machines** — it also holds the `deviceId` (resolves the cross-critique `deviceId`-portability blocker, §C.2):

```jsonc
{
  "version": 1,
  "deviceId": "<uuid minted once on this machine — the HLC tiebreaker, NOT in config.json>",
  "deviceBoundTo": { "osUser": "<os.userInfo().username>", "host": "<os.hostname()>" }, // collision repair seed
  "tokenCipher": "<base64 of safeStorage.encryptString(pat)>",
  "tokenFingerprint": "…a1b2",          // last4 + sha256[:8] — show "token ending …a1b2" without decrypting
  "remoteUrl": "https://github.com/<user>/mission-control-brain.git",
  "remoteOwner": "<login>",
  "remoteRepo": "mission-control-brain",
  "provisionedByLogin": "<github login that created/adopted the repo — bound into MANIFEST.json>",
  "scopesGrantedAt": "<ISO>",
  "lastValidatedAt": "<ISO>"
}
```

The PAT is **never** written plaintext, **never** put in `git remote set-url` (which would persist it in `.sync/.git/config`), **never** logged, and **never** placed on the child-process argv.

**Token injection — env / askpass, NOT `-c …extraHeader` on the argv (resolves data-loss-M8 + security-M2).** The earlier draft passed `-c http.…extraHeader="Authorization: Basic <base64(PAT)>"`, which (a) places the base64 token in the child process **command line**, readable by any same-user process / EDR / crash dump on Windows, and (b) used `x-access-token:` — the GitHub *App installation token* Basic convention, **wrong for a user fine-grained PAT**. We fix both:

- **Scheme:** a fine-grained user PAT authenticates over HTTPS Basic with the **token as the password** and any (or empty) username — `https://<anything>:<PAT>@github.com/…` equivalently `Authorization: Basic base64("x:<PAT>")`. We do NOT assume the `x-access-token` user. *(VERIFY-BEFORE-SHIP: confirm against GitHub's current docs that a fine-grained PAT is accepted as the HTTP Basic password — this is the kind of thing to confirm, not assume; tracked as an S3-auth-b acceptance gate.)*
- **Transport:** inject via a transient **`GIT_ASKPASS`** helper (a tiny script we write to the per-run temp dir, `chmod`'d, that echoes `$SYNC_PAT`) with `SYNC_PAT` set **only in the child's env**, and `GIT_TERMINAL_PROMPT=0`. The token never appears on any argv. The askpass script is deleted in a `finally`. Env is materially less exposed than argv on Windows and is the standard git credential channel.

```
// one short-lived push/pull
spawnSync("git", [<HARDEN…>, "push", "origin", "main"], {
  env: { ...HARDENED_ENV, GIT_ASKPASS: askpassPath, SYNC_PAT: pat, GIT_TERMINAL_PROMPT: "0" },
  timeout: <budget>,
})
```

Decrypt → set child env → spawn → token lives in one child's env for one push → never persisted, never on argv. Same runner as `localHistory.ts`, extended with the askpass env. **No agent/MCP path ever reads `sync-credentials.json` or the decrypted token** — auth is main-window-only.

### A.2 Repo provisioning — WE create the private repo (API), with a paste-URL fallback

Requiring the user to manually create + paste a URL is higher-friction and error-prone (wrong visibility, typo'd URL). With a token in hand we provision in one click via `POST /user/repos`:

```jsonc
{
  "name": "mission-control-brain",
  "private": true,             // HARD — we refuse to proceed if the response isn't private
  "auto_init": false,          // WE own the first commit (resolves the auto_init first-push merge churn, below)
  "description": "Mission Control durable brain — automated backup. Do not edit by hand.",
  "has_issues": false, "has_wiki": false, "has_projects": false
}
```

- **`auto_init:false` (resolves data-loss-m5 / simplicity-7).** `auto_init:true` makes GitHub create a server-side root commit (`README.md`) we don't control; the local seed commit then collides with it → the very first sync is an unrelated-histories merge against a README that isn't on the allow-list. Instead we create an **empty** repo and push our own root commit (README + `.gitignore` + `MANIFEST.json`) — clone-then-merge on every later device stays a trivial fast-forward, and the empty-import fast path (§E.2) holds.
- **Naming:** default `mission-control-brain` (configurable). On 422 "name exists" → offer **adopt-existing** (see the binding gate below) or pick a new name.
- **POST-CREATE hard check:** re-`GET` the repo; if `private !== true`, **abort — never attempt a delete** (refusing-to-proceed beats auto-deleting someone's repo). Surface "repo is public, refusing to sync" and unlink.
- **Seed root commit** (pushed by us): `README.md` ("automated backup, do not hand-edit"), a defense-in-depth allow-list `.gitignore` (`/*` then `!/workspace-memory/` `!/sessions/` `!/manifest.json`), and `MANIFEST.json`:
  ```jsonc
  { "missionControl": "brain-sync", "schemaVersion": 1, "appSchemaVersion": N,
    "ownerLogin": "<provisioning github login>" }   // ← ownership proof, see adopt gate
  ```
- **Adopt-existing — ownership binding (resolves security-M5).** A `MANIFEST.json` marker alone is NOT an ownership proof — a shared/old/hostile repo could carry a valid-looking manifest, and §E.2 would then merge its arbitrary agent-authored findings into the user's brain (findings are *prose a fresh spawn reads*; "argv-safe" ≠ "content-safe"). Adopt therefore requires: (1) the repo is private; (2) `MANIFEST.ownerLogin === GET /user.login` of the authenticated token; (3) on the **first import merge** specifically, the full pre-merge **import preview** (§B / §E.2) is shown and explicitly confirmed before any record is written to the live store — not just the first *push* preview. A repo that passes (1)+(2) but is foreign content still cannot silently inject; the human sees every finding first.
- **Paste-URL fallback** (org repos / pre-created): a Settings field accepting `https://github.com/<o>/<r>.git`; we still `GET /repos/{o}/{r}` to validate `private:true` + push access, and run the same ownership/preview gate before linking.

### A.3 Scopes / rotation / revocation — degrade, never block

**Least-privilege fine-grained PAT:** "Only select repositories" → the single brain repo; **Contents: Read and write** (always); **Administration: Read and write** *for the one-time create only* (recommend the user downgrade after setup, or mint a short-lived create token then a long-lived Contents-only token). Paste-URL users need only Contents:RW. Nothing else.

**Rotation:** Settings → "Replace token" → paste new → **validate before swapping** (`GET /user` + a repo `GET` to confirm push access) → overwrite `tokenCipher`. The user revokes the old token on github.com (we link them there).

**Failure modes (distinguish credential vs network):**
- **401/403** → mark `credentialState: "invalid"`, **stop pushes**, surface ONE non-blocking Settings banner ("Sync token expired — backup is local-only until you re-auth"), fall back cleanly to D1. The app/terminals/agents are **never** blocked.
- **Network offline** (ENOTFOUND / timeout) → pushes queue/skip silently, retried next cycle. **Do NOT flip `invalid` on a network error** — it's not a credential failure.
- **Token missing** (never set up) → sync inactive, no nags; D1 alone covers local loss.
- **`safeStorage` unavailable** → refuse-store, local-only.

### A.4 Setup UX — main-window Settings only, NO MCP credential path

Hard rule: **no MCP tool touches credentials.** No `sync_setup`/token tool exists. Agents can at most read a tokenless `sync_status`. Provisioning + auth are main-window-only, behind explicit user gestures (no hover-reveal — every control statically visible, per `feedback_no_hover`). The flow:

1. **State line** (always visible): `Local backup: ON (D1)` · `Cloud sync: not set up | active | token expired | offline | update required (this device stranded)`.
2. **"Connect GitHub"** → (a) **"Create a fine-grained token"** button `open_external`s `https://github.com/settings/tokens?type=beta` with copy-able instructions; (b) **Paste token** (masked) → `GET /user` validates + captures the login → `Connected as @<login>`; token encrypted + stored.
3. **"Create the private backup repo"** → API provision (§A.2) → show the repo link + `Cloud sync: active`. OR **"Use an existing repo"** → paste-URL → validate-private + ownership gate → import preview → link.
4. **Allow-list** (§B): per-workspace `Sync this workspace ☐` (default OFF) + a separate, visually-distinct `Sync untagged "All" bucket ☐` (default OFF, with the cross-project warning). **Pre-push preview** before the first push. **Un-sync** here is "stop pushing changes" — NOT "delete on other devices" (§D.1).
5. **"Replace token" / "Disconnect"** (disconnect = forget the token + remove origin from `.sync/`; never deletes the remote repo or local data).

---

## B. What's synced — the allow-list + the mirrored-tree path separation

D1 and Sync are siblings with **deliberately different scopes**, and the difference IS the security story:

| | D1 (`.local-history/`) | Sync (`.sync/`) |
|---|---|---|
| Scope rule | Snapshot the **entire** curated subset — a data-loss net wants everything | A **narrower, explicit allow-list** — every byte leaves the device, so scope is a privacy decision |
| Untagged bucket | **Always in** | **Default-OUT**, separate opt-in (§D) |
| Mechanism | deny-list (safe — nothing leaves) | **allow-list (fails closed)** |
| Mirror | `cpSync`/`rmSync` recursive (local-only, safe) | **file-granular, symlink-refusing** (§0, §B.2) |
| Remote | never | private GitHub |

**Why an allow-list, not a deny-list (the load-bearing security choice):** D1 can deny-list because nothing leaves the device. Sync **cannot** — a new artifact dropped into `~/.claude-tui` next quarter (a new service's JSON) would be silently swept into a deny-list mirror and pushed. An allow-list **fails closed**: a new file is invisible to sync until someone explicitly adds it.

### B.1 `SYNC_ALLOWLIST` — the exact set

```ts
// electron/services/sync.ts — the ONLY files that ever enter the sync working tree.
export interface SyncAllowlistEntry {
  srcSubdir: "workspace-memory" | "sessions"
  /** Per-file gate: returns the bytes to write to the sync tree, or null to SKIP. */
  transform: (relPath: string, raw: string) => string | null
}
```

| Source | Synced? | Transform before it enters the tree |
|---|---|---|
| `workspace-memory/<W>.json` (tagged) | ✅ only if `W` ∈ the per-workspace **sync opt-in** set | none (already curated) |
| `workspace-memory/__untagged__.json` | ⛔ **default** / ✅ only behind the **separate untagged toggle** (§D) | none |
| `sessions/<S>.json` | ✅ **whitelist transform** — keep `{id,name,status,workspaceId,summary,notes,provisionalFindings,createdAt,updatedAt,deletedAt,hlc,statusHlc,nameHlc,summaryHlc}`; **strip every `TerminalRef` to `{name}`**; **DROP `eventLog`** | `stripSessionForSync(raw)` — pure; round-trip test asserts no absolute path / no `ccConversationId` / no `eventLog` survives |
| `context/<terminalId>.md` | ❌ **NEVER** | machine-local inject artifact, regenerated locally |
| `logs/`, `missions/`, `config.json`, `layouts.json`, `exports/` | ❌ out of v1 | logs leak prompts/output; missions are worktree/branch-tied; config + exports are per-device path state; `config.json` is user-editable AND no longer holds `deviceId` |
| `.local-history/` (D1 repo) | ❌ **NEVER** | a nested `.git` (§B.3) |
| `~/.claude/projects/` transcripts | ❌ never | Claude-owned, machine-local, raw |

**`eventLog` is dropped, not synced (resolves security-M3).** `eventLog` is free-text event prose (`logEvent` writes things like `Corrected an earlier note: <text>`, spawn/correction events) — it is neither user-curated like findings nor structurally strippable, so it can carry absolute paths, command-output fragments, and prompt text, defeating the "no absolute path survives" round-trip assertion. It is reconstructable from notes' `createdAt` (the `getTimeline` backfill path already does this), so dropping it is lossless for the surfaces that matter. The round-trip test explicitly asserts `eventLog` is absent from the synced bytes.

### B.2 The transform stage + the file-granular, symlink-refusing mirror (the boundary)

`stripSessionForSync` is a **pure function** (hermetically testable, mirrors `export.ts`'s shared-builder discipline). The mirror itself is file-granular and never recursive (§0):

```
mirrorForSync():                                         // ATOMIC per cycle — builds into a temp tree, then swaps
  tmp = <syncTree>/.mirror-tmp                           # fresh scratch dir we own
  for entry in SYNC_ALLOWLIST:
    for liveFile in listJsonFiles(srcSubdir(entry)):     # ENUMERATE *.json — never readdir a dir for recursion
      if lstat(liveFile).isSymbolicLink(): log+skip; continue   # refuse symlinks/junctions (wipe-lesson)
      if not optedIn(liveFile): continue                 # per-workspace gate / untagged gate (mirror = privacy boundary)
      out = entry.transform(relPath, read(liveFile))
      if out == null: continue                           # transform vetoed it
      out = canonicalJson(out)                           # STABLE key order (resolves echo-churn m11 — see §C.4)
      atomicWrite(tmp/<sub>/<relPath>, out)              # temp-then-rename + Win EPERM retry (export.ts)
  // mirror is now COMPLETE in tmp. Swap is the commit point:
  for sub in ["workspace-memory","sessions"]:
    unlinkKnownFiles(<syncTree>/<sub>)                   # per-file unlink of *.json we manage; NEVER rmSync(recursive)
    movePreparedFiles(tmp/<sub> -> <syncTree>/<sub>)     # rename per file (atomic on same volume)
  rmdir tmp (empty)
  writeSentinel(<syncTree>/.mirror-ok)                   # "mirror completed" marker; commit refuses without it
```

**Mirror is all-or-nothing before commit (resolves data-loss-M7 + simplicity-3).** The earlier clear-then-copy left a window where a 4s before-quit budget (or a crash, or a Win EPERM on one file) could interrupt *between* the recursive clear and the re-copy, committing a **torn, partially-empty tree** — which the next sync's `mergeTree` would read as remote-only deletions and propagate. We fix this two ways: (1) build the whole mirror into `.mirror-tmp` and swap only after it is complete; (2) `commitLocal` **refuses to commit unless `.mirror-ok` exists and post-dates the last clear** — an interrupted mirror is never committed, never pushed. The before-quit path (§E.1) only ever pushes an *already-committed clean* tree; it never starts a fresh mirror under the 4s gun.

A finding/note is **curated text only** — it inherits the CAPP-87 curation boundary (the only way text enters these stores is a deliberate `session_note`/`add_workspace_memory`/promote). Sync does **not** re-validate finding *content* for secrets (the user's curation responsibility, matching the single-user not-a-confidentiality-boundary posture) — but it **does** mechanically strip the *structural* machine-local fields (paths, conversation ids, PTY ids, model/effort/activity) AND drop `eventLog`. The allow-list is also the **single source of truth** the pre-push preview (§E) renders from — preview and the actual push read the same list, so they can never disagree.

### B.3 Path separation — three repos that never share a working tree (the wipe lesson)

```
~/.claude-tui/
├── workspace-memory/        ← live store (source of truth)
├── sessions/                ← live store
├── context/                 ← machine-local, NEVER mirrored anywhere
├── sync-credentials.json    ← safeStorage ciphertext + deviceId (never in any tree, never synced)
├── .local-history/          ← D1: local git, NO remote, FULL curated subset incl. untagged
└── .sync/                   ← THIS: clone of the GitHub brain repo
    ├── .git/                ← ONE remote (origin = the private brain repo)
    ├── .mirror-ok           ← "mirror completed" sentinel
    ├── manifest.json
    ├── workspace-memory/    ← ONLY allow-listed workspace ids
    └── sessions/            ← curated whitelist transform
```

| Repo | Location | Remote | Working tree |
|---|---|---|---|
| **Primary** (user's project) | `…/claude-tui-app/` + worktrees | user's `origin` | source code |
| **D1 local history** | `~/.claude-tui/.local-history/` | **none, ever** | full curated subset |
| **Sync** | `~/.claude-tui/.sync/` | private GitHub | allow-listed subset only |

Invariants enforced in `SyncService`:

1. **The sync tree is its own dir with its own `.git`, mirrored from the source — never a worktree of anything** (exactly D1's "git over a SNAPSHOT COPY, not a git over the live dir"). `SyncService` `git init`s `.sync/` and adds the GitHub remote.
2. **`.sync/` and `.local-history/` are siblings, never nested** — a push from `.sync/` walks only `.sync/`'s tree; it can never follow into `.local-history/` or the primary repo.
3. **The mirror copies *files*, never directories, and refuses symlinks** (§0, §B.2). No `cpSync`/`rmSync(recursive)` exists in this service. The clear step `unlink`s the specific `*.json` files the mirror manages; it never targets a live dir, never a worktree.
4. **No `git worktree` anywhere in this service.** The memory HARD RULE ("NEVER `git worktree remove --force` / `Remove-Item -Recurse` on a worktree") is honored by construction.
5. **Defense-in-depth assertion:** before any unlink/move, assert `syncTree` resolves under `~/.claude-tui/.sync/` and is not equal to or a parent of the live root — refuse + log otherwise. (This is a *root* guard; the file-granular + symlink-refusal in §B.2 is what actually defeats the junction-follow, since a path-prefix check on the root cannot stop a recursive op from dereferencing a junction *below* it — which is precisely why we removed the recursive op.)

Every `git` call reuses D1's `HARDEN` flag set verbatim (`core.hooksPath=`, `core.excludesfile=`, `core.autocrlf=false`, `core.safecrlf=false`, `commit.gpgsign=false`) so the user's global git config can't corrupt the JSON round-trip or block commits. (A global `excludesfile` ignoring `*.json` would otherwise silently empty every push.)

---

## C. The merge algorithm

Git is **transport only**. We never let git attempt a content merge — a whole-file `git merge` of `workspace-memory/<W>.json` would conflict on every concurrent edit (two byte-different blobs at one path → `<<<<<<<`), unusable for an append-mostly store. The merge is ours, in JS, in a **pure, fs-free module** `electron/services/syncMerge.ts` (`mergeTree`, `mergeFile`, `mergeRecord`, `dedupePromotionPairs`, `hlcTick`, `hlcCmp`, `concurrentWithBase`, `canonicalJson`) — hermetically testable, the unit a future hosted backend reuses unchanged.

> **The merge runs over THREE inputs, not two: `base` (the common-ancestor tree at the last-synced commit), `local`, and `remote`.** This is the single biggest change from the earlier draft and it resolves the concurrency-detection blocker (data-loss-M4 / security-B2 / simplicity-4): *concurrency is decided structurally — "did both sides change this record since the base?" — not by a wall-clock skew window.* The base is read from `git show <lastSyncedRef>:<path>` (the merge-base commit), which we already track.

### C.1 Granularity — record-level

- **File level** — the set of `workspace-memory/<W>.json` + `sessions/<S>.json`. New file on one side → union it in **unless a file-level tombstone says it was deleted** (§C.3a).
- **Record level** — *within* a file: the `findings[]` (workspace) / `notes[]` + `provisionalFindings[]` (session) keyed by `id`, plus scalar cells each treated as one LWW cell **with its own clock**.

Merge keys: workspace finding = `finding.id`; session note = `note.id`. The `(originSessionId, originNoteId)` pair is a *secondary dedup invariant* that must survive the merge (§C.5) — NOT the merge key (authored findings have no origin pair).

### C.2 The clock — Hybrid Logical Clock (HLC) per record + per scalar cell

**The load-bearing gap today:** `Note` has only `createdAt`; `editFinding`/`setInstructions`/`setPinned` mutate text with **no timestamp bump**. Two devices editing the same `id` produce byte-different records that are *temporally indistinguishable* → union-by-id silently drops one. **Slice 2 closes this before any transport ships.**

| Option | Verdict |
|---|---|
| Raw wall-clock LWW (`Date.now()`) | **Reject as sole mechanism** — a wrong-clock device wins forever, silently burying correct edits. |
| Pure Lamport counter | Rejected — no human-readable "edited 3m ago"; nonsensical to seed from `createdAt`. |
| **Hybrid Logical Clock** | **Recommended** — `(wall, count, device)`. Reads as wall-clock for the UI; `count` breaks *same-wall* ties; the deterministic `device` tiebreaker makes both devices compute the same winner. |

```
hlcTick(prev, now=Date.now()):
   wall  = max(prev.wall, now)
   count = (wall == prev.wall) ? prev.count + 1 : 0
   return { wall, count, device: THIS_DEVICE_ID }

hlcCmp(a, b) = cmp(a.wall, b.wall) || cmp(a.count, b.count) || cmp(a.device, b.device)
```

**Honest statement of HLC's limit (resolves security-B2's self-contradiction):** an HLC does **not** "absorb skew so the right edit always wins." `count` only breaks ties at *equal* `wall`; for two truly blind-concurrent edits with different walls, the higher wall wins — so a device whose clock is minutes ahead will *win the LWW tiebreak* on conflicting records. This is inherent to every LWW-family clock and is **acceptable for a solo user only because of two backstops, not the clock:**
1. **The loser is never lost** — a genuine concurrent edit (detected structurally, §C.3c) always surfaces the loser as a recoverable **review sibling**; LWW only chooses which one is *shown first*.
2. **A skew clamp makes a wild clock visible, not silently dominant** — on read, a record whose `hlc.wall` exceeds local `Date.now()` by more than a few minutes is **flagged** (a Settings hint "a synced device's clock looks off") rather than allowed to silently dominate. We do NOT rewrite its clock (that would break convergence determinism); we surface it.

`THIS_DEVICE_ID` is `deviceId` from **`sync-credentials.json`** — a stable per-install uuid in a **non-synced, non-user-editable, non-portable** file (resolves data-loss-m10 / security-m1 / simplicity-5). It is NOT in `config.json` (which §A.1 calls user-editable, is out of the allow-list, and which a user might copy machine-to-machine — collapsing the tiebreaker and breaking convergence). **Collision repair:** on `bootPull` we scan device ids present in the remote DAG's HLCs; if our `deviceId` already appears under a *different* `deviceBoundTo.{osUser,host}` than ours, we **re-mint** a fresh `deviceId`, warn, and continue (two installs sharing an id is the cloned-`~/.claude-tui` failure).

**Schema additions (Slice 2, additive + optional). EVERY merged scalar cell gets its own HLC (resolves data-loss-B2):**
```ts
hlc?:  { wall: number; count: number; device: string }   // per record, bumped on EVERY mutation
deletedAt?: Hlc                                           // record tombstone (HLC, not bool)
fileDeletedAt?: Hlc                                        // FILE-level tombstone (§C.3a)
// per scalar cell — one HLC EACH; mergeFile enumerates exactly these, never an unclocked cell:
instructionsHlc?: Hlc   // workspace-memory: bumped by setInstructions
summaryHlc?: Hlc        // session: bumped by setSummary
statusHlc?: Hlc         // session: bumped by setStatus       (was unclocked → silent drop)
nameHlc?: Hlc           // session: bumped by rename           (was unclocked → silent drop)
```
The S-merge-clock ticket MUST enumerate every merged scalar cell and bump it in its mutator. `mergeFile` reads only clocked cells; **`status` and `name` are no longer merged by undefined-HLC** (the earlier draft listed `[summary,status,name]` for merge but only defined `summaryHlc`, so `status`/`name` fell through to `hlcCmp(undefined,undefined)` and always-picked-local — a silent drop of a rename or status change made on the other device).

**Seeding missing clocks (NEVER from epoch):** on first load of a legacy file, a record with no `hlc` is seeded `hlc = { wall: promotedAt ?? createdAt, count: 0, device: deviceId }`. Each scalar cell's HLC seeds the same way. Epoch-seeding would make every legacy record lose to any new edit; `createdAt`-seeding preserves real recency. Done once in `loadOrCreate`/the session loader, written back (read-repair, as `persist.ts` already does on migration). *(Note, data-loss-m12: `createdAt` is itself a possibly-skewed wall value across devices; it only **seeds** an origin clock and is never an ordering input post-seed, so a slightly-wrong seed is harmless.)*

**Git DAG as a coarse causality hint (optimization, not the clock):** if the incoming remote commit is a descendant of our last-synced commit (`git merge-base --is-ancestor`), there were no concurrent edits → we still **apply the remote tree to the live store** (the fast-forward is NOT a "skip apply" — see §C.4 / B1) but skip the per-record merge. HLC is the source of truth for *which record wins*; the DAG only says *whether we need to look*.

### C.3 The core merge — pseudocode (base-aware)

```
// ── top level: 3-way merge of trees. base = tree at lastSyncedRef; local/remote as before. ──
mergeTree(base, local, remote) -> { merged, conflicts[] }:
   merged = {}; conflicts = []
   for path in union(keys(base), keys(local), keys(remote)):
      B = base.get(path); L = local.get(path); R = remote.get(path)
      // (a) FILE-LEVEL tombstone — a whole deleted session/workspace must NOT resurrect
      decision = resolveFilePresence(B, L, R)             // §C.3a
      if decision.deleted: merged[path] = tombstoneFile(decision.hlc); continue
      if decision.onlyOne: merged[path] = decision.file; continue
      { file, sibs } = mergeFile(path, B, L, R)
      merged[path] = file; conflicts.push(...sibs)
   return { merged, conflicts }
```

#### C.3a File-level tombstones — a deleted session/workspace never resurrects (resolves simplicity-2)

The earlier `if R and not L → adopt R` could not tell "new on remote" from "deleted on local," so killing a session on A or un-syncing a workspace would have B re-introduce the file on every sync. Fix: deletion is carried **inside the JSON envelope** as `fileDeletedAt` (an HLC), and the file stays **present-but-tombstoned** in the tree rather than vanishing:

```
resolveFilePresence(B, L, R):
   // present means: file exists AND fileDeletedAt is unset.
   for each side compute (exists, fileDeletedAt)
   // A side "deleted since base" iff it has fileDeletedAt newer than base's record clocks.
   if either side has fileDeletedAt:
      winnerDel = maxHlc(L.fileDeletedAt?, R.fileDeletedAt?)
      // a live edit AFTER the delete revives (same rule as records, §C.3b); else stays deleted
      if anyRecordHlc(live side) > winnerDel: return { onlyOne: revivedFile }
      return { deleted: true, hlc: winnerDel }
   if exactly one side has the file (and base did NOT): return { onlyOne: thatFile }   // genuine new file
   if base had it and exactly one side dropped it WITHOUT a tombstone:                  // legacy hard-delete
      // conservative: treat absent-vs-base as a delete ONLY if accompanied by fileDeletedAt;
      // a bare disappearance (e.g. opted-out of mirror) is NOT a delete → keep the surviving copy.
      return { onlyOne: survivingFile }
   return { both: true }                                                                // → mergeFile
```

So: **kill a session** ⇒ the mirror writes the session file with `fileDeletedAt` set (instead of omitting it) ⇒ it propagates as a deletion and stays deleted on every device. **Un-sync a workspace** ⇒ the mirror simply *stops updating* that file (it is NOT given a `fileDeletedAt`); a bare disappearance is never treated as a delete (§D.1). Tombstoned files are filtered from every read surface, exactly like record tombstones, so the brain looks identical locally.

#### C.3b One file (3-way) — scalar cells (LWW by HLC) + the keyed record array

```
mergeFile(path, B, L, R) -> { file, sibs }:
   out = clone(L envelope shell)
   out.createdAt = min(L.createdAt, R.createdAt)
   // (a) scalar cells — each its OWN clocked LWW cell; ties resolve via device id
   for cell in scalarCellsOf(path):                        // workspace: [instructions]; session: [summary,status,name]
      out[cell] = hlcCmp(L[cellHlc], R[cellHlc]) >= 0 ? L[cell] : R[cell]   // every cell has a defined *Hlc (C.2)
   // (b) the record array, keyed by id, base-aware
   sibs = []; byId = {}
   for rec in concat(L.records, R.records):
      existing = byId[rec.id]
      if not existing: byId[rec.id] = { rec, baseRec: B?.recordById(rec.id) }
      else:
         { winner, sibling } = mergeRecord(existing.baseRec, existing.rec, rec)   // base passed in
         byId[rec.id] = { rec: winner, baseRec: existing.baseRec }
         if sibling: sibs.push(sibling)
   out.records = values(byId).map(x => x.rec)
   // (c) re-establish the promote-dedup invariant AFTER union (§C.5)
   { records, twinSibs } = dedupePromotionPairs(out.records)
   out.records = records; sibs.push(...twinSibs)            // twin-collapse can ALSO surface a sibling (C.5)
   // updatedAt is DERIVED-ON-READ, never a merged+pushed field (resolves data-loss-M5 / security-m2)
   delete out.updatedAt                                     // do not persist a merged wall; UI computes from max(hlc, clamp(localNow))
   return { file: out, sibs }
```

#### C.3c One record (3-way) — tombstones + structural concurrency + HLC LWW

```
mergeRecord(base, a, b) -> { winner, sibling? }:
   // 1. RECORD TOMBSTONES win over a stale live copy (the resurrection guard) — never GC'd in v1 (§C.7)
   aDead = a.deletedAt; bDead = b.deletedAt
   if aDead and bDead:        return { winner: withDeletedAt(a, maxHlc(aDead,bDead)) }
   if aDead and not bDead:
      return hlcCmp(b.hlc, aDead) > 0 ? { winner: b }      // edited AFTER delete → revive (rare, intentional, §m13)
                                      : { winner: a }      // stale present copy → STAYS DELETED
   if bDead and not aDead:
      return hlcCmp(a.hlc, bDead) > 0 ? { winner: a } : { winner: b }
   // 2. both live, identical content → take higher HLC, no conflict
   if contentEqual(a, b): return { winner: hlcCmp(a.hlc, b.hlc) >= 0 ? a : b }
   // 3. STRUCTURAL concurrency: did BOTH sides change this record since the common ancestor?
   //    (replaces the wall-clock MAX_SKEW_MS window — resolves M4/B2/simplicity-4)
   if concurrentWithBase(base, a, b):
      winner = hlcCmp(a.hlc, b.hlc) >= 0 ? a : b            // LWW only PICKS the shown-first one
      loser  = winner === a ? b : a
      return { winner, sibling: { id: a.id, kept: winner.text, alsoEdited: loser.text, onDevice: loser.hlc.device } }
   // 4. one side unchanged-since-base → the other's change is a clean causal succession, no conflict
   return { winner: hlcCmp(a.hlc, b.hlc) >= 0 ? a : b }

// concurrentWithBase(base, a, b):
//   changedA = !base || !contentEqualHlc(base, a)    // a differs from the ancestor
//   changedB = !base || !contentEqualHlc(base, b)
//   return changedA && changedB                      // BOTH moved since base ⇒ genuinely concurrent
//   No wall-clock window. If there is no base (record born after lastSyncedRef on both sides
//   with the same id — only possible for promote-twins, handled in C.5), treat as concurrent → surface a sibling.
//   Erring toward "surface a sibling" is non-lossy; erring toward "causal, drop loser" is lossy.
```

**Why structural beats the skew window.** The old `concurrent()` used `MAX_SKEW_MS ≈ 2 min`: two genuinely concurrent edits more than 2 minutes apart in wall time were classified *causal* and the loser was **silently dropped, no sibling** — exactly the failure H5 promises never happens — and a fast-clocked device evaded the window entirely. `concurrentWithBase` asks the only question that matters: *did both sides move this record away from the last agreed-upon version?* If yes, it is a conflict regardless of clocks, and we surface the sibling. Same-device successive edits compare equal against the base on the unchanged side, so they are never false-positive conflicts.

### C.4 The sync loop — pull-apply is FIRST-CLASS, live-store write happens ONCE after a successful push

Two structural fixes here, both flagged by every critique:
- **B1 — pull-apply must run on the fast-forward / strictly-behind path too.** The old loop only called `applyMergeToLiveStore` inside the divergent `else`, so a genuine first boot where local `.sync` is behind origin would fast-forward git and leave the freshly pulled brain sitting in `.sync/` **never written into the live store** — the backup silently doesn't restore. Pull-apply is now its own first-class step that always merges base/local/remote and applies, independent of whether we then push.
- **B3 / M3 / simplicity-8 — `applyMergeToLiveStore` runs EXACTLY ONCE, after the push succeeds**, not inside the retry loop. The old order (`merge → apply → commit → push`, re-mirroring from the now-mutated store on `continue`) made an irreversible live-store mutation inside a loop that could run 5× and still `ERROR`, and re-fired the CAPP-101 nudge mid-loop. Now the loop computes bytes into `.sync/` only; reconciliation to the live store is a single post-success call.

```
sync(reason) -> SyncResult:
   if syncInFlight: return BUSY                              // single-flight; concurrent triggers coalesce
   syncInFlight = true
   try:
      // ── PHASE 1: PULL-APPLY (always; this is the restore path) ──
      git("fetch","origin","main")
      remoteRef = git("rev-parse","origin/main")
      base   = readTreeAtRef(lastSyncedRef)                  // common ancestor (empty on first boot)
      remote = readTreeAtRef("origin/main")
      schemaGate(remote)                                     // §C.6 — may THROW SchemaStranded → status "update-required"
      if remoteRef != lastSyncedRef:
         mirrorForSync(); commitLocal("pre-sync snapshot")   // refuses if no .mirror-ok (§B.2)
         local = readTreeFromWorkdir(.sync/)
         { merged, conflicts } = mergeTree(base, local, remote)
         writeTreeToWorkdir(.sync/, merged)                  // atomic per file (export.ts); canonicalJson bytes
         applyMergeToLiveStore(merged, conflicts)            // ① the ONE live-store write — pull side (B1)
         git("add","-A")
         // deterministic merge commit WITHOUT --amend (resolves data-loss-M9): build the exact tree+parents.
         tree   = git("write-tree")
         commit = git("commit-tree", tree, "-p", "HEAD", "-p", remoteRef, "-m", "sync merge")
         git("reset","--soft",commit)                        // move HEAD to the 2-parent merge; no --amend fragility
      // else: remote == lastSyncedRef → nothing new remotely; live store already authoritative.

      // ── PHASE 2: PUSH (bounded retry) ──
      mirrorForSync(); commitLocalIfChanged()                // local edits since pull → a new commit (skip if empty)
      if nothingToPush AND remoteRef == lastSyncedRef: return OK(merged:false)
      for attempt in 1..MAX_ATTEMPTS (=5):
         r = git("push","origin","main")
         if r.ok:
            lastSyncedRef = git("rev-parse","HEAD")
            return OK(merged: phase1Merged, conflicts)
         if r.rejected_nonfastforward:                        // someone pushed in the gap → re-pull-apply, retry
            git("fetch","origin","main"); remoteRef = git("rev-parse","origin/main")
            base = readTreeAtRef(lastSyncedRef); remote = readTreeAtRef("origin/main"); schemaGate(remote)
            local = readTreeFromWorkdir(.sync/)
            { merged, conflicts } = mergeTree(base, local, remote)
            writeTreeToWorkdir(.sync/, merged)
            applyMergeToLiveStore(merged, conflicts)          // ② still the ONE-per-converged-result write; idempotent
            git("add","-A"); tree=git("write-tree")
            commit=git("commit-tree",tree,"-p","HEAD","-p",remoteRef,"-m","sync merge"); git("reset","--soft",commit)
            continue
         else: return ERROR(r.stderr)                         // auth/network → surface, don't spin
      return ERROR("max push attempts exceeded")              // bounded; next scheduled sync retries
   catch SchemaStranded: return STRANDED                      // §C.6 — distinct status, edits safe in D1
   finally: syncInFlight = false
```

> **On `applyMergeToLiveStore` "once":** in the rare contended case the loop re-merges and re-applies the *converged* result. `applyMergeToLiveStore` is **idempotent** (it writes the merged record set through the reload hooks; re-writing identical merged bytes is a no-op against the live store and produces an empty commit). The invariant the critiques demanded — *no live-store mutation that is never reflected remotely* — holds because the loop only returns `OK` after a push the converged bytes were part of; an `ERROR`/exhaustion return means the **same** converged bytes are still in `.sync/` and will be pushed next cycle, and the live store already matches them.

Key properties:
- **`commit-tree`, not `merge -s ours --amend`** — we construct the merge commit with the exact tree we computed and exactly two parents (`HEAD`, `origin/main`), so `isAncestor(remoteRef, HEAD)` is reliably true afterward and the next fast-forward check works. The earlier `git merge -s ours --no-edit` + `git commit --amend` could amend the *wrong* commit and drop the second parent, wedging every future sync into a re-merge. Git's content merge never runs → no `<<<<<<<` can land in JSON.
- **Bounded retry** (`MAX_ATTEMPTS=5`) — never an infinite spin; exhaustion surfaces an error, the next scheduled sync retries.
- **Single-flight per process** — one `sync()` per process; concurrent triggers (debounced change + manual + startup) coalesce. *(data-loss-m3: two app instances on one machine could still race the `.sync/` index. We take a file lock on `~/.claude-tui/.sync/.synclock`; failure to acquire → treat as transient `local-only` and skip this cycle. Rare for this app, but cheap.)*
- **All git calls reuse D1's `HARDEN` flags**; never any recursive-delete of a worktree; `.sync/` is a normal dir we mirror into, never a `git worktree`.

**Convergence guarantee:** winner-selection in `mergeRecord` is commutative + associative over `hlcCmp` (a total order with the deterministic `device` tiebreaker; tombstones compare by the same order; `concurrentWithBase` is symmetric in `a`/`b`). With a shared `base`, `mergeTree(base,A,B) ≡ mergeTree(base,B,A)` for the winner set + the tombstone set + the dedup collapse → both devices reach **byte-identical** merged state (`canonicalJson` pins serialization so "identical" is literally byte-equal, resolving the echo-churn loop m11). Sibling *display ordering* may differ per device but is cosmetic and non-persisted.

### C.5 The promote-dedup invariant + twin-collapse surfaces a sibling

The store's correctness rests on *at most one workspace finding per `(originSessionId, originNoteId)` pair*. A naïve union-by-`id` breaks this across devices: A and B each promote the *same* session note → two findings with **different `id`s** but the **same origin pair**. `dedupePromotionPairs` runs as step (c) of `mergeFile`, after the id-union:

```
dedupePromotionPairs(records) -> { records, twinSibs }:
   byPair = {}; remapId = {}; twinSibs = []
   for f in records SORTED ASCENDING by hlcCmp:             // LAST (highest HLC) wins deterministically
      if f.originNoteId == null: keep(f); continue          // authored finding, no origin pair → never deduped
      key = f.originSessionId + ' ' + f.originNoteId
      if key in byPair:
         prev = byPair[key]
         { winner, conflicted } = collapseTwins(prev, f)    // merge supersede graph; preserve status:"superseded"
         remapId[f.id] = winner.id; remapId[prev.id] = winner.id
         byPair[key] = winner
         if conflicted:                                      // BOTH twins were edited to DIFFERENT text (resolves data-loss-M6)
            loser = winner === f ? prev : f
            twinSibs.push({ id: winner.id, kept: winner.text, alsoEdited: loser.text, onDevice: loser.hlc.device })
      else: byPair[key] = f
   for f in values(byPair):                                  // second pass: repoint supersededBy through the remap
      while f.supersededBy in remapId: f.supersededBy = remapId[f.supersededBy]   // chase chains to a fixed point
   return { records: values(byPair), twinSibs }
```

**Twin-collapse no longer silently drops an edited loser (resolves data-loss-M6).** Two devices can promote the same note and then *each edit its twin's text differently*; because the twins have different `id`s they never reach `mergeRecord` (which is keyed by `id`), so the earlier `collapseTwins` discarded the loser's text with no sibling. Now `collapseTwins` distinguishes a *clean supersede* (one twin's text is the ancestor of the other — collapse silently) from a *genuine divergence* (both edited to different text) and, in the divergent case, routes the loser through the **same review-sibling surface** as `mergeRecord` step 3. The supersede graph survives intact; a ruled-out claim is never resurrected; the `supersededBy` repoint chases chains to a fixed point (not a single hop).

### C.6 Schema versioning + the "stranded" status

1. **Migrate each side to the current version BEFORE merging** — run `persist.ts`'s migration chain on `base`, `local`, and `remote` entries. Never merge a v1 file against a v2 file field-by-field.
2. **Newer-than-supported remote = STRANDED, don't corrupt — and say so distinctly (resolves simplicity-10).** If a remote file's `schemaVersion` exceeds this device's max, we do NOT merge-and-downgrade (which would drop fields the older app can't represent and push the lossy version back, corrupting the newer device). Instead `schemaGate` throws `SchemaStranded`, mapped to a **dedicated status** `update-required` (distinct from `error`): *"This device can't sync until you update the app. Your edits are safe in local history (D1) and will sync once updated."* We confirm D1 still captures this device's local edits while stranded, so nothing is lost — only queued. `manifest.json` carries `appSchemaVersion`; a fast precheck gates the merge.
3. The `hlc`/`deletedAt`/`fileDeletedAt`/scalar-`*Hlc` fields are additive + optional, so an un-upgraded device reads new files fine (unknown fields preserved on round-trip) and seeds missing clocks from `createdAt` — no migration fn needed for those.

### C.7 Tombstone retention — NEVER auto-GC in v1 (resolves the flagship blocker, all three critiques)

The earlier "GC tombstones past a ~90d horizon" is **unsafe across devices** and is the single highest-risk item all three reviews flagged: a per-device wall-clock GC drops a tombstone A created; a device B offline (or a re-cloned machine) longer than the horizon still holds the live record; the union sees a live record with no opposing tombstone and **resurrects the delete permanently**, re-propagating it. There is no coordination that makes a 90d wall-clock horizon safe.

**v1 decision: never auto-GC tombstones.** They are tiny (an id + an HLC + a `deletedAt`/`fileDeletedAt` flag — tens of bytes each); a solo user across ≤3 devices will never accumulate enough to matter. The 90d horizon is **removed entirely.** GC becomes a Slice-4 problem that requires a **per-device watermark**: track `lastSyncedHlc` per known `deviceId` in `manifest.json`, and collect a tombstone only once `tombstone.hlc < min(lastSyncedHlc across every known device)` — i.e. positive evidence every device has observed the delete. Until that watermark machinery exists, tombstones are immortal. This keeps the convergence proof (§C.4), which holds **only while tombstones are retained**, actually true.

---

## D. The untagged "All" bucket decision — **default-OUT, separate opt-in**

The sharpest tension in the pillar:

- **Pull toward IN:** it is the **highest-value, least-recoverable** data — cross-project findings accreted over months, with *no* folder to re-derive it from. If a disk dies and untagged wasn't synced, it's gone. (Exactly why D1 keeps it always-in locally.)
- **Pull toward OUT:** it is the **most sensitive** — cross-project findings spanning everything the user works on, now leaving the device onto GitHub. A leak here exposes the broadest surface.

**RECOMMENDATION: default-OUT, gated behind its own dedicated toggle distinct from the per-workspace opt-ins, surfaced loudly.**

1. **Asymmetry of regret.** D1 *already* guarantees the untagged bucket a *local* backup (always in `.local-history/`). So default-OUT does **not** leave it with zero backup — it leaves it with a local backup but not yet a remote one. The user trades "survives a disk loss" for "doesn't leave the device by default." Given the sensitivity, that's the right default; the local net covers the catastrophic case until the user makes a deliberate choice.
2. **Consistency with the stack.** `ExportService` already makes untagged export **default-OFF** with a machine-wide warning (`UNTAGGED_WARNING`). The autoload-sync doc's DECISION 4 inverts the draft's opt-out to opt-in. Sync defaulting untagged-IN would be the one place the stack leaks cross-project data by default.
3. **A separate toggle, not folded into "sync everything."** Per-workspace opt-in is one gesture; untagged is a *second, explicit* gesture past a dedicated warning ("This bucket holds findings from ALL your projects. Syncing it copies cross-project knowledge to GitHub. Your local history already backs it up on this machine.") — mirroring `setUntaggedEnabled`'s deliberate-gesture pattern.

```ts
interface SyncConfig {
  enabled: boolean
  remoteRepo: string                // mirror of sync-credentials.json for the UI
  syncedWorkspaceIds: string[]      // per-workspace allow-list (opt-IN, default empty)
  untaggedOptIn: boolean            // SEPARATE, default false — the cross-project bucket
  // deviceId is DELIBERATELY ABSENT here — it lives in sync-credentials.json (§C.2)
}
```

The same `untaggedOptIn` flag gates the **auto-load push** of the untagged bucket, so a fresh chat on device 2 inherits untagged context only if the user opted untagged into sync. The mirror filter (not the merge) is the privacy boundary: untagged enters `.sync/` only with the toggle on.

### D.1 Un-sync means "stop pushing," NOT "delete on every device" (resolves simplicity-6)

Toggling a workspace OFF in `syncedWorkspaceIds` must **not** destroy that workspace's memory on device 2. Because un-sync is implemented as the mirror *skipping* the file (a bare disappearance), and §C.3a explicitly treats a bare disappearance as **not a deletion**, the last-synced copy simply stops receiving updates — it is retained on the remote and on other devices, just frozen. A true "remove from the cloud (deletes on all devices)" is a **separate, explicitly-confirmed** action that writes a `fileDeletedAt` tombstone; it is never the side effect of an un-sync toggle. The Settings copy distinguishes the two: *"Stop syncing (keeps the last cloud copy)"* vs *"Remove from cloud — deletes on all devices."*

### D.2 Untagged push gets a recurring preview, not first-only (resolves simplicity-9, partial)

The pre-push preview is the human exfil check. Gating it on the *first push only* means later ~45s auto-pushes carry new (partly agent-authored) findings unreviewed — an agent that writes a secret into a finding auto-exfiltrates on the next debounce. For the **per-workspace** buckets this residual is accepted for a solo single-user tool inside the private-repo + narrow-token envelope (stated honestly in §F). For the **untagged** bucket specifically — the broadest surface — the untagged toggle additionally arms a **per-session preview** of any *new* untagged findings before they are pushed (a quiet, batchable "N new cross-project findings will sync — review" affordance, not a modal gate), so the most sensitive bucket never auto-exfiltrates a whole session's accretion unreviewed.

---

## E. Multi-device lifecycle + triggers + the CAPP-101 nudge + offline degrade

### E.1 Triggers — reuse the EXISTING seams, zero new polling

All three triggers ride seams D1 + export already use. Sync is a *second listener* on the same change events.

| Trigger | Wiring | Behavior |
|---|---|---|
| **App launch** | After `localHistoryService.init()` + `exportService.regenerateAll()` in `setupIpc` boot, call `syncService.bootPull()` **async, non-blocking** — boot never awaits it. | `bootPull` = `sync()`'s **Phase-1 pull-apply always runs** (§C.4): fetch + 3-way merge base/local/remote + `applyMergeToLiveStore` **even on a fast-forward / empty-local first boot** (the B1 fix — the backup actually restores). On success, re-fire the CAPP-101 nudge per affected workspace (§E.3). Offline/no-token → no-op, status `local-only`. |
| **Debounced push** | ONE line inside the existing `workspaceMemoryService.onMemoryChanged` listener (beside `localHistoryService.scheduleSnapshot(...)`) + the session-store mutation branch: `syncService.schedulePush("memory/session change")`. | Coalesced debounce (default **~45s**, longer than D1's 15s so the local net commits first and a round-trip isn't fired per keystroke-burst). Phase-2 push. Failure → queue + degrade. Same `try/catch` as the neighbors. |
| **before-quit** | Alongside `localHistoryService.flush()` on `app.on("before-quit")`. | `syncService.flush()` — push the **already-committed clean** tree **time-budgeted** (hard ~4s git timeout). It does NOT start a fresh mirror under the gun (§B.2). If it can't finish, the edit is STILL safe in D1 + the committed local `.sync` commit; it pushes next launch. **Quit is never held hostage to the network.** |

### E.2 First-run on a SECOND device — "adopt this machine"

1. **Connect account** (§A) — token stored encrypted; resolve the configured private repo, **bind ownership** (`MANIFEST.ownerLogin === GET /user.login`, §A.2), or offer to create it on the genuine first device.
2. **Clone into the sync tree** — `git clone <remote> ~/.claude-tui/.sync/` (dedicated, path-separated). On a fresh machine the live stores are empty → a clean import.
3. **Import preview, THEN merge remote → local** — show the full pre-import preview (every finding that will enter the live store) and require explicit confirm (the adopt-injection gate, §A.2); then `mergeTree(emptyBase, emptyLocal, syncWorkingTree)` — with an empty local side every remote record is an *add*. Apply **through the services' own write paths** (not raw file copy) so caches warm + change-events fire — the SAME `setReloadHooks`/`onWorkspaceMemoryRestored`/`onSessionsRestored` hooks `localHistory.restore()` already uses. **Reuse them; do not invent a parallel reload path.**
4. **Path re-resolution (unspawnable-until-bound):** synced `workspaces.json` carries uuid+name, **never an absolute path**; synced sessions are stripped of `cwd`/`ccConversationId`. On device 2 a workspace is **inert until the user binds a local folder** (reuse the WS-H single-folder picker). Until bound: its memory is **readable** (shows in the Agent Rail KNOWS) but **no session in it can spawn** (no cwd). Settings shows an explicit "N workspaces need a folder on this device" row with a Bind button each — statically visible.
5. **The brain appears.** After merge + cache reload, fire the CAPP-101 nudge for every touched workspace (§E.3) so any open session re-primes; the next fresh spawn injects the imported brain with zero sync-specific code in the auto-load path.

**Atomicity:** the registry pull + the memory pull apply as a unit. A startup reconcile flags orphans (a session referencing a workspace uuid with no registry entry → "orphaned, bind or discard", never silently spawned). **Same-project / different-UUID** (user cloned but already had a local workspace for the folder): offer **"merge into the imported UUID"** rather than minting a parallel bucket — `__untagged__.json` is the one shared filename and merges by record id cleanly. *(deviceId is NOT cloned — it lives in the per-device `sync-credentials.json`, §C.2; even a user who hand-copies `~/.claude-tui` gets the collision-repair re-mint on first `bootPull`.)*

### E.3 Wiring the CAPP-101 propagation nudge after a pull

After a sync **pull** lands new/changed records for workspace W, running sessions whose owning workspace is W must get the "re-prime to pull" nudge — the *same* mechanism a local edit already triggers. The merge result enumerates touched record paths → touched workspace ids. Via a callback set on SyncService (mirroring D1's `setReloadHooks`), in the `ipc.ts` closure next to the existing `onMemoryChanged` body:

```
// SyncService.applyMergeToLiveStore writes merged through the reload hooks, then per touched workspace W:
for (const W of touchedWorkspaceIds) {
  recallService.invalidate()                       // the union must rebuild (new findings)
  workSessionService.markWorkspaceMemoryChanged(W) // ← THE NUDGE. scopes by workspaceId, NEVER getActiveId
  win.webContents.send("workspace:memory-changed", W) // refresh the open memory editor panel
}
```

Net effect: a finding authored on device A appears, after a pull on B, to every running session on B that owns its workspace — a quiet re-prime affordance, not a forced respawn (consistent with CAPP-101 Decision 5).

**Ordering subtlety (no push-echo loop):** the reload hooks fire `onMemoryChanged`, which schedules a push — but the records just written came FROM the remote, and because **all write paths emit `canonicalJson` (stable key order, §B.2/§C.4)**, the resulting mirror is byte-identical to what was pulled → the commit is **empty** (`git diff --cached --quiet` exits 0, the same skip-empty guard D1 uses) → no spurious push. The earlier draft's `git diff --cached --quiet` guard would have *failed* here if the live-store write normalized JSON differently than the remote blob (key order/whitespace), firing a churn loop (m11); pinning a single canonical serializer across every write path closes that.

### E.4 Offline / no-network / token-missing — degrade GRACEFULLY, never block

**Sync is ALWAYS optional; the app and every spawn run identically whether sync is connected, disconnected, or mid-failure.** A `SyncStatus` state machine drives a single quiet indicator (never a modal, never a gate):

| Status | Meaning | What still works |
|---|---|---|
| `disabled` | No account connected | Everything. D1 runs. Only a Settings "Connect" CTA. |
| `local-only` | Connected but offline / DNS fail / push refused / token expired | Everything. **Pending pushes queue.** Quiet "Sync paused — offline" hint. |
| `syncing` | Push/pull in flight | Everything (async/background). Subtle pulse. |
| `synced` | Last push+pull OK | Everything. "Synced · <relative time>". |
| `update-required` | Remote schema newer than this app (§C.6) | Everything. **Local edits safe in D1**, queued. "Update the app to resume sync." |
| `error` | Non-transient (auth rejected, repo gone) | Everything. "Sync error — <reason>" + Retry/Reconnect in Settings. |

**The offline queue is just git itself** — local commits to `.sync/` accumulate while offline; a successful connection pushes them in one go. No bespoke queue file, no replay log — **the commit DAG IS the queue.** SyncService tracks only a "push pending" boolean + the unpushed-commit count for the indicator.

**Hard rules:** a spawn NEVER awaits sync (`buildInjectedContext` reads local on-disk JSON, sync-agnostic by construction); a push failure is logged + status-flipped, never a blocking dialog; before-quit push is time-budgeted; token missing/expired mid-session → flip to `local-only`, keep queueing, surface "Reconnect" on next Settings open — the user is never interrupted.

---

## F. Security / threat model + mitigations

Single user, private repo. On-device this is **not a confidentiality boundary** (knowing a workspace uuid grants read+write — fine for one user). A **remote changes exactly one thing**: bytes leave the device onto GitHub. Three concrete risks:

### (a) Accidentally making the repo public
- **We create it private and verify.** Provision with `private:true`; on **`bootPull` and on a slow cadence** (NOT every 45s push — resolves security-M1's per-push round-trip cost), `GET /repos/{owner}/{repo}` and **refuse to push if `.private !== true`** (fail-closed; loud error). Stated honestly: a pre-push GET is a **defense-in-depth heuristic, not a guarantee** — a flip-to-public in the millisecond gap between GET and push still races; the real control is *GitHub never auto-publishes* (the user must flip it) plus the dedicated repo + the "rotate brain repo" escape.
- **A dedicated repo, never an existing project repo** (default `mission-control-brain`).
- **"Rotate brain repo" escape:** pushed history is permanent; the recovery for any leak is delete + re-init a fresh private repo (the local store is the source of truth → a fresh push fully reconstitutes it).

### (b) Leaked token
- **OS keychain, never plaintext** — `safeStorage.encryptString` (DPAPI on Windows), ciphertext in `sync-credentials.json`; never in `config.json`, never in the synced tree, never in a log. The single most important control.
- **Least-privilege** — fine-grained PAT scoped to **only the one brain repo**, Contents:RW only. A leaked token grants access to *only the already-backed-up brain*, nothing else in the account.
- **Token never on the argv, never in the tree** — injected per-invocation via a transient `GIT_ASKPASS` reading `SYNC_PAT` from the **child env** (§A.1), never `-c …extraHeader` on the command line (which is readable by same-user processes / EDR / crash dumps on Windows), never baked into `.sync/.git/config`. Env exposure is the residual risk and is acceptable on a single-user machine; we do not overstate it as zero.

### (c) Syncing something off-list
- **The allow-list IS the mitigation** — file-granular mirror-then-commit from an allow-list (§B) means a file not on `SYNC_ALLOWLIST` is never copied, staged, or pushed; a new `~/.claude-tui` artifact is invisible to sync until explicitly allow-listed (fail-closed). `eventLog` is dropped (§B.1). The **mandatory pre-push preview** (first push for per-workspace; per-session for untagged, §D.2) renders the exact file list + per-finding "what will leave the device" from the same allow-list. A round-trip test asserts the strip transform drops every machine-local field **and `eventLog`**.

### (d) Importing a hostile/foreign repo (adopt-time injection)
- Findings are *prose a fresh spawn reads*; a wrong/shared/hostile repo merged on adopt would inject agent-authored content into the user's brain. Mitigation: **owner-binding** (`MANIFEST.ownerLogin === GET /user.login`) + a **mandatory import preview before the first merge** (§A.2/§E.2). "Argv-safe" ≠ "content-safe"; the human sees every imported finding before it lands.

### Encryption-at-rest on the remote — **NO client-side encryption for v1**
A private repo is access-controlled by the keychain token. Client-side encryption would protect only the GitHub-itself / visibility-mistake case — but we (a) hard-stop a visibility flip before push and (b) keep the token narrow. The cost is real and falls on a solo user: a symmetric key that must itself be backed up (lose the key → the backup is unreadable — a **new, worse data-loss vector**), synced securely to device 2, and rotated. **Encryption also breaks the merge** (the record merge, the DAG causality, the base-aware 3-way diff, and the pre-push preview all need to read JSON) and loses "user owns + can read their own data." **Ship v1 unencrypted on a private repo;** the honest privacy knob is the untagged opt-in (§D) — the most sensitive data stays off the remote entirely until the user chooses, a stronger and simpler guarantee than encryption. Revisit field-level encryption of the untagged bucket *only* as a later slice and *only* with a robust key-sync story — never at the cost of making the backup unrecoverable.

---

## G. Phasing into buildable slices

Layered on the parent's Slice 2 (model hardening, additive, independently valuable) + Slice 3 (transport). **The deletion/identity/file-lifecycle fixes live in Slice 2 (merge semantics), not Slice 3 (plumbing)** — they are correctness, not transport. Each `S`-prefixed unit is a CAPP-able ticket.

**Slice 2 — model hardening (no transport, ships value on its own):**
- **S-merge-clock** — add `hlc` to `WorkspaceFinding` + `Note`; bump on **every** mutation path (`addFinding`, `editFinding`, `setPinned`, `setInstructions`/`setSummary`, `setStatus`, `rename`, `promoteFindings`, `deleteFinding`); a **dedicated HLC per merged scalar cell** (`instructionsHlc`, `summaryHlc`, `statusHlc`, `nameHlc`) — the ticket enumerates *every* merged scalar; seed missing clocks from `createdAt`/`promotedAt` on load (read-repair). `deviceId` minted once in **`sync-credentials.json`** (NOT config.json), with `deviceBoundTo` for collision repair.
- **S-merge-tombstone** — convert `deleteFinding` from `splice` to an HLC **record tombstone** (`deletedAt`); add **file-level tombstones** (`fileDeletedAt`) so a killed session / "remove from cloud" workspace stays deleted (§C.3a); filter both out of every *read* surface (`listWorkspaceMemory`, recall, inject, `getOverview`) so the brain looks identical; **NO auto-GC** (tombstones immortal in v1, §C.7).
- **S-merge-core** — `syncMerge.ts` (`mergeTree`/`mergeFile`/`mergeRecord`/`dedupePromotionPairs` + `hlcTick`/`hlcCmp`/`concurrentWithBase`/`canonicalJson`), **3-way (base/local/remote)**, fully hermetic. Fixtures: (a) delete-on-A + present-on-B stays deleted, across a simulated 200-day gap (no GC resurrection); (b) **file-deleted-on-A stays deleted on B**; (c) concurrent edit (both moved from base) → both surface as siblings, deterministic winner; (d) **skewed-clock device does NOT silently drop the other's concurrent edit** (structural detection); (e) same-origin-pair double-promote with *divergent* twin edits → collapses to one + surfaces the loser sibling, supersede graph intact; (f) `mergeTree(base,A,B) ≡ mergeTree(base,B,A)` byte-for-byte (canonicalJson); (g) un-sync (bare disappearance) does NOT delete on the other side.

**Slice 3 — transport:**
- **S3-auth-a** — `SyncCredentialStore` (`safeStorage` encrypt/decrypt, `sync-credentials.json`, `deviceId`, fingerprint, `isEncryptionAvailable` guard) + `validateToken` (`GET /user`). Hermetic (inject a fake encryptor + fake fetch).
- **S3-auth-b** — provisioning (`provisionRepo` via `POST /user/repos` with `auto_init:false` + WE push the seed root commit + post-create private re-check + adopt with **owner-binding** + paste-URL) + clone into `.sync/` with the hardened **askpass-env** git runner; **verify the fine-grained-PAT Basic scheme against GitHub docs** (acceptance gate, §A.1).
- **S3a — SyncService skeleton + status state machine + indicator** — `.sync/` init (D1's `HARDEN`+runner), the **file-granular symlink-refusing mirror with the `.mirror-ok` sentinel + temp-swap** (§B.2), launch/debounce/before-quit triggers on the EXISTING seams, offline-queue-is-git, `.synclock` file lock, `sync:status` emit, `SyncSettings.tsx` status row. **No auth yet — drives a local `file://` remote in tests** (keeps the e2e USERPROFILE-override invariant intact).
- **S3b — auth UX + scope + preview** — Connect/Create/Disconnect/Replace (all-visible controls); per-workspace allow-list + separate untagged toggle + **pre-push preview** (first-push for per-workspace, **per-session for untagged**, §D.2); the **"stop syncing" vs "remove from cloud" distinction** (§D.1); `stripSessionForSync` (pure, round-trip tested, **drops `eventLog`**); the verify-private gate (bootPull + slow cadence); the degrade-to-D1 banner; tokenless `sync_status` MCP tool.
- **S3c — adopt-this-machine + the full sync loop** — clone→**import preview**→merge import (owner-bound), path re-bind (WS-H reuse), atomic registry+memory pull, orphan reconcile, same-project merge offer, deviceId collision-repair on bootPull; wire the post-pull CAPP-101 nudge; **the Phase-1-pull-apply-always + apply-once-after-push loop with `commit-tree` (no `--amend`)** (§C.4); `applyMergeToLiveStore` reusing D1's reload seam + `export.ts` atomic write.
- **S3d — conflict siblings UX** — the "· (also edited on another device — review)" editor marker in `WorkspaceMemoryPanel` for both `mergeRecord` and twin-collapse siblings; device-flow auth (Mode 2); the "rotate brain repo" escape. *(Note: the sibling-surfacing **data path** ships in S-merge-core/S3c and is convergence-critical; only the **editor UX** is deferrable here — if S3d slips, the loser is still recoverable from the `.sync` DAG + D1.)*

**Slice 4 — later:** tombstone GC with a per-device watermark (§C.7); missions/config sync; the hosted backend (reuses `syncMerge.ts` verbatim); field-level untagged encryption *iff* a key-sync story.

**Hermetic test coverage checklist (file:// remote):** offline at launch → `local-only`, brain still loads from local JSON · token expired mid-session → `local-only` + queue + Reconnect, spawns unaffected · **first boot strictly-behind remote → pull-apply restores the brain into the live store (B1)** · before-quit over budget → quit proceeds, recoverable from D1 + committed local commit · pull applies → nudge fires + resulting commit empty (no echo loop, canonicalJson) · second-device clone into empty local → import preview → every record an add, unbound workspaces non-spawnable · concurrent divergent edit (both moved from base) → both kept + review marker, loser recoverable · **skewed clock does not silently drop a concurrent edit** · **killed session / removed-from-cloud workspace stays deleted; un-synced workspace is retained, not deleted** · **tombstone survives a >90d simulated gap (no resurrection)** · untagged default-OFF → never pushed until the separate toggle + preview · **`eventLog` absent from synced bytes** · `.sync/` path-isolated + symlink-refusing → no recursive delete ever touches a worktree or the primary repo · interrupted mirror (no `.mirror-ok`) → not committed/pushed · schema-newer remote → `update-required` status, local edits safe.

---

## H. Owner decision agenda

The calls only the owner can make. Each carries a recommendation. (Revised: H3/H4/H5 now reflect the resolved blockers; H8 is new.)

| # | Decision | Recommendation |
|---|---|---|
| **H1 — Auth mechanism + token transport** | PAT vs `gh` vs OAuth; where the token lives; how it's passed to git. | **Fine-grained PAT + Electron `safeStorage`**, ciphertext in `sync-credentials.json`. Inject per-call via a transient **`GIT_ASKPASS` + child env**, NEVER `-c extraHeader` on the argv. Reject device-flow for v1; `gh` opportunistic-only. **Verify the fine-grained-PAT Basic scheme against GitHub docs before shipping.** |
| **H2 — Provisioning** | We create vs paste-URL; `auto_init`. | **We create** the private repo via `POST /user/repos` with **`auto_init:false`** and push our own seed root commit; 422 → adopt-or-rename; **post-create re-check `private===true` or abort (never delete)**; adopt requires **owner-binding + import preview**. Paste-URL fallback, validated-private. |
| **H3 — Untagged bucket default + un-sync semantics** | default-IN vs default-OUT; what "un-sync" does. | **Default-OUT, separate explicit toggle, surfaced loudly**, with a **per-session preview** for untagged pushes. **Un-sync = "stop pushing, keep the cloud copy"**; deleting from the cloud is a distinct, confirmed action (a `fileDeletedAt` tombstone). D1's always-local-in covers the loss case. |
| **H4 — Clock model + concurrency detection** | LWW vs Lamport vs HLC; how concurrency is decided. | **HLC** `(wall,count,device)`, deviceId in `sync-credentials.json` (non-portable). **Concurrency is structural (3-way against the merge-base), NOT a wall-clock skew window** — both sides moved from base ⇒ conflict ⇒ surface a sibling. Stated honestly: HLC does not absorb skew for winner-selection; the sibling + a read-time skew clamp are the real backstops. **Every merged scalar cell (`status`/`name` included) gets its own HLC.** |
| **H5 — Conflict UX** | Silent LWW vs surface concurrent edits. | **Keep the winner live + surface the loser as a "review" sibling** for BOTH record-level merges AND promote-twin collapses; never silent-drop on a true concurrent edit. Loser always recoverable from D1 + the `.sync` DAG. |
| **H6 — Encryption at rest** | Client-side encrypt vs private-repo + token. | **No client-side encryption for v1.** Private repo + verify-private gate + keychain token + narrow scope is the envelope; encryption introduces a worse data-loss vector and breaks the (now base-aware) merge/preview. The untagged opt-in is the real privacy knob. |
| **H7 — Push cadence + bounds** | Debounce, retry ceiling, quit budget, GC. | **~45s network debounce, `MAX_ATTEMPTS=5`, single-flight + `.synclock`, ~4s before-quit budget.** **Tombstones NEVER auto-GC'd in v1** (per-device watermark GC deferred to Slice 4). Tune cadence after measuring real push latency. |
| **H8 — Live-store apply timing** | When does a merge reach the live store? | **Pull-apply is first-class and always runs (incl. fast-forward/first-boot — the backup must restore); the live-store write happens exactly once per converged result, after a successful push** (idempotent on contended retry). The merge commit is built with `commit-tree` (two parents), never `merge -s ours --amend`. |

---

**Key files (all absolute):**
- `C:\Users\ryguy\projects\claude-tui-app\electron\services\sync.ts` — NEW, `SyncService` (transport: `.sync/` allow-listed **file-granular** mirror + the pull-apply-always / apply-once-after-push loop + triggers + status machine), the remote sibling of `localHistory.ts`.
- `C:\Users\ryguy\projects\claude-tui-app\electron\services\syncMerge.ts` — NEW, the pure **3-way (base/local/remote)** merge core (`mergeTree`/`mergeFile`/`mergeRecord`/`dedupePromotionPairs`/`hlcTick`/`hlcCmp`/`concurrentWithBase`/`canonicalJson`); hermetic; reused by a future hosted backend.
- `C:\Users\ryguy\projects\claude-tui-app\electron\services\syncCredentials.ts` (a.k.a. `syncAuth.ts`) — NEW, `safeStorage` wrapper + `deviceId` mint/collision-repair + token validate + repo provisioning (over an injected `fetch`) + the `GIT_ASKPASS` token-injection helper.
- `C:\Users\ryguy\projects\claude-tui-app\electron\services\localHistory.ts` — reused patterns: `HARDEN` flags, the `spawnSync("git",…)` runner, `setReloadHooks`/`onWorkspaceMemoryRestored`/`onSessionsRestored`, `flush()`; the strict `.local-history/` vs `.sync/` path separation. **NOT reused: `mirrorSubset` (recursive `cpSync`/`rmSync`) — Sync uses its own file-granular, symlink-refusing mirror (§0/§B.2).**
- `C:\Users\ryguy\projects\claude-tui-app\electron\services\export.ts` — reused `writeIfChanged`/`renameWithRetry` atomic-write + Win-EPERM retry; the `UNTAGGED_WARNING` text + default-OFF pattern; the `whenSettled`/`beginRegen` settled-barrier (for the bootPull-before-first-spawn race).
- `C:\Users\ryguy\projects\claude-tui-app\electron\services\workspaceMemory.ts` — Slice-2 edits: `hlc`/`deletedAt`/`fileDeletedAt`/`instructionsHlc` on `WorkspaceFinding`/envelope, bump on every mutator, record + file tombstones, seed-on-load; `UNTAGGED_STEM`/sentinel; `persistAndEmit`/`onMemoryChanged` change seam.
- `C:\Users\ryguy\projects\claude-tui-app\electron\services\sessions.ts` — Slice-2 edits: `hlc` on `Note`, `summaryHlc`/`statusHlc`/`nameHlc` scalars bumped in their mutators, `fileDeletedAt` on kill; the `stripSessionForSync` whitelist transform (**drops `eventLog`**).
- `C:\Users\ryguy\projects\claude-tui-app\electron\persist.ts` — the schema-version precheck/migration gate (§C.6) wrapping base/local/remote before merge; the `update-required` stranded path.
- `C:\Users\ryguy\projects\claude-tui-app\electron\ipc.ts` — `onMemoryChanged` listener (where `syncService.schedulePush` joins `localHistoryService.scheduleSnapshot`), `markWorkspaceMemoryChanged` (the CAPP-101 nudge re-fired post-pull), the session-store mutation branch, the boot `regenerateAll` (where `bootPull` joins), the `whenSettled` spawn barrier.
- `C:\Users\ryguy\projects\claude-tui-app\src\components\SyncSettings.tsx` — NEW, main-window statically-visible Settings surface (status row incl. `update-required`; "stop syncing" vs "remove from cloud"; per-session untagged preview).
- `C:\Users\ryguy\projects\claude-tui-app\src\hooks\useSyncStatus.ts` — NEW, thin renderer view over `sync:status`.
- `C:\Users\ryguy\projects\claude-tui-app\docs\roadmap\context-autoload-sync-design.md` — §C parent (Slice 3, merge, privacy defaults, path re-resolution, Decisions 2/4/8/9).
- `C:\Users\ryguy\projects\claude-tui-app\docs\roadmap\claudemd-coexistence-design.md` — §D, the one-backup story.

---

## I. Critique-resolution map

Every blocker/major across the three reviews, and where it's resolved (or why deferred).

| Finding (critique) | Severity | Resolution |
|---|---|---|
| Pull-apply only in divergent branch → backup doesn't restore (data-loss-B1) | BLOCKER | §C.4 Phase-1 pull-apply ALWAYS runs (incl. fast-forward/first-boot); §E.1 bootPull. |
| Tombstone GC resurrects deletes (data-loss-B3, security-B1, simplicity-1) | BLOCKER | §C.7 **never auto-GC in v1**; 90d horizon removed; watermark GC → Slice 4. |
| `MAX_SKEW_MS` window mis-classifies concurrency → silent drop (data-loss-M4, security-B2, simplicity-4) | BLOCKER/MAJOR | §C.3c `concurrentWithBase` — **structural** 3-way detection, no wall window; §C.2 honest HLC limit + read-time skew clamp. |
| `applyMergeToLiveStore` before/inside push loop (security-B3, simplicity-8) | BLOCKER | §C.4 apply **once after successful push**; idempotent on retry. |
| Unclocked `status`/`name` scalars silently drop (data-loss-B2) | BLOCKER | §C.2 dedicated `statusHlc`/`nameHlc`; S-merge-clock enumerates every scalar. |
| File-level deletes resurrect whole session/workspace (simplicity-2) | BLOCKER | §C.3a `fileDeletedAt` file-level tombstones; present-but-tombstoned. |
| `collapseTwins` silent loss of divergent twin text (data-loss-M6) | MAJOR | §C.5 twin-collapse surfaces a review sibling on divergence. |
| `merge -s ours` + `--amend` corrupts DAG (data-loss-M9) | MAJOR | §C.4 deterministic `commit-tree` with two parents, no `--amend`. |
| Torn mirror committed/pushed (data-loss-M7, simplicity-3) | MAJOR | §B.2 temp-build + atomic swap + `.mirror-ok` sentinel; commit refuses without it. |
| Auth scheme wrong + argv leak (data-loss-M8, security-M2) | MAJOR | §A.1 token-as-password (verify-before-ship), `GIT_ASKPASS`+env, never argv. |
| `cpSync`/`rmSync` recursive vs file-granular contradiction (security-M4) | MAJOR | §0 + §B.2 own file-granular, symlink-refusing mirror; D1's `mirrorSubset` NOT reused. |
| `eventLog` exfil surface (security-M3) | MAJOR | §B.1 dropped from the whitelist; round-trip test asserts absence. |
| Adopt-repo injection (security-M5) | MAJOR | §A.2 owner-binding in MANIFEST + mandatory import preview before first merge. |
| `private` re-check TOCTOU + per-push cost (security-M1) | MAJOR | §F(a) honest "defense-in-depth, not a guarantee"; check on bootPull + slow cadence. |
| `updatedAt = maxWall` poisons ordering (data-loss-M5, security-m2) | MAJOR/MINOR | §C.3b `updatedAt` derived-on-read, never merged/pushed; display clamp. |
| `deviceId` in user-editable/portable `config.json` (data-loss-m10, security-m1, simplicity-5) | MAJOR/MINOR | §C.2 `deviceId` in `sync-credentials.json`; collision-repair re-mint on bootPull. |
| Un-sync deletes on device 2 (simplicity-6) | MAJOR | §D.1 un-sync = stop pushing, keep cloud copy; bare disappearance ≠ delete (§C.3a). |
| `auto_init` first-push merge churn (data-loss-m5, simplicity-7) | MINOR | §A.2 `auto_init:false`, we push the seed root commit. |
| Echo-churn from non-canonical JSON (data-loss-m11) | MINOR | §B.2/§C.4 `canonicalJson` single serializer across all write paths. |
| Schema-abort wedges device silently (simplicity-10) | MINOR | §C.6 distinct `update-required` status; edits safe in D1. |
| Multiple app instances race `.sync/` (data-loss-m3) | MINOR | §C.4 `.synclock` file lock; lock-fail → transient `local-only`. |
| First-push-only preview misses later findings (simplicity-9) | MINOR | §D.2 per-session preview for the untagged bucket; per-workspace residual accepted + stated. |
| `createdAt` cross-device seed skew (data-loss-m12) | MINOR | §C.2 noted: seeds only, never an ordering input — harmless. |
| Edit-after-delete revive boundary (data-loss-m13) | MINOR | §C.3c retained as intended product behavior; now bounded by never-GC (§C.7) so it can't compound with a GC'd tombstone. |
| Over-engineering check (data-loss-m14, security-m4) | — | Confirmed not a CRDT; S3d sibling **UX** is the only deferrable piece (data path is convergence-critical and ships in Slice 2/S3c). |
