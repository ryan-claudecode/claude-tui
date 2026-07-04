# R3b — Native Memory Editor + README truth-up — SCOPE

> **Pick-up doc for a fresh session.** Self-contained: everything below is what you
> need to start R3b cold. Read this, then `docs/roadmap/retrenchment-plan-2026-07.md`
> (slice list) and `docs/roadmap/feature-audit-2026-07-04.md` (why) only if you want the
> full rationale. Ground truth for the read side is `electron/services/contextInspector.ts`.

## Where we are (context)

The retrenchment (R1/R2/R3a/R5) is **shipped** to `main` (@ `1bc2b88`). ~24k lines cut.
The parallel knowledge system (session notes → promotion → workspace memory → recall →
inject → export → adoption) is **gone**; durable knowledge now lives in Claude Code's
**native** files. The trust bug (transcript loss on session switch) is fixed (`e302aa8`)
and verified in the packaged app.

Two remaining work items sit under this doc: **R3b** (the payoff — a native-memory editor)
and a **README truth-up** (mechanical). R4 (scheduler keep/cut) is calendar-gated to
2026-07-18 and out of scope here.

## The one-line thesis for R3b

We deleted our rival memory store. R3b makes the trim a **net gain**: the app becomes the
**best GUI for Claude's *own* memory** — read it (Context Inspector, already shipped) *and
now edit it*. This is on-thesis: making native memory visible and curatable is real value;
owning a rival JSON store was not.

## What R3b builds

Repurpose the freed **WorkspaceMemoryPanel** slot into a **read/edit** surface for the
**native** files a workspace's agents actually read at launch. Editable target set (the
writable subset of the Context Inspector's tiers):

| File | Path | Inspector tier | Notes |
|---|---|---|---|
| Project memory | `F/CLAUDE.md` (or `F/.claude/CLAUDE.md`) | 4 | Committed to the user's repo. |
| Project-local override | `F/CLAUDE.local.md` | 6 | Gitignored, personal. |
| Auto-memory index | `<autoMemoryBase>/<encodeProjectDir(gitRoot)>/memory/MEMORY.md` | 7 | **GIT-ROOT-keyed**, not F-keyed. Claude maintains this; editing it by hand is curation. |

`F` = the workspace folder. `autoMemoryBase` = the `autoMemoryDirectory` setting override or
`~/.claude/projects`. **Reuse `ContextInspectorService`'s discovery for every path** — do NOT
re-derive the tier-7 key; the git-root-vs-F distinction is a correctness fix already made
there (`autoMemorySource` in `contextInspector.ts:504`). Getting it wrong writes to the
wrong file.

## Hard constraints (non-negotiable)

1. **These are user-controlled git files.** An accidental overwrite is worse than a missing
   feature. **Explicit-save only — never auto-write, never write on blur/switch/close.**
2. **Do NOT weaken `ContextInspectorService`'s INSPECT-ONLY invariant.** It is contractually
   read-only (see its header comment). The write path is a **separate** service/seam
   (`NativeMemoryService` or similar) — the inspector keeps `existsSync`/`readFileSync` only.
   Sharing *discovery* is fine; sharing a *write* method into the inspector is not.
3. **Save safety:** decide and implement one of — (a) show a diff of current-file-on-disk vs
   editor buffer before save, or (b) detect on-disk change since load (mtime/hash) and refuse
   a blind clobber. At minimum, never silently discard an external edit made while the panel
   was open.
4. **Follow the standard feature pattern** (CLAUDE.md "How to Add a New Feature"):
   Service → IPC (`worksession:*`/new namespace) → MCP (only if an agent should drive it —
   likely NOT; this is a human-curation surface) → preload (main + companion) → renderer.
   The panel renders through the shared `PanelContent` switch and must satisfy the `PanelApi`
   parity test (both `window.api` and `window.companionApi`).
5. **No hover-reveal affordances** — every action (Save, Revert, switch-file) is an explicitly
   visible control (standing UI rule).
6. **Coexist with the Context Inspector** in the same panel family. Inspector = read every
   launch tier (0–7, including non-editable ones). Editor = write the 3 editable ones. Decide
   whether they're one panel with a mode toggle or two sibling panels; the inspector must stay
   read-only either way.

## Open design questions (brainstorm these FIRST — don't code yet)

- **One panel or two?** Editor as a mode of the existing `context-inspector` panel, or a new
  `native-memory` panel type opened from its own affordance? (Inspector is opened from the
  WorkspaceSwitcher 📄 button — the editor could share that entry or get its own.)
- **File absence:** `CLAUDE.local.md` / `MEMORY.md` often don't exist yet. Offer "create"?
  Where — does creating `MEMORY.md` need the `<gitRoot>/memory/` dir made?
- **Save model:** in-place write vs diff-before-save vs mtime-guard (constraint 3).
- **Which workspace's files?** Identity-bound to the workspace like the inspector
  (`inspect_workspace_context` binds to the caller's OWNING session's workspace, not
  `getActiveId`) — mirror that.
- **Folderless / non-git workspaces:** tier 4/6 need `F`; tier 7 falls back to F-keying when
  no git root. Editor must degrade gracefully (show what's editable, disable the rest).

## Second item — README truth-up (do alongside, cheap)

`README.md` still advertises **cut** features (missions, findings/notes, chart/kanban/timeline
panels, the parallel knowledge system). The retrenchment slices scoped doc edits to
`CLAUDE.md` + `SERVER_INSTRUCTIONS` only, so the README now lies about the product. Rewrite it
to the post-cut thesis (feature-audit doc's last line):

> "The window where many Claude Code sessions live, survive restarts, render UI back at you,
> and tell you who needs you" — with Claude's own memory doing the remembering, and this app
> making it visible and editable.

The R3b editor is the natural thing to describe in the "memory" section of the new README, so
these two pair well.

## Process rule (still in force)

**No new feature without a named pull signal.** R3b's pull signal is on record: the owner's
whole thesis was "why aren't we just leveraging CLAUDE.md + native memory" — the editor is the
affirmative half of that. Don't let R3b's scope creep back toward a rival store.

## Definition of done

- [ ] Brainstorm resolves the open questions above (one panel vs two, save model, create-file).
- [ ] `NativeMemoryService` (read + explicit-save) with deps-injected fs for hermetic tests;
      reuses inspector discovery, does NOT touch the inspector's read-only path.
- [ ] Editor panel wired Service → IPC → preload (main + companion) → `PanelContent`; parity
      test green.
- [ ] Save safety implemented (diff-before-save or mtime-guard); no auto-write anywhere.
- [ ] Unit tests (save writes the right path incl. the git-root-keyed tier 7; refuses blind
      clobber; create-file path). e2e smoke that the panel renders.
- [ ] Gate green: `npm test` + `npm run build` + `npm run e2e`.
- [ ] CLAUDE.md updated (the WorkspaceMemoryPanel row is a tombstone right now — replace with
      the editor's real description). README truth-up landed.
- [ ] Repackage after merge.

## Refs

- Read side / discovery: `electron/services/contextInspector.ts` (tiers, `autoMemorySource`).
- Coexistence design: `docs/roadmap/claudemd-coexistence-design.md` §A.
- Slice list: `docs/roadmap/retrenchment-plan-2026-07.md` (R3b row).
- Why: `docs/roadmap/feature-audit-2026-07-04.md`.
- Panel-add pattern + feature pattern: `CLAUDE.md` ("How to add a new panel type" / "How to
  Add a New Feature").
