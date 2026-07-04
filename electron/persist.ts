import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs"
import { dirname } from "node:path"
import { logWarn } from "./log"

/**
 * Versioned on-disk persistence for everything under ~/.claude-tui.
 *
 * Every file is wrapped in an envelope `{ schemaVersion, data }`. A file WITHOUT
 * that envelope is the pre-versioning ("version 0") format produced by older
 * builds — it is read as-is and run through the migration chain so users never
 * lose their sessions/config on upgrade. Loading a versioned file
 * always rewrites it in the latest format (read-repair), so a file is upgraded
 * exactly once and is in the new format ever after.
 *
 * Failures are never swallowed silently: a corrupt/unreadable file logs a
 * warning (via log.ts, which mirrors to the console) and returns `undefined` so
 * the caller can fall back to its own default. The file on disk is left untouched.
 */

/** The on-disk envelope wrapping the actual store payload. */
export interface Versioned<T> {
  schemaVersion: number
  data: T
}

/** Upgrades a payload from version N-1 to version N. `migrations[n]` is N→N+1. */
export type Migration = (data: any) => any

/** Distinguish "file is absent" from "file is present but unreadable/corrupt". */
function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT"
}

/**
 * Read a versioned JSON file from `path`.
 *
 * - Missing file → `undefined` (no warning; absence is normal, caller defaults).
 * - Unreadable / invalid JSON → `undefined` + a logged warning; file untouched.
 * - A file with a numeric `schemaVersion` is unwrapped; an envelope-less file is
 *   treated as version 0.
 * - The payload is migrated forward via `migrations[v..currentVersion-1]` and, if
 *   any migration ran (or the file lacked an envelope / was at an older version),
 *   immediately re-saved in the `currentVersion` envelope (read-repair).
 *
 * Returns the migrated `data`, or `undefined` when the file is absent/corrupt.
 */
export function loadVersioned<T>(
  path: string,
  currentVersion: number,
  migrations: Migration[],
): T | undefined {
  let raw: string
  try {
    raw = readFileSync(path, "utf-8")
  } catch (err) {
    if (isNotFound(err)) return undefined
    logWarn("persist", `could not read ${path}: ${err}`)
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    logWarn("persist", `corrupt JSON in ${path} (left untouched): ${err}`)
    return undefined
  }

  // Detect the envelope. An envelope-less file (the pre-versioning format) is
  // version 0 and its whole contents are the payload.
  const hasEnvelope =
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as Versioned<T>).schemaVersion === "number"

  let version = hasEnvelope ? (parsed as Versioned<T>).schemaVersion : 0
  let data: any = hasEnvelope ? (parsed as Versioned<T>).data : parsed

  if (version > currentVersion) {
    logWarn(
      "persist",
      `${path} is schemaVersion ${version}, newer than supported ${currentVersion}; ` +
        `loading as-is without migration`,
    )
    return data as T
  }

  const migratedFromOlder = version < currentVersion
  while (version < currentVersion) {
    // A missing migration slot is an identity step: the shape didn't change at
    // this version, only the envelope did. The canonical case is v0→v1, which
    // wraps a legacy envelope-less file unchanged — no migration fn required.
    const migrate = migrations[version]
    if (typeof migrate === "function") data = migrate(data)
    version++
  }

  // Read-repair: rewrite any file that wasn't already in the current envelope so
  // it's upgraded exactly once and stable thereafter.
  if (migratedFromOlder || !hasEnvelope) {
    try {
      saveVersioned(path, currentVersion, data)
    } catch (err) {
      // A failed repair is non-fatal — the in-memory data is still correct; just
      // surface it so a persistent write problem doesn't go unnoticed.
      logWarn("persist", `failed to rewrite ${path} after migration: ${err}`)
    }
  }

  return data as T
}

/**
 * Atomically write `data` to `path` wrapped as `{ schemaVersion, data }`.
 * Write-then-rename so a crash mid-write leaves the prior valid file intact
 * rather than a truncated one. Creates the parent directory if needed.
 */
export function saveVersioned<T>(path: string, currentVersion: number, data: T): void {
  mkdirSync(dirname(path), { recursive: true })
  const envelope: Versioned<T> = { schemaVersion: currentVersion, data }
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(envelope, null, 2))
  renameSync(tmp, path)
}
