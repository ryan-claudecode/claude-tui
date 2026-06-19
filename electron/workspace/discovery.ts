import { readFileSync, globSync } from "node:fs"
import { join, resolve } from "node:path"

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
          // Normalize to an absolute path so the de-dup key is stable regardless
          // of how the scan glob happened to spell the directory.
          dir: resolve(dir),
        })
      } catch {
        // Skip directories without a valid workspace.json
      }
    }
  }
  return manifests
}
