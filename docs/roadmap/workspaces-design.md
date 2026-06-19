# Workspaces — Design & Plan (CAPP-2 / 17 / 18)

*Design-first kickoff (2026-06-18 overnight, via a 4-agent design workflow). Recommendation + the decisions that need YOU before any code is dispatched. (Reconstructed 2026-06-19 after an incident wiped the untracked original — now committed.)*

## Current state (re-audit, confirmed)

A boot-only **launcher**, not a container. `discovery.ts` globs `workspaceScanPaths` for `workspace.json` manifests; `WorkspaceService.activate(index)` is fire-and-forget — it spawns editors + **bare `TerminalService` PTYs that are orphaned** (never registered into a `WorkSession` container, so they get no `workspaceId`, summary, notes, or context primer). `WorkSession.workspaceId` is a **dead seam** (declared at sessions.ts:87, never written or read). Missions have **no workspace field at all**. There is **no active-workspace concept** anywhere. Net: three disconnected data islands — `Workspace` (in-memory, never persisted), `WorkSession` (persisted, dead seam), `Mission` (persisted, no link) — and the activate path operates on a *different object type* (PTYs) than the durable container (`WorkSession`) the rest of the app is built on. That structural disconnect is the root of every gap.

## Recommendation

**Define a workspace as a user-named, persisted GROUPING of one-or-more directories (manifest-optional), identified by a stable id.** (Subsumes "a single dir," "a `workspace.json`" → imported as one entry, and "a git root" → offered as a creation default.) The **registry becomes the source of truth**; discovery is demoted to a seed/import path. Add **one piece of new global state — `activeWorkspaceId`** (versioned config, additive, no schema bump). **Scope sessions + missions** by stamping `workspaceId` at creation (default = active workspace); untagged legacy records fall under an **"All"** bucket (no destructive migration). The sidebar filters its NEEDS YOU / MISSIONS / SESSIONS sections to the active workspace, with "All" as the escape hatch — this is what makes CAPP-18 ("missions and sessions are per-workspace") true.

**Strategic framing (resolves the moat-vs-launcher tension):** a workspace is **enabling SUBSTRATE, not a 4th pillar.** Architecturally, elevate it — it becomes the durable *container above sessions + missions*. Strategically, it *serves* continuity + orchestration (the spatial frame that makes the multi-agent world legible), so build it to a **usable bar**, keep it the minority of effort, and resist gold-plating it into an IDE/project-manager (kill-list). It is **not** a launcher (it's a real durable container) and **not** a pillar (it serves the pillars).

## Decisions that need YOU (these gate the build)

1. **Ratify the container/substrate model** (option 1d above) — vs keeping it a launcher, or defining a workspace as just-a-dir / just-the-manifest / just-a-git-root. → *Rec: yes — container/substrate.*
2. **Workspace id scheme** — explicit registry uuid vs a dir-derived id. → *Rec: explicit uuid in the registry (a dir-derived id breaks if dirs are added/moved); discovery maps a manifest → a registry entry.*
3. **Registry storage** — a new `workspaces` key in versioned config vs a `~/.claude-tui/workspaces.json` file. → *Rec: a `~/.claude-tui/workspaces.json` registry mirroring the missions store — keeps config lean and matches the established durable-store pattern.*

## Plan (dispatch on your approval, in order)

| WS | Scope | Effort | Gated? |
|----|-------|--------|--------|
| **A** | Workspace model + persisted registry (WorkspaceService discoverer → registry: list/create/rename/addDir/removeDir/delete/setActive/getActive; discovery = seed/import; stable ids retire index-addressing) | M | yes |
| **B** | Active-workspace state + selection persistence (`setActive`/`getActive`, `workspace:active-changed`; id-based IPC/MCP; SEPARATE "make active" from the old "boot/launch" spawn) | S | yes (A) |
| **C** | Scope sessions + missions (thread `workspaceId` through `WorkSession.create`/`openSession` + add to `Mission`/`mission.create`, default=active; "All" bucket; filtered views) | M | yes (A,B) |
| **D** | Selection + creation UX (sidebar workspace switcher; create = name + pick dirs, default to current git-root/cwd + import-`workspace.json`; rename/recolor/delete; warm/non-blocky) | M | yes (B,C) |
| **E** | MCP surface + instructions (id-based + create/select/scope tools defaulting to the caller's bound `workspaceId`; update `SERVER_INSTRUCTIONS`) | S | yes (A,B) |
| **F** | Re-scan / live discovery (make discovery a refresh action, not boot-only) | S | **no — independent** |

**On your ratification of decisions 1–3, I dispatch WS-A first**, then B→C→D/E, with F whenever.
