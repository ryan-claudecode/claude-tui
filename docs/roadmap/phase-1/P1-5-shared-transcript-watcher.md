# P1-5 — Replace per-terminal transcript polling with a central assigner

- **Phase:** 1 · **Depends on:** none · **Worktree:** yes · **Size:** M–L (~1 day)
- **Why:** Conversation-ID capture (the heart of the continuity pillar) currently runs one
  30-second poller per spawned terminal, each independently scanning the Claude transcript
  dir and racing siblings for new `.jsonl` files. This design has driven repeated fix
  commits (`0c11506`, `8aab7b7`, `e3be7ea`) and still has a claim race between poll ticks
  plus a hard 30s give-up that loses resume on slow boots. One central assigner removes
  the race *class* ([identity doc](../00-identity.md): continuity is the moat).

## Current state (verified 2026-06-10, post-Phase-0)

In `electron/services/terminals.ts`:
- `resolveTranscriptId(projectsRoot, cwd, spawnedAt, excludeIds, claimed)` — pure helper
  that picks the newest transcript not excluded/claimed (top of file, well-tested).
- `claimedConvoIds: Set<string>` — process-wide claimed set.
- `convoTimers: Map` — one `setInterval` per terminal polling for ~30s after spawn
  (search for `convoTimers` and the snapshot taken via `listTranscriptIds()` at spawn).
- On success it emits a `convo` event consumed by `SessionService.setConversationId`.
- Tests for this live in `electron/services/terminals.test.ts` with an injectable
  `projectsRoot` (fake dirs in temp).

## Design (decided — implement as written)

New module `electron/services/transcripts.ts`: a `TranscriptAssigner` owned by
`TerminalService` (one instance per process).

- **Registration:** when a terminal spawns, `assigner.expect({ terminalId, cwd, spawnedAt })`.
  When a terminal dies or captures an id, `assigner.cancel(terminalId)`.
- **One poll loop per encoded project dir** (not per terminal): a single 1s `setInterval`
  scans each project dir that has ≥1 pending expectation. Use polling, not `fs.watch`
  (matches the existing injectable-fs test style and avoids Windows watcher flakiness).
- **Assignment rule:** when a NEW `.jsonl` appears (not in the dir's baseline snapshot —
  taken when the dir's first expectation registers — and not already claimed), assign it
  to the **oldest pending expectation** for that cwd whose `spawnedAt` ≤ the file's mtime
  (+small skew tolerance). One file → one terminal, atomically, in one place: no
  cross-terminal race is possible by construction.
- **No 30s give-up.** An expectation lives until its terminal exits or captures an id.
  (The old timeout existed to stop N leaked intervals; with one shared loop that idles
  when no expectations are pending, there's nothing to leak.)
- Emit the same `convo` event the old path emitted; keep `claimedConvoIds` semantics
  (carry the set into the assigner; `--resume` reopens must still pre-claim their id —
  find where `claimedConvoIds.add` happens for resumed terminals and preserve it).
- Delete the per-terminal `convoTimers` machinery once the assigner is wired in.

## Non-goals

- Do NOT change how `--resume` args are built (`resumeArgs`), the `SessionService` side,
  or the on-disk session schema.
- Do NOT switch to `fs.watch`.
- Do NOT touch the identity-token code (P0-1) beyond mechanical adjacency.

## Acceptance criteria

- New tests in `electron/services/transcripts.test.ts` (+ adjust `terminals.test.ts`):
  1. Two terminals spawned in the same cwd, two new transcripts appearing in order →
     each terminal gets a distinct id matching spawn order.
  2. A transcript appearing 45s after spawn is still assigned (no give-up).
  3. A transcript already in the baseline snapshot or in `claimedConvoIds` is never
     assigned.
  4. Cancelling an expectation (terminal killed) stops assignment; the loop goes idle
     (no timers) when no expectations remain.
- `npm run build` and `npm test` pass; existing convo-related tests updated, not deleted —
  equivalent coverage must remain.
- Commit only the files below, staged by explicit path.

## Files

- Create: `electron/services/transcripts.ts`, `electron/services/transcripts.test.ts`
- Modify: `electron/services/terminals.ts`, `electron/services/terminals.test.ts`
