# P0-4 — Schema versioning + migration for ~/.claude-tui persistence

- **Phase:** 0 · **Depends on:** none · **Worktree:** yes · **Size:** M (~1 day)
- **Why:** Every file under `~/.claude-tui/` is raw unversioned JSON. The first time a
  format changes, user sessions/missions silently fail to load or load corrupted — for an
  app whose thesis is *durable work*, eating the user's data on upgrade is
  identity-destroying ([identity doc](../00-identity.md)). Versioning must land while the
  install base is one person.

## Current state (verified 2026-06-10)

Producers/consumers of `~/.claude-tui` (all raw `JSON.parse(readFileSync(...))`, no version
field anywhere):

| File | Code | Notes |
|------|------|-------|
| `config.json` | `electron/config.ts:37-38, 50-87` | read in 3 places; silent catch → defaults |
| `sessions/<id>.json` | `electron/services/sessions.ts:87` (dir), `:311-320` (load), `:493-500` (persist, atomic tmp+rename) | one file per work session |
| `missions/<id>.json` | `electron/services/mission.ts:87` (dir), `:98-106` (load, skips corrupt), `:113-118` (persist, atomic) | one file per mission |
| `layouts.json` | `electron/services/layouts.ts:12` | collection file |
| `snippets.json` | `electron/services/snippets.ts:12` | collection file |
| `notes.json` | `electron/services/notes.ts:16` | collection file |
| `tasks.json` | `electron/services/taskqueue.ts:18` | collection file |

## Design (decided — implement as written)

1. New module `electron/persist.ts`:
   ```typescript
   export interface Versioned<T> { schemaVersion: number; data: T }
   export type Migration = (data: any) => any  // migrates version N-1 -> N

   // Read a versioned JSON file. A file WITHOUT a schemaVersion envelope is
   // treated as version 0 (the pre-versioning format) and run through all
   // migrations starting at index 0. Returns undefined if missing/unreadable
   // (caller decides the default), but logs a warning on parse failure instead
   // of swallowing it.
   export function loadVersioned<T>(path: string, currentVersion: number, migrations: Migration[]): T | undefined

   // Atomic write (tmp + renameSync, same pattern as sessions.ts:493-500),
   // wrapping content as { schemaVersion: currentVersion, data }.
   export function saveVersioned<T>(path: string, currentVersion: number, data: T): void
   ```
   Migration array semantics: `migrations[n]` upgrades version `n` → `n+1`. Loading a file
   at version `v` runs `migrations[v..currentVersion-1]` in order, then the result is
   immediately re-saved in the new format (read-repair).
2. Set `currentVersion = 1` for every store. The only "migration" shipped now is
   version 0 → 1: wrap the legacy raw shape into the envelope unchanged (identity
   migration). This proves the machinery end-to-end against real existing files.
3. Convert each store to use the helper:
   - `sessions.ts` `load()`/`persist()`
   - `mission.ts` `load()`/`persistMission()`
   - `config.ts` `loadConfig()`/`setThemeMode()` (and `getThemeMode()` — route through one
     shared loader instead of three independent `readFileSync` paths)
   - `layouts.ts`, `snippets.ts`, `notes.ts`, `taskqueue.ts`
4. On unreadable/corrupt files: keep current behavior (skip / fall back to defaults) but
   the helper logs a `console.warn` with path + error — never a silent catch.

## Non-goals

- No actual schema changes — version 1 contains today's shapes verbatim.
- Do NOT migrate the mcp-config files in `{tmpdir}/claudetui` (ephemeral, regenerated).
- No backup/rollback machinery; atomic write + read-repair is enough at this stage.

## Acceptance criteria

- Unit tests for `persist.ts` (new file `electron/persist.test.ts`):
  - load of a legacy (envelope-less) file returns the data and rewrites it as v1 on disk;
  - load of a v1 file round-trips;
  - a registered migration `0→1` that renames a field is applied to a legacy file;
  - corrupt JSON → `undefined` + warning, file left untouched.
- Existing tests in `sessions.test.ts` / `mission.test.ts` updated to the envelope format
  and passing — plus one new test each proving a LEGACY-format session/mission file still
  loads (backward compat with users' current on-disk data is the whole point).
- Manual: run the app against a real pre-existing `~/.claude-tui` dir; sessions and
  missions appear; files on disk are rewritten with `schemaVersion: 1`.
- `npm run build` and `npm test` pass.

## Files

- Create: `electron/persist.ts`, `electron/persist.test.ts`
- Modify: `electron/config.ts`, `electron/services/sessions.ts`, `electron/services/mission.ts`,
  `electron/services/layouts.ts`, `electron/services/snippets.ts`, `electron/services/notes.ts`,
  `electron/services/taskqueue.ts`
- Test: `electron/services/sessions.test.ts`, `electron/services/mission.test.ts`
