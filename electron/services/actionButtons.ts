import { join } from "node:path"
import { homedir } from "node:os"
import { readdirSync, unlinkSync } from "node:fs"
import { loadVersioned, saveVersioned, type Migration } from "../persist"
import { logWarn } from "../log"
import { UNTAGGED_STEM } from "./workspaceMemory"

/**
 * Action Buttons — agent-generated rail affordances (CAPP-104 / AB-1).
 *
 * The FIRST two-way surface on the Agent Rail: an agent (or, later, the user) can
 * render a durable BUTTON that persists with a work session and/or a workspace; the
 * user clicks it to re-dispatch a stored prompt into a live agent terminal. The
 * safety thesis stays intact — a button's action is a PROMPT dispatched to a Claude
 * session, never raw shell or an app-privileged op; it adds zero capability an agent
 * didn't already have, it only makes a user-initiated repeat cheap.
 *
 * Persistence mirrors {@link WorkspaceMemoryService}: one file per OWNER under
 * `~/.claude-tui/action-buttons/` (`session-<id>.json` / `workspace-<id>.json`), the
 * untagged/folderless workspace keyed by the same {@link UNTAGGED_STEM} sentinel. A
 * button set is DELIBERATELY not folded into the workspace-memory record: memory is
 * knowledge (promoted, long-lived), buttons are affordances (they die with their
 * session file). Every external effect (fs, now) is injectable so tests stay hermetic.
 */

/** v1 greenfield, no migrations — the type below is the superset. */
export const SCHEMA_VERSION = 1
export const MIGRATIONS: Migration[] = []

/** The rail is a glance surface, not a launcher grid — a hard per-owner cap. */
export const MAX_BUTTONS_PER_OWNER = 8
/** A label is visible text (words over icons) — kept short so a row never wraps. */
export const MAX_LABEL_LEN = 24

/** Re-export so the MCP tools + parity tests read the sentinel from one place. */
export { UNTAGGED_STEM } from "./workspaceMemory"

export type ButtonScope = "session" | "workspace"

export interface ActionButton {
  id: string
  /** Visible text (≤ {@link MAX_LABEL_LEN} chars). */
  label: string
  /** The prompt dispatched to the owning session's live agent terminal on click. */
  prompt: string
  scope: ButtonScope
  /** A session id, or a workspace id ({@link UNTAGGED_STEM} for the untagged bucket). */
  ownerId: string
  /** Two-step inline confirm before dispatch (default off). */
  confirm?: boolean
  createdBy: "agent" | "user"
  createdAt: number
}

/** The input shape for {@link ActionButtonService.add} (service owns id/createdAt). */
export interface ActionButtonInput {
  label: string
  prompt: string
  confirm?: boolean
  createdBy?: "agent" | "user"
}

/** One owner's on-disk record (a per-owner file). */
interface OwnerRecord {
  scope: ButtonScope
  ownerId: string
  buttons: ActionButton[]
}

/** The event a change-listener receives: the affected owner's FULL button list
 *  (empty when the owner was cleared / its session was killed). Mirrors the
 *  full-snapshot-per-mutation posture of `schedule:updated`. */
export interface ActionButtonsChanged {
  scope: ButtonScope
  ownerId: string
  buttons: ActionButton[]
}

export type AddResult = { ok: true; button: ActionButton } | { ok: false; error: string }

/** Injected deps for the dispatch orchestration (below) — real services in ipc.ts,
 *  fakes in tests. Kept as a free function (not a method) so the whole live-terminal-
 *  vs-fresh-spawn resolution is unit-testable without Electron. */
export interface DispatchDeps {
  findButton: (id: string) => ActionButton | undefined
  getSession: (
    id: string,
  ) => { name: string; terminals: Array<{ id: string; engine?: string; lastState?: string }> } | undefined
  /** Is this terminal still alive (drives the reuse-vs-spawn decision). */
  isAlive: (terminalId: string) => boolean
  /** Spawn a fresh terminal into the session; returns its id (or undefined on failure). */
  spawnTerminal: (sessionId: string) => string | undefined
  /** Deliver the prompt to a terminal via the stdin sink; returns whether it landed. */
  sendPrompt: (terminalId: string, prompt: string) => boolean
}

export interface DispatchResult {
  ok: boolean
  error?: string
  sessionName?: string
  terminalId?: string
  /** Whether a fresh terminal had to be spawned (no live structured terminal existed). */
  spawned?: boolean
}

/**
 * Resolve the target terminal for a click and deliver the prompt: reuse the owning
 * session's MOST RECENT live structured terminal, else spawn a fresh one first (the
 * resume/primer machinery makes it context-aware for free). Pure over injected deps.
 */
export function dispatchActionButton(
  deps: DispatchDeps,
  buttonId: string,
  targetSessionId: string,
): DispatchResult {
  const button = deps.findButton(buttonId)
  if (!button) return { ok: false, error: "Button not found." }
  const session = deps.getSession(targetSessionId)
  if (!session) return { ok: false, error: "Session not found." }

  const terminalId = pickDispatchTerminal(session.terminals, deps.isAlive)
  let spawned = false
  let target = terminalId
  if (!target) {
    target = deps.spawnTerminal(targetSessionId)
    spawned = true
    if (!target) return { ok: false, error: "Couldn't open a terminal for the session." }
  }
  if (!deps.sendPrompt(target, button.prompt)) {
    return { ok: false, error: "The terminal couldn't accept the prompt.", spawned }
  }
  return { ok: true, sessionName: session.name, terminalId: target, spawned }
}

/** The most-recent LIVE structured terminal of a session, or undefined (→ fresh spawn).
 *  Append-order terminals means the last live structured one is the newest. */
export function pickDispatchTerminal(
  terminals: Array<{ id: string; engine?: string; lastState?: string }>,
  isAlive: (id: string) => boolean,
): string | undefined {
  const live = terminals.filter((t) => t.engine === "structured" && isAlive(t.id))
  return live.length ? live[live.length - 1].id : undefined
}

export class ActionButtonService {
  private dir: string
  private now: () => number
  /** In-memory cache keyed by file stem (`session-<id>` / `workspace-<id>`). */
  private cache = new Map<string, OwnerRecord>()
  private listeners = new Set<(e: ActionButtonsChanged) => void>()

  constructor(opts: { dir?: string; now?: () => number } = {}) {
    this.dir = opts.dir ?? join(homedir(), ".claude-tui", "action-buttons")
    this.now = opts.now ?? (() => Date.now())
    this.loadAll()
  }

  // ── key / file mapping ─────────────────────────────────────────────────────────

  /** Map a public owner arg to the STORED owner id. Session requires a real id; a
   *  workspace `null`/undefined (or the literal sentinel) → the untagged stem. */
  private storedOwner(scope: ButtonScope, ownerId: string | null | undefined): string {
    if (scope === "session") {
      if (!ownerId) throw new Error("a session-scoped action button requires a session id")
      return ownerId
    }
    return ownerId == null ? UNTAGGED_STEM : ownerId
  }

  /** The cache key AND filename stem for an owner (deterministic from scope+stored id). */
  private key(scope: ButtonScope, storedOwnerId: string): string {
    return `${scope}-${storedOwnerId}`
  }

  private fileFor(scope: ButtonScope, storedOwnerId: string): string {
    return join(this.dir, `${this.key(scope, storedOwnerId)}.json`)
  }

  private mintId(): string {
    return `btn-${this.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  // ── load ───────────────────────────────────────────────────────────────────────

  /** Warm the cache from disk at construction so `list()` is complete after a restart
   *  (mirrors WorkspaceMemoryService.loadAll). Per-file failures are isolated. */
  private loadAll(): void {
    let files: string[]
    try {
      files = readdirSync(this.dir)
    } catch {
      return // dir doesn't exist yet → nothing persisted
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue
      const stem = f.slice(0, -".json".length)
      try {
        const rec = loadVersioned<OwnerRecord>(join(this.dir, f), SCHEMA_VERSION, MIGRATIONS)
        if (rec && (rec.scope === "session" || rec.scope === "workspace") && Array.isArray(rec.buttons)) {
          // Trust the record's own scope/ownerId; key by the FILE stem (consistent by
          // construction with `key(scope, storedOwnerId)`), tolerant of a hand edit.
          this.cache.set(stem, {
            scope: rec.scope,
            ownerId: typeof rec.ownerId === "string" ? rec.ownerId : stem,
            buttons: rec.buttons.filter((b): b is ActionButton => !!b && typeof b.id === "string"),
          })
        }
      } catch (err) {
        logWarn("actionButtons", `failed to load ${f}: ${String(err)}`)
      }
    }
  }

  private loadOrCreate(scope: ButtonScope, storedOwnerId: string): OwnerRecord {
    const key = this.key(scope, storedOwnerId)
    const cached = this.cache.get(key)
    if (cached) return cached
    const fresh: OwnerRecord = { scope, ownerId: storedOwnerId, buttons: [] }
    this.cache.set(key, fresh)
    return fresh
  }

  private persistAndEmit(rec: OwnerRecord): void {
    saveVersioned(this.fileFor(rec.scope, rec.ownerId), SCHEMA_VERSION, rec)
    this.emit({ scope: rec.scope, ownerId: rec.ownerId, buttons: [...rec.buttons] })
  }

  // ── change seam ──────────────────────────────────────────────────────────────────

  /** Subscribe to button-set changes. Returns an unsubscribe fn. Mirrors
   *  {@link SchedulerService.onEvent}: ipc.ts registers one callback that pushes
   *  `actionbuttons:updated` to the main window. */
  onChanged(cb: (e: ActionButtonsChanged) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(e: ActionButtonsChanged): void {
    for (const cb of this.listeners) cb(e)
  }

  // ── read ─────────────────────────────────────────────────────────────────────────

  /** Every button across every owner, flat (the renderer seed — the rail derives its
   *  visible subset from this). */
  list(): ActionButton[] {
    return [...this.cache.values()].flatMap((r) => [...r.buttons])
  }

  /** One owner's buttons (empty when the owner has none). */
  listForOwner(scope: ButtonScope, ownerId: string | null | undefined): ActionButton[] {
    const rec = this.cache.get(this.key(scope, this.storedOwner(scope, ownerId)))
    return rec ? [...rec.buttons] : []
  }

  /** The union a caller sees: their session's buttons ∪ their workspace's buttons.
   *  (The MCP `list_action_buttons` view.) */
  listForCaller(sessionId: string | undefined, workspaceId: string | null | undefined): ActionButton[] {
    const session = sessionId ? this.listForOwner("session", sessionId) : []
    return [...session, ...this.listForOwner("workspace", workspaceId)]
  }

  /** Find a button by id across all owners (dispatch + MCP remove resolution). */
  findById(id: string): ActionButton | undefined {
    for (const rec of this.cache.values()) {
      const b = rec.buttons.find((x) => x.id === id)
      if (b) return b
    }
    return undefined
  }

  // ── mutate ─────────────────────────────────────────────────────────────────────────

  /** Add a button to an owner. Enforces the label/prompt shape + the per-owner cap
   *  (a clear error string past the cap — the agent is told to remove one first). */
  add(scope: ButtonScope, ownerId: string | null | undefined, input: ActionButtonInput): AddResult {
    const storedOwner = this.storedOwner(scope, ownerId)
    const label = (input.label ?? "").trim()
    if (!label) return { ok: false, error: "A button needs a label." }
    if (label.length > MAX_LABEL_LEN) {
      return { ok: false, error: `Label too long — keep it under ${MAX_LABEL_LEN} characters.` }
    }
    const prompt = (input.prompt ?? "").trim()
    if (!prompt) return { ok: false, error: "A button needs a prompt to dispatch." }

    const rec = this.loadOrCreate(scope, storedOwner)
    if (rec.buttons.length >= MAX_BUTTONS_PER_OWNER) {
      return {
        ok: false,
        error: `This ${scope} already has the maximum of ${MAX_BUTTONS_PER_OWNER} buttons — remove one first.`,
      }
    }
    const button: ActionButton = {
      id: this.mintId(),
      label,
      prompt,
      scope,
      ownerId: storedOwner,
      ...(input.confirm ? { confirm: true } : {}),
      createdBy: input.createdBy ?? "agent",
      createdAt: this.now(),
    }
    rec.buttons.push(button)
    this.persistAndEmit(rec)
    return { ok: true, button }
  }

  /** Remove a button from an owner. Returns whether one was removed. */
  remove(scope: ButtonScope, ownerId: string | null | undefined, buttonId: string): boolean {
    const storedOwner = this.storedOwner(scope, ownerId)
    const rec = this.cache.get(this.key(scope, storedOwner))
    if (!rec) return false
    const idx = rec.buttons.findIndex((b) => b.id === buttonId)
    if (idx === -1) return false
    rec.buttons.splice(idx, 1)
    this.persistAndEmit(rec)
    return true
  }

  /**
   * Session-kill cleanup: drop a session's button file + cache entry, then emit an
   * empty snapshot so the rail drops its rows. Workspace buttons are untouched (they
   * outlive any session). Hooked off the `worksession:removed` seam in ipc.ts.
   */
  deleteForSession(sessionId: string): void {
    const key = this.key("session", sessionId)
    const existed = this.cache.delete(key)
    try {
      unlinkSync(this.fileFor("session", sessionId))
    } catch {
      /* already gone — nothing to do */
    }
    if (existed) this.emit({ scope: "session", ownerId: sessionId, buttons: [] })
  }
}
