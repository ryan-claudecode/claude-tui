import { readFileSync, globSync } from "node:fs"
import { join, resolve } from "node:path"

/**
 * The ONE canonicalizer for a workspace dir used as a de-dup key. It MUST be
 * applied identically everywhere a dir becomes a key — discovery's stored
 * manifest `dir`, the scaffold/create/setDir `seedDir` bind, and `discover`'s
 * `byListedDir`/`bySeedDir` indexes — or the keys disagree and a rescan mints a
 * DUPLICATE workspace. It lives HERE (not in workspaces.ts) so discovery can use
 * it without a circular import; `workspaces.ts` re-exports it.
 *
 * Two steps, both load-bearing:
 *  1. `path.resolve` — normalizes separators (`/`→`\` on win32) and collapses
 *     `.`/`..`/trailing slashes to ONE spelling. Without this, a forward-slash
 *     dir (`C:/foo`, which the MCP create_workspace/set_workspace_dir tools pass
 *     straight through — an LLM naturally emits POSIX slashes on Windows) or a
 *     trailing-slash dir stored a key that MISSED discovery's backslash lookup
 *     on rescan → duplicate. (`resolve` is idempotent on an already-resolved
 *     absolute path, so applying it more than once is a no-op.)
 *  2. On win32 the drive letter's case is not significant (`c:\` ≡ `C:\`), yet
 *     `resolve` preserves whatever case the source produced, so we upper-case the
 *     leading `<letter>:` to collapse those spellings to one key too.
 * KNOWN LIMITATION: this does NOT resolve junctions/symlinks or `8.3` short
 * names — two genuinely different spellings of the same target still dup.
 */
export function canonSeedDir(dir: string): string {
  const abs = resolve(dir)
  return process.platform === "win32"
    ? abs.replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`)
    : abs
}

/**
 * A repo entry inside a discovered `workspace.json` manifest. Retained so the
 * existing `activate()` boot path (open editors + spawn one session per repo)
 * keeps working — the registry stores the manifest's dirs, while the boot path
 * still reads the richer repo metadata off the manifest the registry was seeded
 * from.
 */
export interface WorkspaceRepo {
  name: string
  path: string
  open_on_boot: boolean
}

/**
 * A `workspace.json` manifest discovered on disk (NOT the durable registry
 * entry). Discovery is now a SEED/IMPORT source, not the source of truth: the
 * registry (workspaces.json) is authoritative. `dir` is the manifest's own
 * absolute directory — the STABLE de-dup key the registry keys imports by, so a
 * re-scan of the same manifest never creates a duplicate registry entry.
 *
 * (Formerly named `Workspace`; renamed to make the manifest-vs-registry-entry
 * distinction explicit now that the registry owns the real `Workspace` type.)
 */
export interface DiscoveredManifest {
  name: string
  alias: string
  editor: string
  repos: WorkspaceRepo[]
  /** Absolute path to the directory containing the manifest. De-dup key. */
  dir: string
}

export function discoverWorkspaces(scanPatterns: string[]): DiscoveredManifest[] {
  const manifests: DiscoveredManifest[] = []
  for (const pattern of scanPatterns) {
    let dirs: string[]
    try {
      dirs = globSync(pattern)
    } catch {
      continue
    }
    for (const dir of dirs) {
      const wsFile = join(dir, "workspace.json")
      try {
        const raw = readFileSync(wsFile, "utf-8")
        const data = JSON.parse(raw)
        manifests.push({
          name: data.name ?? "unknown",
          alias: data.alias ?? "",
          editor: data.editor ?? "code",
          repos: (data.repos ?? []).map((r: any) => ({
            name: r.name ?? "",
            path: r.path ?? "",
            open_on_boot: r.open_on_boot ?? false,
          })),
          // Canonicalize so the de-dup key is stable regardless of how the scan
          // glob spelled the directory (separators, trailing slash, drive case).
          // Same canonicalizer the registry's seedDir bind + lookup use.
          dir: canonSeedDir(dir),
        })
      } catch {
        // Skip directories without a valid workspace.json
      }
    }
  }
  return manifests
}
