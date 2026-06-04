import { readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { TerminalService, TerminalInfo } from "./terminals"

export interface SavedLayout {
  name: string
  savedAt: string
  sessions: { name: string; cwd: string }[]
}

const LAYOUTS_DIR = join(homedir(), ".claude-tui")
const LAYOUTS_FILE = join(LAYOUTS_DIR, "layouts.json")

/**
 * LayoutService — persists named "session layouts" (the set of open sessions and
 * their working directories) to ~/.claude-tui/layouts.json and recreates them on
 * demand. Lets a user (or Claude) snapshot a working setup — e.g. "frontend",
 * "incident-review" — and restore it later or after an app restart.
 *
 * Deliberately thin: it only reads TerminalService's public list() and create(),
 * so it owns no PTY state and needs no changes to the session layer.
 */
export class LayoutService {
  constructor(private sessions: TerminalService) {}

  private read(): SavedLayout[] {
    try {
      const data = JSON.parse(readFileSync(LAYOUTS_FILE, "utf-8"))
      return Array.isArray(data) ? data : []
    } catch {
      return []
    }
  }

  private persist(layouts: SavedLayout[]): void {
    mkdirSync(LAYOUTS_DIR, { recursive: true })
    writeFileSync(LAYOUTS_FILE, JSON.stringify(layouts, null, 2))
  }

  list(): SavedLayout[] {
    return this.read()
  }

  /** Snapshot the currently open sessions under a name (replaces same name). */
  save(name: string): SavedLayout {
    const layout: SavedLayout = {
      name,
      savedAt: new Date().toISOString(),
      sessions: this.sessions.list().map((s) => ({ name: s.name, cwd: s.cwd })),
    }
    const layouts = this.read().filter((l) => l.name !== name)
    layouts.push(layout)
    this.persist(layouts)
    return layout
  }

  /** Recreate every session in a saved layout. Returns the created sessions. */
  restore(name: string): TerminalInfo[] | null {
    const layout = this.read().find((l) => l.name === name)
    if (!layout) return null
    return layout.sessions.map((s) => this.sessions.create(s.name, s.cwd))
  }

  /** Delete a saved layout. Returns false if no layout had that name. */
  delete(name: string): boolean {
    const layouts = this.read()
    const next = layouts.filter((l) => l.name !== name)
    if (next.length === layouts.length) return false
    this.persist(next)
    return true
  }
}
