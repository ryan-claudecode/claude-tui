# Internal Cleanup & Refactor — Design

**Date:** 2026-06-05
**Sub-project:** ① of the major pass (sequence: **Cleanup → UX → Forward**)
**Status:** Approved — ready for implementation plan

## Goal

Pay down correctness debt accumulated during the sessions-as-containers build (Plans 1–3b) and make the most dangerous class of bug — silent type errors in the un-type-checked electron main process — impossible to merge again. Scope is deliberately bounded to **correctness + safe (symbols-only) renaming**; no behavior changes, no UX restructuring, no wire-protocol changes.

## Context: the type-checking gap (the discovery that shaped this)

`package.json` has **no `tsc` step**. `build` is `electron-vite build`, which uses esbuild — esbuild *transpiles* TypeScript but never *type-checks* it. There is also no standalone `typecheck` script. The result: type errors accumulate silently on `main` and are only caught if someone runs `tsc` by hand.

Running `npx tsc -b` today surfaces **~13 pre-existing errors already on `main`**, the most serious being a use of an **undefined type name** that the bundler happily shipped:

```
electron/services/terminals.ts(273,39): error TS2304: Cannot find name 'Session'.
electron/services/terminals.ts(274,25): error TS7006: Parameter 'data' implicitly has an 'any' type.
electron/mcp/tools.ts            : 7× TS2554 (z.record arity) + 2× downstream URL-builder type errors
src/components/PanelDrawer.tsx(197,15): error TS2741: Property 'rows' missing in HeatmapProps
```

This is precisely the failure mode the symbols-only rename is meant to avoid — so making `tsc` a real, enforced gate becomes the **headline** of this cleanup, not an afterthought. The rename's safety depends on it.

## Scope — five workstreams

### A. Add a real typecheck gate
- Add `"typecheck": "tsc -b"` to `package.json` scripts.
- Wire it into `build` (and therefore `dev`) so a type error fails the build and can't silently rot again: `build` becomes `tsc -b && electron-vite build`.
- Exit criterion for the whole sub-project: **`npm run typecheck` exits 0**.

### B. Fix the ~13 existing type errors (correctness)
A typecheck gate that doesn't pass is worthless, so all current errors get fixed:
- **`tools.ts` — 7× `z.record(z.any())` → `z.record(z.string(), z.any())`** (Zod v4 requires an explicit key schema). This also resolves the 2 downstream `url.build` / `url.buildQuery` errors, because the inferred type becomes `Record<string, any>` and `any` is assignable to the stricter `UrlBuildInput` shape.
- **`terminals.ts:273` — `Session` → `Terminal`** (folds into workstream C) and the now-typed `pty.onData((data) => …)` callback loses its implicit-`any`.
- **`PanelDrawer.tsx:197` — `<HeatmapPanel {...(panel.props as any)} />`**, mirroring the existing `session-overview` case at line 201 (the established convention in this file).

### C. Symbols-only rename in `terminals.ts` (Approach A)
`TerminalService` still calls its PTY map `this.sessions` and its locals `session`, a holdover from when it *was* `SessionService`. Rename the **identifiers only**:
- `private sessions = new Map<string, Terminal>()` → `private terminals = …` (and its ~14 references).
- local `const session` / `for (const session of …)` → `terminal`, in the methods that operate on a single PTY.
- `attachPtyListeners(session: Session)` → `attachPtyListeners(terminal: Terminal)`.

**Explicitly NOT renamed:** the IPC channel *strings* (`"session:data"`, `"session:exit"`, `"session:create"`, …). Those are a wire protocol shared with `ipc.ts`, `preload.ts`, and the renderer; renaming them is a cross-cutting change deferred to sub-project ② (UX coherence). Leaving them is correct and safe here.

### D. Refresh stale `CLAUDE.md`
The **Key Files** table still describes the pre-split monolith:
> `electron/services/sessions.ts` | **SessionService** — all session ops (create, kill, rename, handoff, split, etc.)

Update it to reflect the two-tier model and add the missing row:
- `electron/services/terminals.ts` | **TerminalService** — runtime PTYs (create/kill/write/resize/rename), output capture, activity state, conversation-id capture.
- `electron/services/sessions.ts` | **SessionService** — durable work-session *container*: terminal membership, notes/summary/context primer, resume/idle-flush/overview.

(The architecture ASCII diagram and the "How to Add a Feature" example also say `sessions.ts` where they now mean `terminals.ts`; correct those references too.)

### E. The 3b-review bug-list (correctness, each TDD)
- **I1 — poller leak.** `TerminalService.captureConversationId` starts a `setInterval` whose handle is never stored, so it is never `clearInterval`'d on `kill`/`killAll`. Store the handle (per-terminal) and clear it when the terminal dies.
- **I2 — idle-flush can inject mid-task.** The idle-flush summary prompt fires after 1.5s of output quiet, but "quiet for 1.5s" ≠ "sitting at the prompt"; a mid-task pause can get a bracketed-paste injected into a half-typed state. Harden the trigger (longer quiet window and/or drop the trailing `\r` so nothing auto-submits) so a flush can only land when the terminal is genuinely idle at a prompt.
- **I3 — `summaryDirty` / `lastFlushAt` leak.** `SessionService.killSession` never deletes the terminal's entries from the `summaryDirty` Set and `lastFlushAt` Map. Clean them up on kill.
- **M1 — `parseActivityLine` over-matches.** The regex that extracts a terminal's current tool call from output also matches Claude's own prose bullets. Anchor it to a real tool-call line: `●` + a PascalCase tool name (e.g. `● Edit(...)`).
- **M4 — Overview "Reopen" uses a stale closure.** The Session Overview panel's Reopen action closes over a `sessions` snapshot captured at render; route it through a stable IPC `reopenTerminal` call instead so it always acts on current state.

## Out of scope (deferred)
- **M5** — live Overview refresh (a UX/liveness concern) → sub-project ② (UX).
- IPC channel-string rename → ② (UX coherence).
- The renderer-only `Session` type in `src/App.tsx` (correct as-is; unrelated to the terminals.ts undefined-`Session` bug).
- Any sidebar/visual restructuring.

## Testing strategy
- **TDD for E (I1/I2/I3/M1/M4):** each bug gets a failing unit test first (in `terminals.test.ts` or a sessions test), then the fix, then green. These pin the behavior so a future change can't silently regress it.
- **A/B/C/D are verified structurally:** the green-bar is `npm run typecheck` exiting 0 (proves A, B, and that the rename in C is internally consistent) plus the existing **73-test suite staying green** (proves no behavior changed). The rename is pure-identifier, so a passing typecheck + unchanged tests is sufficient proof.

## Exit criteria (machine-checkable — these gate the overnight run)
1. `npm run typecheck` exits 0.
2. `npm test` — all tests green (73 existing + the new I1/I2/I3/M1/M4 regression tests).
3. `npm run build` succeeds.
4. No IPC channel strings changed (grep `"session:` in `terminals.ts` unchanged in count).
