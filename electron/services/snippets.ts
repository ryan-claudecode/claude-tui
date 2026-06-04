import { readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { SessionService } from "./sessions"

export interface Snippet {
  name: string
  content: string
  savedAt: string
}

const SNIPPETS_DIR = join(homedir(), ".claude-tui")
const SNIPPETS_FILE = join(SNIPPETS_DIR, "snippets.json")

/**
 * SnippetService — a small library of reusable prompt snippets persisted to
 * ~/.claude-tui/snippets.json. Unlike session templates (which spawn a new
 * session), snippets are injected into an *existing* session's input, so a user
 * or Claude can stash a frequently-used instruction and fire it on demand.
 *
 * Thin by design: it only reads/writes its own JSON file and calls
 * SessionService.write() to inject text — no changes to the session layer.
 */
export class SnippetService {
  constructor(private sessions: SessionService) {}

  private read(): Snippet[] {
    try {
      const data = JSON.parse(readFileSync(SNIPPETS_FILE, "utf-8"))
      return Array.isArray(data) ? data : []
    } catch {
      return []
    }
  }

  private persist(snippets: Snippet[]): void {
    mkdirSync(SNIPPETS_DIR, { recursive: true })
    writeFileSync(SNIPPETS_FILE, JSON.stringify(snippets, null, 2))
  }

  list(): Snippet[] {
    return this.read()
  }

  /** Save a snippet (replaces any existing one with the same name). */
  save(name: string, content: string): Snippet {
    const snippet: Snippet = { name, content, savedAt: new Date().toISOString() }
    const snippets = this.read().filter((s) => s.name !== name)
    snippets.push(snippet)
    this.persist(snippets)
    return snippet
  }

  /** Delete a snippet by name. Returns false if none matched. */
  delete(name: string): boolean {
    const snippets = this.read()
    const next = snippets.filter((s) => s.name !== name)
    if (next.length === snippets.length) return false
    this.persist(next)
    return true
  }

  /**
   * Inject a snippet's content into a session's input. Returns false if the
   * snippet doesn't exist. Whether the session exists is the caller's concern —
   * SessionService.write() no-ops on an unknown id.
   */
  send(name: string, sessionId: string): boolean {
    const snippet = this.read().find((s) => s.name === name)
    if (!snippet) return false
    this.sessions.write(sessionId, snippet.content)
    return true
  }
}
