import { spawn } from "child_process"
import { discoverWorkspaces, type Workspace } from "../workspace/discovery"
import type { SessionService, SessionInfo } from "./sessions"

export class WorkspaceService {
  private workspaces: Workspace[] = []
  private sessionService: SessionService

  constructor(sessionService: SessionService) {
    this.sessionService = sessionService
  }

  discover(scanPaths: string[]): void {
    this.workspaces = discoverWorkspaces(scanPaths)
  }

  list(): Workspace[] {
    return this.workspaces
  }

  activate(index: number): { workspace: string; sessions: SessionInfo[] } | null {
    const ws = this.workspaces[index]
    if (!ws) return null

    // Open editors for repos marked open_on_boot
    for (const repo of ws.repos) {
      if (repo.open_on_boot) {
        const editorRepoPath = repo.path.replace(/^~/, process.env.HOME ?? process.env.USERPROFILE ?? "")
        const editorCmd = ws.editor?.toLowerCase() ?? "code"
        spawn(editorCmd, ["--new-window", editorRepoPath], {
          detached: true,
          stdio: "ignore",
        }).unref()
      }
    }

    // Create Claude sessions for each repo
    const created: SessionInfo[] = []
    for (const repo of ws.repos) {
      const repoPath = repo.path.replace(/^~/, process.env.HOME ?? process.env.USERPROFILE ?? "")
      const info = this.sessionService.create(repo.name, repoPath)
      created.push(info)
    }
    return { workspace: ws.name, sessions: created }
  }
}
