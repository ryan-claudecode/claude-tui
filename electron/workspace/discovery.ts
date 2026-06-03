import { readFileSync, globSync } from "node:fs"
import { join } from "node:path"

export interface WorkspaceRepo {
  name: string
  path: string
  open_on_boot: boolean
}

export interface Workspace {
  name: string
  alias: string
  editor: string
  repos: WorkspaceRepo[]
  dir: string
}

export function discoverWorkspaces(scanPatterns: string[]): Workspace[] {
  const workspaces: Workspace[] = []
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
        workspaces.push({
          name: data.name ?? "unknown",
          alias: data.alias ?? "",
          editor: data.editor ?? "code",
          repos: (data.repos ?? []).map((r: any) => ({
            name: r.name ?? "",
            path: r.path ?? "",
            open_on_boot: r.open_on_boot ?? false,
          })),
          dir,
        })
      } catch {
        // Skip directories without valid workspace.json
      }
    }
  }
  return workspaces
}
