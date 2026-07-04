# Retrenchment Plan — 2026-07 (ratified 2026-07-04)

> Execution plan for the owner-ratified feature audit (`feature-audit-2026-07-04.md`).
> Rationale lives there; this doc is dispositions + slice sequencing. Every slice keeps
> `npm test` + `npm run build` + `npm run e2e` green, lands as one reviewable commit, and
> trims the corresponding CLAUDE.md + `SERVER_INSTRUCTIONS` sections in the same commit
> (docs describing dead features are noise for every future agent).

## Dispositions

| Feature | Disposition |
|---|---|
| Terminals / sessions container / restore / handoff / workspaces / STT / attention / context meter / structured chat / panels+forms / ask_user | **Keep** — the product |
| Session notes, summaries, promotion, recall, pinning, launch-delta, context inject primer, idle-flush | **Cut** (R3a) — knowledge tier pivots to native |
| Workspace memory JSON store + export + adoption | **Cut** (R3a); panel repurposed (R3b) |
| Context Inspector | **Keep** — already the right (READ-only) relationship to native files |
| WorkspaceMemoryPanel | **Repurpose** (R3b) → editor for native CLAUDE.md / CLAUDE.local.md / auto-memory MEMORY.md |
| Local history | **Retire** (R3a) — its cargo was the app-owned brain; native memory lives in user-git-controlled files |
| Missions + worktree review + supervisor | **Park** (R2) — delete from tree; revival ref = the pre-R2 commit; on-disk mission format documented in git history |
| Action buttons, saved layouts, session templates, broadcast, session timeline | **Cut** (R1) — zero use ever |
| Scheduler | **Trial until 2026-07-18** (R4) — pull signal = any `~/.claude-tui/schedules/*.json` on disk; none by then → cut |
| Agent Rail | **Slim** (R5) — keep NOW+COST; KNOWS dies with recall (R3a) |
| Panel types | **Prune** (R5) — keep diff, markdown, image, table, form, code, git, session-overview (slimmed), schedule (while trialing); cut heatmap, kanban, stat, log, progress, timeline, tree, chart, test, notes unless a pull signal is on record |
| CAPP-57 permissions | **Unchanged** — release blocker, owner-led |

## Slices (sequenced)

- **R1 — dead-weight cut (mechanical, no cross-deps):** delete ActionButtonService, LayoutService, TemplateService, BroadcastService, session-timeline tool; their IPC handlers, preload accessors, MCP tools, sidebar/rail UI, tests; trim SERVER_INSTRUCTIONS + CLAUDE.md.
- **R2 — park missions:** delete MissionService, WorktreeService review flow, supervisor tick in ipc.ts, mission MCP tools, MISSIONS sidebar section, mission/worktree-review panels, MissionPrompt; attention review-entry seam reverts.
- **R3a — knowledge-tier cut:** delete session_note/summary/promote/recall/pin/get_session_context MCP tools + service internals (notes, provisionalFindings, summaryDirty, idle-flush, launch stamps/delta), contextInject, workspaceMemory store, export, adoption, localHistory, KillSessionModal promote path (simple confirm kill remains), SessionOverview knowledge sections (terminals+activity view remains). Session container (terminal grouping, event log, resume) is explicitly kept.
- **R3b — native memory editor:** WorkspaceMemoryPanel becomes a read/edit surface for the workspace folder's CLAUDE.md, CLAUDE.local.md, and the git-root-keyed auto-memory MEMORY.md (reuse ContextInspectorService's file discovery). Explicit-save only, never auto-write.
- **R4 — scheduler decision (2026-07-18):** by pull signal on disk.
- **R5 — surface polish:** panel-type prune, rail slim, command-palette entries for cut features removed.

Process rule going forward (ratified): **no new feature without a named pull signal** — the
concrete moment the owner reached for it and it wasn't there.

## Notes

- Each slice: worktree executor → gate → owner-side personal diff review → cherry-pick to
  main → push. One slice in flight at a time.
- The unit-test count will drop substantially (dead features carry big suites); that is the
  point, not a regression — the gate criterion is green, not count.
- `~/.claude-tui` on-disk data for cut features is left in place (harmless orphans), never
  deleted by the app.
