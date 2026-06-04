import { readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

export interface Note {
  id: string
  title: string
  body: string
  /** Optional project/working-dir path this note pertains to, for scoping. */
  scope?: string
  tags: string[]
  createdAt: string
  updatedAt: string
}

const NOTES_DIR = join(homedir(), ".claude-tui")
const NOTES_FILE = join(NOTES_DIR, "notes.json")

/**
 * NotesService — a persistent, cross-session scratchpad. One Claude session can
 * leave durable notes (context, gotchas, decisions, "the build flag for X is Y")
 * that a *future* session — even in a different terminal or after an app restart
 * — can read back. This is the orchestration glue the other Phase 5 features
 * lack: snippets/templates seed input, but nothing lets sessions persist learned
 * context for one another.
 *
 * Thin by design: it only reads/writes its own JSON file at
 * ~/.claude-tui/notes.json. No session-layer or renderer changes.
 */
export class NotesService {
  private read(): Note[] {
    try {
      const data = JSON.parse(readFileSync(NOTES_FILE, "utf-8"))
      return Array.isArray(data) ? data : []
    } catch {
      return []
    }
  }

  private persist(notes: Note[]): void {
    mkdirSync(NOTES_DIR, { recursive: true })
    writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2))
  }

  /** List notes, optionally filtered by scope (substring match) and/or tag. */
  list(scope?: string, tag?: string): Note[] {
    let notes = this.read()
    if (scope) notes = notes.filter((n) => (n.scope ?? "").includes(scope))
    if (tag) notes = notes.filter((n) => n.tags.includes(tag))
    return notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  get(id: string): Note | undefined {
    return this.read().find((n) => n.id === id)
  }

  /**
   * Create a new note, or update an existing one when `id` matches. Returns the
   * saved note.
   */
  save(
    title: string,
    body: string,
    opts: { id?: string; scope?: string; tags?: string[] } = {},
  ): Note {
    const notes = this.read()
    const now = new Date().toISOString()
    const existing = opts.id ? notes.find((n) => n.id === opts.id) : undefined

    if (existing) {
      existing.title = title
      existing.body = body
      existing.scope = opts.scope ?? existing.scope
      existing.tags = opts.tags ?? existing.tags
      existing.updatedAt = now
      this.persist(notes)
      return existing
    }

    const note: Note = {
      id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      body,
      scope: opts.scope,
      tags: opts.tags ?? [],
      createdAt: now,
      updatedAt: now,
    }
    notes.push(note)
    this.persist(notes)
    return note
  }

  /** Delete a note by id. Returns false if none matched. */
  delete(id: string): boolean {
    const notes = this.read()
    const next = notes.filter((n) => n.id !== id)
    if (next.length === notes.length) return false
    this.persist(next)
    return true
  }
}
