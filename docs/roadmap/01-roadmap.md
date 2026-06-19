# ClaudeTUI — Roadmap

> Read [00-identity.md](./00-identity.md) first. Phases are dependency lanes, not a calendar.
> Phase 0 and Phase 1 have fully detailed work items (one file each under `phase-0/`,
> `phase-1/`). Phases 2–3 are epic sketches, expanded just-in-time when Phase 1 lands —
> their detail would go stale otherwise, because Phase 1 rewrites the map (file splits,
> tool deletions).

## Execution model

- Work items are handed to executor agents (Opus), one item per agent.
- Items marked **Worktree: yes** must run in an isolated git worktree; agents commit only
  the files listed in their item. (Concurrent agents in one tree have collided before —
  `git add -A` is forbidden in work-item execution.)
- The architect (Fable session) reviews each diff against the item's acceptance criteria
  before merge, and re-plans the next batch as results land.
- Every item: build (`npm run build`) and tests (`npm test`) must pass before handoff.

---

## Phase 0 — Trust & hygiene ✅ COMPLETE (2026-06-10)

**Goal:** the app can't silently fail, can't be impersonated, and can't eat its own data.

| ID | Item | Status |
|----|------|--------|
| [P0-1](./phase-0/P0-1-mcp-identity-tokens.md) | Token-authenticated MCP identity | ✅ `5f5378f` |
| [P0-2](./phase-0/P0-2-mcp-server-startup-errors.md) | MCP server startup error handling | ✅ `b8cf7ef` |
| [P0-3](./phase-0/P0-3-enable-sandbox.md) | Chromium sandbox on both windows | ✅ `4f0b769` (renders verified visually) |
| [P0-4](./phase-0/P0-4-schema-versioning.md) | Schema versioning + migration | ✅ `5248be1` (read-repair verified on real `~/.claude-tui`) |
| [P0-5](./phase-0/P0-5-renderer-error-toasts.md) | Renderer async failures → toasts | ✅ `312bea7` |
| [P0-6](./phase-0/P0-6-crash-visibility-logging.md) | Crash-visibility logging | ✅ `525f8ef` |
| [P0-7](./phase-0/P0-7-companion-readiness-fix.md) | Companion readiness fix + tests | ✅ `78870d8` |

Exit verified: 127 tests green, app boots + restores sessions + resumes conversations
under sandbox (visual capture). Outstanding interactive checks (panel-on-first-open, form
submit, error toast) ride along with normal usage.

**Integration lessons (encoded into Phase 1 dispatch):** agent worktrees may start from a
stale base — every executor must fast-forward/rebase onto `main` BEFORE reading code;
integrate via per-item cherry-pick onto main; tree-scoped process-kill verification after
any app boot check.

---

## Phase 1 — Identity consolidation ✅ COMPLETE (2026-06-10, all 6 items)

**Goal:** every spawned session is cheaper and sharper; the codebase is navigable; the
resume story stops needing weekly fixes. This phase is mostly *subtraction*.

| ID | Item | Depends on | Status |
|----|------|-----------|--------|
| [P1-1](./phase-1/P1-1-cut-mcp-tool-surface.md) | Cut MCP tool surface to the on-thesis core | — | ✅ `a01cec0` — 150→75 tools, 18 services deleted, −4,199 lines |
| [P1-2](./phase-1/P1-2-split-tools-modules.md) | Split slimmed `tools.ts` into `electron/mcp/tools/` domain modules | P1-1 | ✅ `27e4f56` — 7 modules + shared, 75 tools verbatim |
| [P1-3](./phase-1/P1-3-split-ipc-modules.md) | Split `electron/ipc.ts` into per-domain handler modules | P1-1 | ✅ `b9579b4` — channel set byte-identical, ipc.ts 134 lines |
| [P1-6](./phase-1/P1-6-no-real-pty-in-tests.md) | Tests must not spawn real PTYs/Claude processes (hygiene, found at exit check) | P1-5 | ✅ `7ad09f9` — injectable spawnPty seam + FakePty; suite proven hermetic (138 tests, zero real spawns) |
| [P1-4](./phase-1/P1-4-decompose-app-tsx.md) | Decompose `src/App.tsx` into hooks | — | ✅ `680adea` — 778→437 lines, 5 hooks |
| [P1-5](./phase-1/P1-5-shared-transcript-watcher.md) | Central transcript assigner replaces per-terminal polling | — | ✅ `7a5c036` — race class eliminated, no give-up window |

**Exit criteria — verified 2026-06-10:** tool surface 150→75 (50% ≥ the 45% target);
largest source file is `terminals.ts` at 601 lines (target ~600 — accepted), all former
god-files split (tools.ts 76, ipc.ts 134, App.tsx 437); parallel same-cwd
conversation-resume covered by P1-5 assigner tests. 134 tests green; integrated boot
check clean. Trailing: P1-6 test-hermeticity fix in flight.

---

## Phase 2 — Differentiation ✅ COMPLETE (all 5 features, 2026-06-11 → 06-13)

**Goal:** the app demos as "mission control," not "terminal tabs."

- **Attention queue / agent inbox** — ✅ SHIPPED (`efe7df7`/`3b8ce9c`/`0d0cbc5`). "NEEDS
  YOU" sidebar section, tiered detection, tier-1 toast + OS notifications, Ctrl+J, MCP tools.
- **Missions as a first-class surface** — ✅ SHIPPED (`da96013`/`eb7bfa6`/`a8e770a`). Live
  MISSIONS sidebar section (3s poll removed), status chips + progress, attention integration.
- **Worktree-isolated workers + diff-review merge** — ✅ SHIPPED (`201bb5f` WW-1 service,
  `1770af4` WW-2a backend, `c89a977` WW-2b review UX). Spec:
  [worktree-workers-design.md](./phase-2/worktree-workers-design.md). Opt-in per-task git
  worktrees, review gate, approve/merge (conflict→display, never auto-resolve)/reject.
- **Session timeline** — ✅ SHIPPED (`1c94ca0` ST-1). Durable session eventLog +
  `session_timeline` panel + sidebar ⌚ button. Spec:
  [ST-1-session-timeline.md](./phase-2/ST-1-session-timeline.md).
- **Panel presence in the main window** — ✅ SHIPPED (`01e09d3` PP). Main-window presence
  indicator (count + pulse + raise-companion) + props-based panel live-refresh fix. Spec:
  [PP-panel-presence.md](./phase-2/PP-panel-presence.md). **Panel persistence across
  restarts DEFERRED** — design surface (which panels survive, stale-data policy) wants user input.

All Phase-2 features pass the hermetic suite; interactive smoke pending user verification.

## Phase 3 — Shippable 1.0 🟢 MOSTLY COMPLETE (2026-06-13 autonomous run)

**Goal:** a stranger can install it, understand it in five minutes, and trust it overnight.

- **Accessibility pass** — ✅ `932605d` (A11Y). Focus trap on all overlays, dialog
  semantics, aria-labels, `prefers-reduced-motion`, `:focus-visible` rings.
- **macOS Cmd-key mapping** — ✅ `7805ba0` (MAC). `cmdOrCtrl` helper, win32 byte-identical.
  (Built blind — needs a real mac to verify; macOS packaging/signing still pending.)
- **electron-builder packaging** — ✅ `592d4c7` (PKG). Validated unsigned Windows build
  (`dist/win-unpacked/ClaudeTUI.exe`, node-pty unpacked). Spec:
  [phase-3/PKG-electron-builder.md](./phase-3/PKG-electron-builder.md).
- **E2E smoke suite** — ✅ `896a26b` (E2E). Hermetic Playwright-Electron smoke (`npm run
  e2e`), USERPROFILE-temp isolation, separate from the unit suite.
- **Auto-update** — ✅ `9bb6acd` (UPD) scaffold, `app.isPackaged`-gated no-op until configured.
- **README** — ✅ `2fa1521` (DOCS). User-facing identity/features/install/shortcuts.

**Deferred (need user input/credentials, documented in
[autonomous-2026-06-13.md](./autonomous-2026-06-13.md)):** README screenshots, in-app
first-run onboarding, panel-state persistence, code-signing cert, macOS packaging +
notarization, auto-update publish target.
