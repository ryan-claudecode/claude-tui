import { readdirSync, unlinkSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { parseActivityLine } from "./terminals"
import {
  listFolderConversations as listFolderConversationsRaw,
  type FolderConversation,
} from "./folderConversations"
import type { RenderingEngine } from "../config"
import { logWarn } from "../log"
import { loadVersioned, saveVersioned, type Migration } from "../persist"
import type { PromoteEntry } from "./workspaceMemory"

/**
 * BO-11 (CAPP-50) — the deny message {@link SessionService.interruptAgent} settles a
 * permission-parked turn with, through the LIVE proc, before respawning. It both
 * CLOSES the turn on disk (so `--resume` has no half-open tool_use to replay) and
 * leaves the agent explicit "the user cancelled this" context in the resumed
 * conversation, so it won't re-decide to retry on the next prompt.
 */
const INTERRUPT_ABORT_MESSAGE =
  "The user interrupted this action with Stop. Do not retry or complete it. Stop now and await further instructions."

export interface TerminalRef {
  id: string
  name: string
  cwd: string
  ccConversationId?: string
  lastState: "active" | "idle" | "dead"
  /**
   * BO-4b — the transport this terminal was spawned with ("xterm" | "structured"),
   * set from {@link TerminalLike.create}'s returned info at every spawn/handoff/
   * reopen. Surfaced to the renderer (it flows through `list()` and
   * `withEffectiveActivity`'s `...t` spread) so the renderer forks PER TERMINAL —
   * AgentView+composer for structured, TerminalPane for xterm — instead of a
   * single global config boolean. Optional/additive: legacy refs load fine (it
   * stays undefined → the renderer treats it as the "xterm" default).
   */
  engine?: RenderingEngine
  /**
   * BO-6 — the `--model` this STRUCTURED terminal runs (set from
   * {@link TerminalLike.create}'s returned info at every spawn/handoff/reopen/
   * model-switch). Persisted so a restore (`reopenTerminal`) re-passes it and the
   * user's chosen model survives an app restart. Surfaced to the renderer (flows
   * through `list()`/`withEffectiveActivity`'s `...t` spread) so the in-app picker
   * shows the current model. Optional/additive: legacy refs load fine (undefined →
   * the spawn falls back to the config default).
   */
  model?: string
  /**
   * CAPP-46 — the `--effort` level this STRUCTURED terminal runs, or undefined if no
   * level was picked (the spawn then OMITS `--effort`). Set from the spawn's returned
   * info at every spawn/handoff/reopen/effort-switch; persisted so a restore
   * (`reopenTerminal`) re-passes it. Surfaced to the renderer (flows through
   * `list()`/`withEffectiveActivity`'s `...t` spread) so the in-app effort picker
   * shows the current level. Optional/additive: legacy refs load fine (undefined →
   * the spawn omits `--effort`, byte-unchanged default).
   */
  effort?: string
  /** Rich-presence "what this terminal is doing now" line (Claude self-reports it). */
  activity?: string
  /** Epoch ms when `activity` was last set. */
  activityAt?: number
  /**
   * CAPP-39 gate ② — true for the one-time interactive `claude /login` terminal
   * (see {@link SessionService.startLogin}). It is NOT a normal agent terminal: an
   * ephemeral OAuth affordance. So it is EXCLUDED from idle-flush summary-refresh,
   * broadcast fan-out, and restart auto-restore — and it is STRIPPED from the
   * persisted JSON entirely (a `persist()`-time filter) so it never resurrects as a
   * ghost "Sign in" terminal. Optional/additive: legacy refs load fine (undefined →
   * a normal terminal). reopenTerminal also skips it defensively.
   */
  isLogin?: boolean
}

export interface Note {
  id: string
  text: string
  createdAt: number
  source: "self" | "observer"
  status: "active" | "superseded"
  supersededBy?: string
}

/**
 * One terse, human-readable entry in a work session's durable life-history. The
 * session accumulates these at its lifecycle points (terminal spawn/retire,
 * note/correction/summary refresh, handoff, idle-flush) so "what did my agents
 * do while I was away?" is answerable from the on-disk record alone.
 */
export interface SessionEvent {
  time: number
  kind: "spawn" | "retire" | "handoff" | "note" | "correction" | "summary" | "idle-flush"
  text: string
  terminalId?: string
}

export interface WorkSession {
  id: string
  name: string
  status: "active" | "stopped"
  workspaceId?: string
  summary: string
  notes: Note[]
  provisionalFindings: Note[]
  terminals: TerminalRef[]
  /**
   * Durable life-history (ST-1). OPTIONAL and additive: legacy sessions persisted
   * before this field existed load fine (it stays undefined), so no schema-version
   * bump is needed. Capped at ~500 entries via {@link SessionService.logEvent}.
   */
  eventLog?: SessionEvent[]
  createdAt: number
  updatedAt: number
}

export interface SessionOverview {
  id: string
  name: string
  status: "active" | "stopped"
  summary: string
  notes: Note[]
  ruledOut: Array<{ id: string; text: string; correction?: string }>
  provisionalFindings: Note[]
  terminals: Array<TerminalRef & { activity?: string }>
}

export interface SessionServiceOpts {
  dir?: string
  now?: () => number
  idleFlushGraceMs?: number
  /**
   * WS-C — data-scoping seam. A getter returning the CURRENTLY-ACTIVE workspace id
   * (or null/undefined when "All" mode), so a session minted while a workspace is
   * active is stamped with it. Injected as a callback (not the WorkspaceService
   * itself) to keep this service decoupled + testable — the same posture
   * MissionService/AttentionService use for their cross-service deps. `ipc.ts`
   * wires it to `workspaceService.getActiveId()`. Absent → every session is
   * untagged (the "All" bucket), so existing call sites/tests are unaffected.
   */
  getActiveWorkspaceId?: () => string | null | undefined
  /**
   * WS-G (G1) — the spawn-cwd seam. A getter returning the CURRENTLY-ACTIVE
   * workspace's single folder (`dir`, resolved absolute + verified to exist),
   * or null when there is no active workspace / it has no folder / the dir is missing.
   * When a NEW work session is created with no explicit cwd, its terminal(s) spawn
   * HERE so `claude` runs as if opened in that directory (sees its files + git).
   * Same callback-injection posture as `getActiveWorkspaceId` — `ipc.ts` wires it to
   * `workspaceService.getActiveWorkspaceDir()`. Absent / null → keep the current
   * default cwd behavior (existing call sites/tests unaffected). A NEW terminal added
   * to an EXISTING session does NOT consult this — it inherits the session's own cwd
   * (see {@link SessionService.addTerminalToSession}).
   */
  getActiveWorkspaceDir?: () => string | null | undefined
  /**
   * CAPP-75 — the Claude Code transcript store root, where every conversation's
   * `.jsonl` lives under `<root>/<encoded-cwd>/`. Used by {@link SessionService.listFolderConversations}
   * to enumerate a folder's resumable conversations (including ones started OUTSIDE
   * the app). Injectable for hermetic tests; production defaults to
   * `join(homedir(), ".claude", "projects")` — the SAME root TerminalService watches
   * for convo-id capture, so the two never drift.
   */
  ccProjectsRoot?: string
  /**
   * CAPP-86 — OPTIONAL cross-session primer enrichment seam ("The Lexicon"). When
   * present AND enabled (see {@link SessionServiceOpts.primerRecallEnabled}),
   * {@link SessionService.getContext} appends a capped "## Related from other
   * sessions" block of recall hits sourced from this callback. Injected as a
   * callback (RecallService is read-only and decoupled), the same posture as
   * getActiveWorkspaceId. ABSENT → the primer is byte-identical (existing call
   * sites/tests unaffected). The callback is given the session's own id + workspace
   * id so it can scope to the workspace and exclude the session's own entries.
   */
  recallRelated?: (args: {
    sessionId: string
    workspaceId?: string
    query: string
    limit: number
  }) => Array<{ text: string; sessionName: string; status: "active" | "ruled-out" | "summary"; correction?: string }>
  /**
   * CAPP-86 — gate for the primer enrichment above. Re-read FRESH each call
   * (mirroring the loadConfig() re-read posture elsewhere) so a config flip is
   * honored without an app restart. DEFAULT (absent) → FALSE (OFF): the default
   * primer is byte-identical. Only an explicit `true` arms the enrichment.
   */
  primerRecallEnabled?: () => boolean
}

/** Persistence schema version. v1 = today's WorkSession shape verbatim. */
const SCHEMA_VERSION = 1
const MIGRATIONS: Migration[] = []

/** Cap on a session's durable eventLog (mirrors MissionService's audit-trail cap). */
const MAX_EVENTS = 500

/** The slice of TerminalService the container drives. */
export interface TerminalLike {
  // `engine` is optional HERE (the structural slice the container depends on) so
  // test mocks may omit it — undefined flows to TerminalRef.engine and the
  // renderer treats it as the "xterm" default. The real TerminalService always
  // returns it (TerminalInfo.engine is required there).
  // BO-6: a trailing `model` arg pins `--model` on the structured spawn (positions
  // match the real TerminalService so call sites stay arg-compatible). `model` is
  // optional on the returned info (test mocks may omit it → undefined flows to
  // TerminalRef.model). CAPP-46: `effort` is the next positional arg and likewise
  // optional on the returned info; when unset the spawn OMITS `--effort`.
  create(name?: string, cwd?: string, sessionId?: string, resumeConvId?: string, model?: string, effort?: string): { id: string; name: string; cwd: string; state: string; engine?: RenderingEngine; model?: string; effort?: string }
  /** BO-5: structured (headless) spawn — used by handoff/model-switch to retire-&-
   *  continue a structured terminal with a structured replacement. BO-6: `model`
   *  is the 6th arg (after `allowedTools`); CAPP-46: `effort` is the 7th arg, both
   *  matching the real TerminalService. */
  createHeadless(name?: string, cwd?: string, sessionId?: string, resumeConvId?: string, allowedTools?: string[], model?: string, effort?: string): { id: string; name: string; cwd: string; state: string; engine?: RenderingEngine; model?: string; effort?: string }
  /** CAPP-39 gate ②: spawn a one-time INTERACTIVE `claude /login` xterm terminal
   *  (the structured engine can't show the OAuth UI). Always engine:"xterm" and
   *  isLogin:true (so the container marks the ref and excludes it from the
   *  agent-terminal machinery). */
  createLogin(name?: string, cwd?: string, sessionId?: string): { id: string; name: string; cwd: string; state: string; engine?: RenderingEngine; model?: string; effort?: string; isLogin?: boolean }
  /** CAPP-39 gate ③: spawn a terminal on the legacy interactive PTY (xterm)
   *  transport REGARDLESS of the global engine — the raw-view escape hatch's
   *  structured→xterm spawn. `resumeConvId` keeps the SAME conversation; `model`
   *  (and CAPP-46 `effort`) are accepted for call-site parity but ignored on the
   *  xterm path. */
  createXterm(name?: string, cwd?: string, sessionId?: string, resumeConvId?: string, model?: string, effort?: string): { id: string; name: string; cwd: string; state: string; engine?: RenderingEngine; model?: string; effort?: string }
  /** BO-5: is this terminal headless? Lets the container branch xterm-vs-structured. */
  isHeadless(id: string): boolean
  /** CAPP-39 gate ②: is this terminal the one-time interactive `claude /login` PTY?
   *  Lets the container skip idle-flush/handoff-flush on it. */
  isLogin(id: string): boolean
  /** CAPP-39 gate ③: is this structured terminal generating a turn or parked on a
   *  permission prompt? setTerminalEngine refuses the switch while busy. */
  isBusy(id: string): boolean
  /** BO-10/BO-11: is a permission prompt currently blocking this terminal? interruptAgent
   *  branches on it to close the turn before respawning. */
  hasPendingPermission(id: string): boolean
  /** BO-11: settle the parked permission(s) as an abort DENY through the LIVE proc and
   *  drain the turn to its `result` (closing it on disk) so the subsequent kill+resume
   *  lands on a clean transcript. Resolves true if a result was drained. */
  abortPendingPermissionAndDrain(id: string, message: string): Promise<boolean>
  kill(id: string): boolean
  write(id: string, data: string): void
  getOutput(id: string, maxChars?: number): string | null
  onEvent(cb: (e: { type: "created" | "state" | "exit" | "convo" | "renamed" | "stream"; id?: string; state?: "active" | "idle" | "dead"; info?: { id: string }; ccConversationId?: string; name?: string; event?: unknown }) => void): () => void
}

interface MainWinLike {
  webContents: { send: (channel: string, ...args: unknown[]) => void }
  isDestroyed(): boolean
}

export class SessionService {
  private sessions = new Map<string, WorkSession>()
  private dir: string
  private now: () => number

  private terminals?: TerminalLike
  private mainWin: MainWinLike | null = null

  /** BO-11 — terminal ids with an interruptAgent in flight (single-flight guard so
   *  overlapping Stops don't double-respawn). Keyed by the original terminal id. */
  private interrupting = new Set<string>()

  /** Sessions with notes added since their last summary refresh. */
  private summaryDirty = new Set<string>()
  /** Last idle-flush injection time per session (debounce). */
  private lastFlushAt = new Map<string, number>()
  private readonly idleFlushMinIntervalMs = 60_000
  private idleFlushGraceMs: number
  /** WS-C — active-workspace getter, stamped onto every freshly-minted session. */
  private getActiveWorkspaceId: () => string | null | undefined
  /** WS-G (G1) — active-workspace-dir getter, used as the spawn cwd for a NEW
   *  session's terminal when no explicit cwd is given. */
  private getActiveWorkspaceDir: () => string | null | undefined
  /** CAPP-75 — the Claude Code transcript store root for conversation discovery. */
  private ccProjectsRoot: string
  /** CAPP-86 — OPTIONAL cross-session primer enrichment seam (default: none → off). */
  private recallRelated?: SessionServiceOpts["recallRelated"]
  private primerRecallEnabled: () => boolean

  constructor(opts: SessionServiceOpts = {}) {
    this.dir = opts.dir ?? join(homedir(), ".claude-tui", "sessions")
    this.now = opts.now ?? (() => Date.now())
    this.idleFlushGraceMs = opts.idleFlushGraceMs ?? 20000
    this.getActiveWorkspaceId = opts.getActiveWorkspaceId ?? (() => undefined)
    this.getActiveWorkspaceDir = opts.getActiveWorkspaceDir ?? (() => undefined)
    this.ccProjectsRoot = opts.ccProjectsRoot ?? join(homedir(), ".claude", "projects")
    this.recallRelated = opts.recallRelated
    this.primerRecallEnabled = opts.primerRecallEnabled ?? (() => false)
  }

  attachTerminals(terminals: TerminalLike): void {
    this.terminals = terminals
    terminals.onEvent((e) => {
      if (e.type === "state" && e.id && e.state) this.reconcile(e.id, e.state)
      else if (e.type === "exit" && e.id) this.reconcile(e.id, "dead")
      else if (e.type === "convo" && e.id && e.ccConversationId) {
        this.recordConversationId(e.id, e.ccConversationId)
      } else if (e.type === "renamed" && e.id && e.name) {
        this.renameTerminal(e.id, e.name)
      }
    })
  }

  setMainWindow(win: MainWinLike): void { this.mainWin = win }

  private emit(channel: string, ...args: unknown[]): void {
    if (this.mainWin && !this.mainWin.isDestroyed()) this.mainWin.webContents.send(channel, ...args)
  }

  /** Find the session owning a live terminal id. */
  private sessionOf(terminalId: string): WorkSession | undefined {
    return [...this.sessions.values()].find((s) => s.terminals.some((t) => t.id === terminalId))
  }

  /** Public terminal→session-id lookup (the AttentionService maps entries to
   *  their owning work-session through this). Undefined if the terminal isn't
   *  registered into any session. */
  sessionIdOf(terminalId: string): string | undefined {
    return this.sessionOf(terminalId)?.id
  }

  /**
   * CAPP-96 — the spawning SESSION's own workspaceId (undefined → the untagged "All"
   * bucket). The auto-load builder scopes the workspace tier off THIS, NEVER the active
   * selection (`getActiveId`), so a session spawned while a DIFFERENT workspace is active
   * still injects ITS OWN brain — mirrors the CAPP-87 promote defense. Unknown id →
   * undefined (treated as untagged, same as a session with no workspaceId).
   */
  workspaceIdOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.workspaceId
  }

  /** Persist a terminal rename into the session's durable terminal ref. */
  private renameTerminal(terminalId: string, name: string): void {
    const s = this.sessionOf(terminalId)
    if (!s) return
    const t = s.terminals.find((x) => x.id === terminalId)
    if (!t || t.name === name) return
    t.name = name
    this.persist(s)
    this.emit("worksession:updated", this.withEffectiveActivity(s))
  }

  /** Persist Claude Code's conversation id onto the terminal ref for --resume. */
  private recordConversationId(terminalId: string, ccConversationId: string): void {
    const s = this.sessionOf(terminalId)
    if (!s) return
    const t = s.terminals.find((x) => x.id === terminalId)
    if (!t || t.ccConversationId === ccConversationId) return
    t.ccConversationId = ccConversationId
    this.persist(s)
  }

  /** Fold a live terminal's state into its ref + recompute session status; persist + emit. */
  private reconcile(terminalId: string, state: "active" | "idle" | "dead"): void {
    const s = this.sessionOf(terminalId)
    if (!s) return
    const t = s.terminals.find((x) => x.id === terminalId)
    if (!t) return
    t.lastState = state
    s.status = s.terminals.some((x) => x.lastState === "active" || x.lastState === "idle") ? "active" : "stopped"
    if (state === "idle") this.scheduleIdleFlush(s.id, terminalId)
    this.persist(s)
    this.emit("worksession:updated", this.withEffectiveActivity(s))
  }

  /**
   * After a terminal goes idle, refresh the session summary IF new notes have
   * landed since the last refresh. The terminal that did the work distills it —
   * we inject one prompt asking it to call set_session_summary. Debounced so we
   * never flush more than once per idleFlushMinIntervalMs, and gated on dirty so
   * an idle terminal with nothing new is left alone.
   */
  private scheduleIdleFlush(sessionId: string, terminalId: string): void {
    setTimeout(() => {
      const s = this.sessions.get(sessionId)
      if (!s || !this.terminals) return
      const t = s.terminals.find((x) => x.id === terminalId)
      if (!t || t.lastState !== "idle") return // moved on; don't interrupt
      // CAPP-39 gate ② — NEVER write the bracketed-paste summary-refresh prompt into
      // a login terminal: it's the live interactive OAuth prompt, not an agent. (Also
      // guards a non-structured/xterm-only login PTY whose ref might lack the flag.)
      if (t.isLogin || this.terminals.isLogin(terminalId)) return
      if (!this.summaryDirty.has(sessionId)) return
      const last = this.lastFlushAt.get(sessionId)
      if (last !== undefined && this.now() - last < this.idleFlushMinIntervalMs) return

      this.summaryDirty.delete(sessionId)
      this.lastFlushAt.set(sessionId, this.now())
      this.logEvent(s, "idle-flush", `Requested summary refresh from "${t.name}" on idle`, terminalId)
      this.persist(s)
      const prompt =
        "Before you go quiet: fold any new findings into the session summary now. " +
        "Call set_session_summary with the updated goal + current-state blurb so a " +
        "fresh terminal inherits it. Keep it concise."
      this.terminals.write(terminalId, `\x1b[200~${prompt}\x1b[201~\r`)
    }, this.idleFlushGraceMs)
  }

  /**
   * Create a session + spawn & register its first terminal.
   *
   * WS-G (G1) — when NO explicit cwd is given (the renderer passes "" for "use the
   * default"), and a workspace is active with a resolvable primary directory, the
   * first terminal spawns in that workspace dir so `claude` runs as if opened there
   * (sees its files + git). An explicit cwd (e.g. a workspace launch passing a
   * repo path) always wins; no active workspace / no dir → the default cwd behavior
   * (TerminalService falls back to process.cwd()).
   */
  openSession(cwd?: string): { session: WorkSession; terminalId: string } {
    const session = this.create()
    const resolved = cwd && cwd.trim() ? cwd : this.getActiveWorkspaceDir() ?? undefined
    const terminalId = this.spawnInto(session, resolved)
    return { session, terminalId }
  }

  /**
   * Spawn & register an additional terminal in an existing session.
   *
   * WS-G (G1) — a terminal added to an EXISTING session INHERITS that session's
   * cwd (its first terminal's cwd), NOT the (possibly different) currently-active
   * workspace dir. So a session opened in workspace A keeps spawning new terminals
   * in A even after the user switches the active workspace to B. An explicit cwd
   * still wins; if the session has no terminal to inherit from, fall back to the
   * default (TerminalService → process.cwd()).
   */
  addTerminalToSession(sessionId: string, cwd?: string): { terminalId: string } | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    const inherited = s.terminals.find((t) => !t.isLogin)?.cwd ?? s.terminals[0]?.cwd
    const resolved = cwd && cwd.trim() ? cwd : inherited
    const terminalId = this.spawnInto(s, resolved)
    return { terminalId }
  }

  /**
   * CAPP-75 — list EVERY Claude Code conversation discoverable for `folder`,
   * newest first. This includes conversations started OUTSIDE the app (plain
   * `claude` in a terminal): Claude Code writes every transcript to
   * `~/.claude/projects/<encoded-cwd>/<id>.jsonl` regardless of how it was started,
   * so reading that directory enumerates them all. The cwd→dir encoding REUSES the
   * app's single source of truth ({@link encodeProjectDir} via the
   * folderConversations module), so it can never drift from the convo-id capture
   * path. Read-only; a missing project dir → []. Caps to the 50 most recent (logs
   * if it truncated). Each entry's `id` is the value {@link openConversationInFolder}
   * passes to `--resume`.
   */
  listFolderConversations(folder: string): FolderConversation[] {
    return listFolderConversationsRaw(this.ccProjectsRoot, folder, (total, kept) => {
      logWarn(
        "sessions",
        `listFolderConversations(${folder}): ${total} transcripts, returning the ${kept} most recent`,
      )
    })
  }

  /**
   * CAPP-75 — RESTORE: reopen a discovered conversation by spawning a fresh terminal
   * that runs `claude --resume <conversationId>` with cwd=`folder`, in a new
   * work-session bound to that folder. Reuses the EXISTING resume spawn path
   * (TerminalService.create's `resumeConvId` → `resumeArgs` → `--resume`, the same
   * machinery `reopenTerminal` and the model/effort respawns use), so the restored
   * terminal is a fully-featured agent terminal (engine per config, identity-bound
   * MCP config, convo-id re-capture). The created session inherits its name from
   * the spawn and is workspace-scoped via the normal create() stamping. Returns the
   * new session + terminal id (the renderer points the active selection at them), or
   * undefined if terminals aren't attached / inputs are blank.
   */
  openConversationInFolder(
    folder: string,
    conversationId: string,
  ): { session: WorkSession; terminalId: string } | undefined {
    if (!this.terminals) return undefined
    if (!folder || !folder.trim() || !conversationId || !conversationId.trim()) return undefined
    const session = this.create()
    const info = this.terminals.create(undefined, folder, session.id, conversationId)
    session.terminals.push({
      id: info.id,
      name: info.name,
      cwd: info.cwd,
      lastState: info.state as TerminalRef["lastState"],
      engine: info.engine,
      model: info.model,
      // The conversation id IS known up front (we are resuming it), so record it on
      // the ref immediately — the spawn's bindConversation also re-emits a `convo`
      // event, but stamping it here makes a later reopen/handoff correct even before
      // that event lands.
      ccConversationId: conversationId,
    })
    session.status = "active"
    this.logEvent(
      session,
      "spawn",
      `Restored conversation ${conversationId} in ${folder} (terminal "${info.name}")`,
      info.id,
    )
    this.persist(session)
    this.emit("worksession:updated", this.withEffectiveActivity(session))
    return { session, terminalId: info.id }
  }

  /**
   * CAPP-39 gate ② — launch a one-time INTERACTIVE `claude /login` terminal so the
   * user can complete Claude's OAuth flow (the structured `claude -p` engine can't
   * show that UI). Spawned via TerminalService.createLogin (forced xterm engine,
   * NOT --dangerously-skip-permissions) and registered as a tab in the target
   * session — the caller's structured session when known (so the login sits beside
   * it), else the first live session, else a fresh one. Returns the new terminal id.
   * After login the user re-sends in the structured session (auto-retry is a follow-up).
   */
  startLogin(sessionId?: string): { terminalId: string } | undefined {
    if (!this.terminals) return undefined
    let s = (sessionId && this.sessions.get(sessionId)) || undefined
    if (!s) s = [...this.sessions.values()][0]
    if (!s) s = this.create()
    // Derive cwd from an existing terminal in the session (a WorkSession has no
    // cwd of its own); createLogin falls back to the app cwd when none is known.
    const cwd = s.terminals[0]?.cwd
    const info = this.terminals.createLogin(undefined, cwd, s.id)
    s.terminals.push({
      id: info.id,
      name: info.name,
      cwd: info.cwd,
      lastState: info.state as TerminalRef["lastState"],
      engine: info.engine,
      model: info.model,
      // CAPP-39 gate ② — mark the ref so it is excluded from idle-flush/broadcast
      // and stripped from the persisted JSON (never auto-restored as a ghost tab).
      isLogin: info.isLogin === true ? true : undefined,
    })
    s.status = "active"
    this.logEvent(s, "spawn", `Opened sign-in terminal "${info.name}"`, info.id)
    this.persist(s)
    this.emit("worksession:updated", this.withEffectiveActivity(s))
    return { terminalId: info.id }
  }

  /** Shared spawn path: create an identity-bound PTY, register a ref, persist + emit. */
  private spawnInto(s: WorkSession, cwd?: string): string {
    if (!this.terminals) throw new Error("terminals not attached")
    // Pass the work-session id so the PTY connects with an identity-bound MCP
    // config — the spawned Claude inherits context via SERVER_INSTRUCTIONS
    // (no visible seed paste) and its work-session tools default to its own ids.
    const info = this.terminals.create(undefined, cwd, s.id)
    // BO-4b: record the actual engine, and honor the spawn's own state (structured
    // terminals park idle on spawn — they're waiting for the first message — while
    // xterm spawns active). Source of truth is the spawn, not a hardcoded "active".
    s.terminals.push({ id: info.id, name: info.name, cwd: info.cwd, lastState: info.state as TerminalRef["lastState"], engine: info.engine, model: info.model })
    s.status = "active"
    this.logEvent(s, "spawn", `Spawned terminal "${info.name}"`, info.id)
    this.persist(s)
    this.emit("worksession:updated", this.withEffectiveActivity(s))
    return info.id
  }

  /** Close a terminal: kill its PTY, drop the ref, keep the session alive (empty-but-live). */
  closeTerminal(sessionId: string, terminalId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const closed = s.terminals.find((t) => t.id === terminalId)
    this.terminals?.kill(terminalId)
    s.terminals = s.terminals.filter((t) => t.id !== terminalId)
    s.status = s.terminals.some((t) => t.lastState === "active" || t.lastState === "idle") ? "active" : "stopped"
    if (closed) this.logEvent(s, "retire", `Closed terminal "${closed.name}"`, terminalId)
    this.persist(s)
    this.emit("worksession:updated", this.withEffectiveActivity(s))
  }

  /** Kill the whole session: every PTY + the on-disk record. */
  killSession(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    for (const t of s.terminals) this.terminals?.kill(t.id)
    this.sessions.delete(sessionId)
    this.summaryDirty.delete(sessionId)
    this.lastFlushAt.delete(sessionId)
    try { unlinkSync(join(this.dir, `${sessionId}.json`)) } catch { /* already gone */ }
    this.emit("worksession:removed", sessionId)
  }

  /** @internal test accessor */ __test_summaryDirtyHas(id: string): boolean { return this.summaryDirty.has(id) }
  /** @internal test accessor */ __test_lastFlushAtHas(id: string): boolean { return this.lastFlushAt.has(id) }
  /** @internal test accessor */ __test_setLastFlushAt(id: string): void { this.lastFlushAt.set(id, this.now()) }

  /**
   * Retire & continue: force an immediate summary flush on the active terminal,
   * spawn a fresh primed terminal in the same session, and mark the old one dead.
   * The fresh terminal inherits everything via get_session_context on entry.
   */
  handoffTerminal(sessionId: string, terminalId: string): { terminalId: string } | undefined {
    const s = this.sessions.get(sessionId)
    if (!s || !this.terminals) return undefined
    const old = s.terminals.find((t) => t.id === terminalId)
    if (!old) return undefined

    // BO-5: a structured (headless) terminal has no interactive PTY and no
    // `/handoff` slash command — branch the whole retire-&-continue onto the
    // structured primitives. Detect once, before we kill anything.
    const structured = this.terminals.isHeadless(terminalId)

    // CAPP-39 gate ② — a login terminal is the live interactive OAuth prompt, not an
    // agent: NEVER inject the summary-refresh prompt into it (the bracketed paste
    // would corrupt the sign-in flow). Detect once, alongside the engine branch.
    const login = old.isLogin === true || this.terminals.isLogin(terminalId)

    // CAPP-54 gate ② (re-review FIX B) — REFUSE handoff on a login terminal. The old
    // path only skipped the summary-flush but still killed the live `claude /login`
    // PTY and spawned a normal agent replacement — silently discarding an in-progress
    // sign-in. There is no "retire & continue" semantics for an OAuth prompt: no-op.
    if (login) return undefined

    // Force a summary flush now if dirty (bypass debounce — explicit user intent).
    if (this.summaryDirty.has(sessionId)) {
      this.summaryDirty.delete(sessionId)
      this.lastFlushAt.set(sessionId, this.now())
      const prompt =
        "You're being retired. Fold all findings into the session summary NOW via " +
        "set_session_summary, then stop."
      // Structured: route the flush request to the stdin sink as a clean user
      // message (TerminalService.write strips the PTY bracketed-paste idiom for
      // headless terminals). Legacy xterm: keep the bracketed-paste keystroke.
      this.terminals.write(terminalId, structured ? prompt : `\x1b[200~${prompt}\x1b[201~\r`)
    }

    // Spawn the replacement in the SAME engine as the retired terminal, so the
    // user's mode is preserved; it inherits state via get_session_context on entry.
    // BO-6: a structured replacement also inherits the retired terminal's `--model`;
    // CAPP-46: and its `--effort` level (undefined → the replacement omits `--effort`).
    const info = structured
      ? this.terminals.createHeadless(undefined, old.cwd, s.id, undefined, undefined, old.model, old.effort)
      : this.terminals.create(undefined, old.cwd, s.id)
    s.terminals.push({ id: info.id, name: info.name, cwd: info.cwd, lastState: info.state as TerminalRef["lastState"], engine: info.engine, model: info.model, effort: info.effort })
    this.terminals.kill(terminalId)
    old.lastState = "dead"
    s.status = "active"
    this.logEvent(s, "handoff", `Handoff: retired "${old.name}", continued in "${info.name}"`, info.id)
    this.persist(s)
    this.emit("worksession:updated", this.withEffectiveActivity(s))
    return { terminalId: info.id }
  }

  /** Reopen a dead/stale terminal ref with a fresh primed PTY (3a: fresh, not --resume). */
  reopenTerminal(sessionId: string, terminalId: string): { terminalId: string } | undefined {
    const s = this.sessions.get(sessionId)
    if (!s || !this.terminals) return undefined
    const ref = s.terminals.find((t) => t.id === terminalId)
    if (!ref) return undefined
    // CAPP-39 gate ② — NEVER auto-restore the one-time `claude /login` terminal as a
    // normal agent terminal (or re-run /login): it's a spent affordance. It is
    // stripped from the persisted JSON, so this is a defensive guard for any legacy/
    // in-memory login ref that reaches here.
    if (ref.isLogin) return undefined
    // BO-6: re-pass the persisted `model` so the user's chosen model survives an
    // app restart. On the structured path it rides through to `--model` on the
    // resume spawn (overriding the transcript's saved-model pin — the core fix);
    // the xterm path ignores it. CAPP-46: re-pass the persisted `effort` the same
    // way (undefined → the resume spawn omits `--effort`, byte-unchanged default).
    const info = this.terminals.create(ref.name, ref.cwd, s.id, ref.ccConversationId, ref.model, ref.effort)
    ref.id = info.id
    // BO-4b: reopen re-derives the engine (create() routes to the headless path
    // when the engine config is structured) and honors the spawn's state, so a
    // reopened structured terminal lands idle-awaiting-input, not falsely active.
    ref.lastState = info.state as TerminalRef["lastState"]
    ref.engine = info.engine
    ref.model = info.model
    ref.effort = info.effort
    s.status = "active"
    this.persist(s)
    this.emit("worksession:updated", this.withEffectiveActivity(s))
    return { terminalId: info.id }
  }

  /**
   * BO-6 — switch a STRUCTURED terminal's `--model` (the in-app picker). Headless
   * `claude -p` has NO in-protocol model change (slash commands are N/A), so the
   * only mechanism is to RESPAWN: kill the proc and spawn a fresh one that resumes
   * the SAME conversation (`--resume <ccConversationId>`) with the new `--model`.
   * `--model` overrides the transcript's saved-model pin (proven live), so the
   * chat history carries over while the new model takes effect. The choice is
   * persisted on the ref so it survives a later restart (reopenTerminal re-passes
   * it). No-op (undefined) for an unknown session/terminal or an xterm terminal
   * (the legacy path has no `--model` knob). Kill BEFORE respawn so two procs never
   * hold the same transcript at once.
   */
  setTerminalModel(sessionId: string, terminalId: string, model: string): { terminalId: string } | undefined {
    const s = this.sessions.get(sessionId)
    if (!s || !this.terminals) return undefined
    const ref = s.terminals.find((t) => t.id === terminalId)
    if (!ref) return undefined
    if (typeof model !== "string" || !model.trim()) return undefined
    // Only structured terminals carry a `--model`; an xterm PTY has no such knob.
    const structured = this.terminals.isHeadless(terminalId) || ref.engine === "structured"
    if (!structured) return undefined

    // CAPP-46: a model switch PRESERVES the terminal's current effort level (pass
    // ref.effort) — one respawn primitive serves both the model and effort switches.
    const info = this.respawnHeadlessRef(s, ref, model.trim(), ref.effort)
    this.logEvent(s, "spawn", `Model → ${info.model ?? model.trim()} (respawned "${ref.name}")`, info.id)
    this.persist(s)
    this.emit("worksession:updated", this.withEffectiveActivity(s))
    return { terminalId: info.id }
  }

  /**
   * CAPP-46 — switch a STRUCTURED terminal's reasoning `--effort` level (the in-app
   * picker). Mirrors {@link setTerminalModel}: headless `claude -p` has no
   * in-protocol effort change, so the only mechanism is to RESPAWN — kill the proc
   * and spawn a fresh one that resumes the SAME conversation
   * (`--resume <ccConversationId>`) with the new `--effort` (the chat history carries
   * over via resume). `--effort` has no resume-pin bug, so a blank value is allowed
   * and CLEARS the level (the respawn then OMITS `--effort`, back to the default).
   * The choice is persisted on the ref so it survives a later restart (reopenTerminal
   * re-passes it). No-op (undefined) for an unknown session/terminal or an xterm
   * terminal (the legacy path has no `--effort` knob). Kill BEFORE respawn so two
   * procs never hold the same transcript at once.
   */
  setTerminalEffort(sessionId: string, terminalId: string, effort: string): { terminalId: string } | undefined {
    const s = this.sessions.get(sessionId)
    if (!s || !this.terminals) return undefined
    const ref = s.terminals.find((t) => t.id === terminalId)
    if (!ref) return undefined
    // Only structured terminals carry an `--effort`; an xterm PTY has no such knob.
    const structured = this.terminals.isHeadless(terminalId) || ref.engine === "structured"
    if (!structured) return undefined

    // A blank/undefined effort clears the level (respawn omits `--effort`). The
    // respawn PRESERVES the terminal's current model (pass ref.model).
    const next = typeof effort === "string" && effort.trim() ? effort.trim() : undefined
    const info = this.respawnHeadlessRef(s, ref, ref.model, next)
    this.logEvent(s, "spawn", `Effort → ${info.effort ?? "default"} (respawned "${ref.name}")`, info.id)
    this.persist(s)
    this.emit("worksession:updated", this.withEffectiveActivity(s))
    return { terminalId: info.id }
  }

  /**
   * BO-10/BO-11 — the handbrake. STOP a structured terminal that is generating or
   * parked on a permission prompt: respawn it on the SAME conversation via
   * `--resume <ccConversationId>` (the app-restart restore path). `claude -p`
   * stream-json has NO in-protocol cancel (anthropics/claude-code #41665, #51078),
   * so kill + resume is the only mechanism — the conversation survives, only the
   * aborted turn is dropped.
   *
   * BO-11 (CAPP-50, the safety fix): a bare kill leaves a turn that was parked on a
   * permission HALF-OPEN in the on-disk transcript (a tool_use with no tool_result),
   * and the `--resume` proc then re-attempts the tool on the next user message —
   * unwanted file writes with no instruction. So when {@link TerminalLike.hasPendingPermission}
   * is true, we FIRST settle the parked permission as an abort DENY through the LIVE
   * proc and drain the turn to its `result` ({@link TerminalLike.abortPendingPermissionAndDrain}),
   * CLOSING it on disk, THEN kill+resume. The agent lands idle on a clean transcript
   * (proven live: docs/spikes/bo11-stop-abort.md). A pure generating turn (no pending
   * permission) has no half-open tool_use, so it goes straight to kill+resume.
   *
   * Takes only the terminal id (the renderer's Esc/Stop both have the active
   * terminal id); the owning session is resolved here. Mints a NEW terminal id
   * (like the model-switch / handoff respawns) — the caller re-points the active
   * selection. No-op (undefined) for an unknown terminal or an xterm one (a PTY's
   * Escape is load-bearing and must be left untouched).
   */
  async interruptAgent(terminalId: string): Promise<{ terminalId: string } | undefined> {
    if (!this.terminals) return undefined
    const s = this.sessionOf(terminalId)
    if (!s) return undefined
    const ref = s.terminals.find((t) => t.id === terminalId)
    if (!ref) return undefined
    const structured = this.terminals.isHeadless(terminalId) || ref.engine === "structured"
    if (!structured) return undefined

    // SINGLE-FLIGHT: two overlapping Stops on the SAME terminal (Esc then the Stop
    // button, or rapid Esc) would each run the drain AND each respawn → a double
    // respawn and a caller re-pointing the active selection at a dead intermediate id.
    // A second interrupt while one is in flight for this terminal is a no-op; the first
    // owns the respawn + re-point. Keyed on the param id (stable across the respawn that
    // mutates ref.id).
    if (this.interrupting.has(terminalId)) return undefined
    this.interrupting.add(terminalId)
    try {
      // BO-11 — close a permission-parked turn THROUGH the live proc before killing, so
      // `--resume` can't replay a half-open tool_use. No-op/instant for a generating turn.
      if (this.terminals.hasPendingPermission(ref.id)) {
        await this.terminals.abortPendingPermissionAndDrain(ref.id, INTERRUPT_ABORT_MESSAGE)
      }

      // RE-ENTRANCY GUARD: the drain await can span up to its guard timeout, during
      // which a racing killSession (deletes the session + unlinks its JSON) or
      // closeTerminal (drops the ref + kills the proc) can tear this terminal down.
      // Respawning on the now-orphaned s/ref would spawn a LEAKED, untracked claude -p,
      // re-write the JSON killSession just deleted (a zombie file), and re-add the
      // killed sidebar row — all while the session is no longer in this.sessions, so the
      // proc is unrecoverable. Re-validate before respawn/persist/emit: the session must
      // still be tracked, the ref still in it, and the proc still alive.
      const tornDown =
        !this.sessions.has(s.id) ||
        !s.terminals.some((t) => t.id === ref.id) ||
        !this.terminals.isHeadless(ref.id)
      if (tornDown) return undefined

      // CAPP-46: an interrupt preserves BOTH the current model AND effort level.
      const info = this.respawnHeadlessRef(s, ref, ref.model, ref.effort)
      this.logEvent(
        s,
        "spawn",
        `Interrupted "${ref.name}" — stopped the active turn, resumed the conversation`,
        info.id,
      )
      this.persist(s)
      this.emit("worksession:updated", this.withEffectiveActivity(s))
      return { terminalId: info.id }
    } finally {
      this.interrupting.delete(terminalId)
    }
  }

  /**
   * BO-6/BO-10/CAPP-46 — the shared structured-respawn primitive (kill → resume the
   * SAME conversation → re-point the ref in place). Captures the convo id BEFORE the
   * kill so the replacement `--resume`s it; `model` pins `--model` (the picker's new
   * model, or the current one for an interrupt/effort-switch); `effort` pins
   * `--effort` (the picker's new level, or the current one for an interrupt/model-
   * switch; undefined OMITS `--effort`). Kill BEFORE createHeadless so two procs
   * never hold the same transcript at once. Returns the spawn info; the caller logs
   * + persists + emits (the log text differs per caller).
   *
   * Thin wrapper over {@link respawnRefWithEngine} that targets the STRUCTURED
   * engine — the existing model-switch / interrupt callers, plus the effort switch.
   */
  private respawnHeadlessRef(
    s: WorkSession,
    ref: TerminalRef,
    model: string | undefined,
    effort: string | undefined,
  ): { id: string; name: string; cwd: string; state: string; engine?: RenderingEngine; model?: string; effort?: string } {
    return this.respawnRefWithEngine(s, ref, "structured", model, effort)
  }

  /**
   * CAPP-39 gate ③ — the generalized respawn primitive: kill the proc, then spawn a
   * fresh one that RESUMES the SAME conversation (`--resume <ccConversationId>`) on
   * `targetEngine`, re-pointing the ref IN PLACE. Used by the model-switch / interrupt
   * (structured) AND the raw-view escape hatch (structured↔xterm). Kill BEFORE the new
   * spawn so two procs never hold the same transcript at once.
   *
   * Branch:
   *  - "structured" → `createHeadless(...)` with `model` (the existing path).
   *  - "xterm"      → `createXterm(...)` — an interactive PTY spawned INDEPENDENT of the
   *                   global engine (modeled on createLogin), resuming the same convo.
   *
   * MODEL/EFFORT PRESERVATION: an xterm spawn returns no model/effort, so we DO NOT
   * clobber `ref.model`/`ref.effort` on the xterm branch — the structured model+effort
   * are parked on the ref so a later structured→xterm→structured round-trip restores
   * them. The structured branch adopts the spawn's resolved model AND effort (even an
   * undefined effort, which is a legitimate "cleared" value), so an effort-clear
   * actually takes.
   */
  private respawnRefWithEngine(
    s: WorkSession,
    ref: TerminalRef,
    targetEngine: RenderingEngine,
    model: string | undefined,
    effort: string | undefined,
  ): { id: string; name: string; cwd: string; state: string; engine?: RenderingEngine; model?: string; effort?: string } {
    const cc = ref.ccConversationId
    this.terminals!.kill(ref.id)
    const info =
      targetEngine === "structured"
        ? this.terminals!.createHeadless(ref.name, ref.cwd, s.id, cc, undefined, model, effort)
        : this.terminals!.createXterm(ref.name, ref.cwd, s.id, cc, model, effort)
    ref.id = info.id
    ref.lastState = info.state as TerminalRef["lastState"]
    ref.engine = info.engine
    // PRESERVE the last structured model+effort across an xterm round-trip: an xterm
    // spawn carries no model/effort (createXterm ignores them), so adopting them would
    // null out the user's choices and a later switch back to structured would lose them.
    // Keep ref.model unless the spawn supplied one (the structured path always does).
    if (info.model != null) ref.model = info.model
    // Effort can legitimately be undefined (a "cleared" level) on the structured path,
    // so adopt info.effort verbatim there; the xterm path leaves ref.effort untouched.
    if (targetEngine === "structured") ref.effort = info.effort
    s.status = "active"
    return info
  }

  /**
   * CAPP-39 gate ③ — the per-terminal RAW-VIEW ESCAPE HATCH. Toggle a single terminal
   * between the structured (headless stream-json) engine and the legacy xterm/PTY
   * engine at RUNTIME, RESUMING the same Claude Code conversation across the swap (only
   * the transport changes, the chat survives). This is decision-independent of the
   * global default flip (gate ④): the global engine + setEngine are NOT touched here.
   *
   * Mechanism mirrors the model switch / interrupt: there is no in-protocol transport
   * change, so we RESPAWN — kill the proc, spawn a fresh one resuming the SAME convo on
   * the other engine ({@link respawnRefWithEngine}), and re-point the ref IN PLACE
   * (mints a NEW terminal id; the caller re-points the active selection). The new id +
   * preserved ccConversationId let the split-pane reconcile (useSplitView) re-point a
   * switched terminal in a split slot automatically.
   *
   * REFUSALS (return undefined, no spawn, no kill):
   *  - unknown session/terminal, or invalid targetEngine.
   *  - already on targetEngine — a no-op (don't pointlessly respawn).
   *  - a LOGIN terminal — the ephemeral `claude /login` PTY is not an agent terminal.
   *  - NO ccConversationId yet (brand-new structured terminal whose first turn hasn't
   *    completed) — switching would start a FRESH conversation (lost context), so refuse
   *    until the first turn captures a convo id.
   *  - BUSY — generating a turn or parked on a permission ({@link TerminalLike.isBusy}).
   *    Killing a live turn to swap transports would lose it exactly like a naive Stop;
   *    gate ③ refuses-while-busy (Stop first, then switch) rather than draining.
   *
   * Single-flight + post-await re-validation are NOT needed here (no async work between
   * the busy check and the synchronous kill+respawn), but we DO guard against an
   * unattached terminals seam.
   */
  setTerminalEngine(
    sessionId: string,
    terminalId: string,
    targetEngine: RenderingEngine,
  ): { terminalId: string } | undefined {
    const s = this.sessions.get(sessionId)
    if (!s || !this.terminals) return undefined
    const ref = s.terminals.find((t) => t.id === terminalId)
    if (!ref) return undefined
    if (targetEngine !== "structured" && targetEngine !== "xterm") return undefined
    // REFUSE a login terminal — it's the live OAuth prompt, not an agent terminal.
    if (ref.isLogin === true || this.terminals.isLogin(terminalId)) return undefined

    // The terminal's CURRENT engine: prefer the live registry truth, fall back to the
    // persisted ref, default xterm (a legacy/undefined ref is xterm).
    const current: RenderingEngine = this.terminals.isHeadless(terminalId)
      ? "structured"
      : ref.engine === "structured"
        ? "structured"
        : "xterm"
    // Already on the target → no-op (return the same id so the caller's re-point is inert).
    if (current === targetEngine) return { terminalId: ref.id }

    // REFUSE without a captured conversation id — switching would orphan the chat and
    // start a fresh one (lost context). Wait until the first turn completes.
    if (!ref.ccConversationId) return undefined

    // REFUSE while busy (generating / awaiting a permission) — Stop first, then switch.
    if (this.terminals.isBusy(terminalId)) return undefined

    // CAPP-46: carry the current effort across the engine swap (preserved on the
    // xterm side, re-applied on the structured side) so a round-trip restores it.
    const info = this.respawnRefWithEngine(s, ref, targetEngine, ref.model, ref.effort)
    this.logEvent(
      s,
      "spawn",
      `Engine → ${targetEngine === "structured" ? "structured view" : "raw terminal"} (respawned "${ref.name}")`,
      info.id,
    )
    this.persist(s)
    this.emit("worksession:updated", this.withEffectiveActivity(s))
    return { terminalId: info.id }
  }


  create(): WorkSession {
    const t = this.now()
    // WS-C — stamp the active workspace at mint time so the session is scoped to
    // it (default = active workspace id). When no workspace is active ("All"
    // mode), leave `workspaceId` UNSET (undefined → the "All" bucket): the field
    // is additive/optional, so an untagged session persists + reloads cleanly and
    // is byte-identical to the pre-WS-C shape.
    const activeWorkspaceId = this.getActiveWorkspaceId() ?? undefined
    const s: WorkSession = {
      id: `session-${t}-${Math.random().toString(36).slice(2, 8)}`,
      name: "Untitled session",
      status: "active",
      ...(activeWorkspaceId ? { workspaceId: activeWorkspaceId } : {}),
      summary: "",
      notes: [],
      provisionalFindings: [],
      terminals: [],
      createdAt: t,
      updatedAt: t,
    }
    this.sessions.set(s.id, s)
    this.persist(s)
    return s
  }

  get(id: string): WorkSession | undefined { return this.sessions.get(id) }
  list(): WorkSession[] { return [...this.sessions.values()] }

  /** Lookup by id; with no id, the most-recently-updated *active* session (resume entry point). */
  status(id?: string): WorkSession | undefined {
    if (id) return this.sessions.get(id)
    return [...this.sessions.values()]
      .filter((s) => s.status === "active")
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  }

  load(): void {
    let files: string[]
    try {
      files = readdirSync(this.dir)
    } catch (err) {
      // ENOENT = sessions dir not created yet (expected on first run); stay
      // silent. Any other failure means we're silently dropping persisted
      // sessions — surface it.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logWarn("sessions", `could not read sessions dir, no sessions restored: ${err}`)
      }
      return
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue
      // loadVersioned read-repairs a legacy (envelope-less) file to v1 and warns
      // (instead of silently swallowing) on corrupt JSON, returning undefined.
      const s = loadVersioned<WorkSession>(join(this.dir, f), SCHEMA_VERSION, MIGRATIONS)
      if (!s) continue // missing/corrupt — skip
      // Lazy spawn: no PTYs are live at boot, so every persisted terminal ref
      // is cold until reopened. Reflect that honestly instead of showing the
      // stale "active"/"idle" state from when the app last closed.
      for (const t of s.terminals) t.lastState = "dead"
      s.status = "stopped"
      this.sessions.set(s.id, s)
    }
  }

  /**
   * Re-read every persisted session file from disk into the in-memory map and emit
   * a `worksession:updated` for each, WITHOUT touching live terminal/PTY state.
   * Used after a LocalHistory restore (CAPP-95 / D1) overwrites a session JSON
   * out-of-band: the durable container fields (summary, notes/findings, name) are
   * refreshed from disk so the recovered state is reflected in-memory, in the recall
   * index, and in the renderer. Unlike `load()` (boot-time, marks all terminals
   * dead) this preserves the running terminals' lastState — a restore is a recovery
   * op, not a cold start. A session file the restore DELETED is left in the map (we
   * don't reconcile removals here — recovery is additive); a fresh restore of an
   * older snapshot re-adds it.
   */
  reloadFromDisk(): void {
    let files: string[]
    try {
      files = readdirSync(this.dir)
    } catch {
      return // dir absent → nothing to reload
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue
      const loaded = loadVersioned<WorkSession>(join(this.dir, f), SCHEMA_VERSION, MIGRATIONS)
      if (!loaded) continue
      const existing = this.sessions.get(loaded.id)
      if (existing) {
        // Preserve the LIVE terminal runtime state (PTYs are owned by
        // TerminalService); refresh only the durable container fields from disk.
        const liveStates = new Map(existing.terminals.map((t) => [t.id, t.lastState]))
        for (const t of loaded.terminals) {
          const live = liveStates.get(t.id)
          if (live) t.lastState = live
        }
        // Keep the live status (the on-disk one was a snapshot of an old runtime).
        loaded.status = existing.status
      }
      this.sessions.set(loaded.id, loaded)
      this.emit("worksession:updated", this.withEffectiveActivity(loaded))
    }
  }

  addTerminal(sessionId: string, ref: TerminalRef): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    if (!s.terminals.some((t) => t.id === ref.id)) s.terminals.push(ref)
    this.persist(s)
  }

  removeTerminal(sessionId: string, terminalId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.terminals = s.terminals.filter((t) => t.id !== terminalId)
    this.persist(s)
  }

  nameTerminal(sessionId: string, terminalId: string, name: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const t = s.terminals.find((x) => x.id === terminalId)
    if (!t) return
    t.name = name
    // Session inherits its name from the FIRST terminal while still a placeholder.
    if (s.name === "Untitled session" && s.terminals[0]?.id === terminalId) s.name = name
    this.persist(s)
  }

  /**
   * CAPP-82 — rename the durable work-session CONTAINER (the sidebar row), distinct
   * from `nameTerminal` which renames a terminal ref inside it. Guards blank /
   * whitespace-only input (returns false, name untouched — the renderer reverts to
   * the prior name) and trims; persists + emits the same `worksession:updated`
   * snapshot every other container mutation does, so the sidebar updates reactively.
   */
  renameSession(id: string, newName: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    const trimmed = newName.trim()
    if (!trimmed) return false
    s.name = trimmed
    this.persist(s)
    this.emit("worksession:updated", this.withEffectiveActivity(s))
    return true
  }

  private readonly activityStaleMs = 20_000

  /**
   * The activity line to display for a terminal: the self-reported phrase when
   * it's fresh, otherwise the latest parsed CC tool-call line while the terminal
   * is still active (so a heads-down terminal never looks frozen).
   */
  effectiveActivity(sessionId: string, terminalId: string): string | undefined {
    const s = this.sessions.get(sessionId)
    const t = s?.terminals.find((x) => x.id === terminalId)
    if (!t) return undefined
    const fresh = t.activity && this.now() - (t.activityAt ?? 0) < this.activityStaleMs
    if (fresh) return t.activity
    if (t.lastState === "active" && this.terminals) {
      const parsed = parseActivityLine(this.terminals.getOutput(terminalId, 4000) ?? "")
      if (parsed) return parsed
    }
    return t.activity // last-known (may be stale) if nothing parsed
  }

  /** A copy of the session with each terminal's activity resolved for display. */
  private withEffectiveActivity(s: WorkSession): WorkSession {
    return {
      ...s,
      terminals: s.terminals.map((t) => ({ ...t, activity: this.effectiveActivity(s.id, t.id) })),
    }
  }

  setTerminalActivity(sessionId: string, terminalId: string, activity: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const t = s.terminals.find((x) => x.id === terminalId)
    if (!t) return
    t.activity = activity
    t.activityAt = this.now()
    this.persist(s)
    // CAPP-84 — push so the renderer (Agent Rail NOW line / sidebar activity) reflects a
    // self-reported activity LIVE. Without this emit the write persisted but the renderer
    // stayed stale until an unrelated push (every other mutator already emits this).
    this.emit("worksession:updated", this.withEffectiveActivity(s))
  }

  setTerminalState(sessionId: string, terminalId: string, state: "active" | "idle" | "dead"): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const t = s.terminals.find((x) => x.id === terminalId)
    if (!t) return
    t.lastState = state
    this.persist(s)
  }

  setStatus(sessionId: string, status: "active" | "stopped"): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.status = status
    this.persist(s)
  }

  /** Human-readable session label derived from status + terminal states. */
  deriveStatus(sessionId: string): string {
    const s = this.sessions.get(sessionId)
    if (!s) return "Stopped"
    if (s.terminals.length === 0) return "Empty"
    if (s.status === "stopped") return "Stopped"
    const active = s.terminals.filter((t) => t.lastState === "active").length
    if (active > 0) return `${active} Terminal${active === 1 ? "" : "s"} Working`
    return "Idle"
  }

  addNote(sessionId: string, text: string, opts: { corrects?: string } = {}): Note | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    const note: Note = {
      id: `note-${this.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text,
      createdAt: this.now(),
      source: "self",
      status: "active",
    }
    let correctsTarget: Note | undefined
    if (opts.corrects) {
      const target = s.notes.find((n) => n.id === opts.corrects)
      if (target) {
        target.status = "superseded"
        target.supersededBy = note.id
        correctsTarget = target
      }
    }
    s.notes.push(note)
    this.summaryDirty.add(sessionId)
    if (correctsTarget) this.logEvent(s, "correction", `Corrected an earlier note: ${text}`)
    else this.logEvent(s, "note", `Note: ${text}`)
    this.persist(s)
    // CAPP-86 — push so cross-session recall (RecallService) + the Rail KNOWS digest
    // refresh LIVE when a finding lands. Verified-missing before The Lexicon: addNote
    // persisted but did NOT emit (same bug class fixed for setTerminalActivity).
    this.emit("worksession:updated", this.withEffectiveActivity(s))
    return note
  }

  setSummary(sessionId: string, summary: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.summary = summary
    this.summaryDirty.delete(sessionId)
    this.logEvent(s, "summary", "Summary refreshed")
    this.persist(s)
    // CAPP-86 — push so cross-session recall (RecallService) + the Rail KNOWS digest
    // refresh LIVE when the summary changes. Verified-missing before The Lexicon:
    // setSummary persisted but did NOT emit (same bug class as addNote above).
    this.emit("worksession:updated", this.withEffectiveActivity(s))
  }

  getOverview(sessionId: string): SessionOverview | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    const ruledOut = s.notes
      .filter((n) => n.status === "superseded")
      .map((n) => ({
        id: n.id,
        text: n.text,
        correction: s.notes.find((c) => c.id === n.supersededBy)?.text,
      }))
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      summary: s.summary,
      notes: s.notes.filter((n) => n.status === "active"),
      ruledOut,
      provisionalFindings: s.provisionalFindings,
      terminals: s.terminals.map((t) => ({ ...t, activity: this.effectiveActivity(s.id, t.id) })),
    }
  }

  /**
   * Map a session's confirmed `notes` (CAPP-87 / U2) into `PromoteEntry[]` — the
   * candidate list the workspace-memory promote path (U1's `promoteFindings`)
   * consumes. Carries BOTH active AND ruled-out (superseded) notes: ruled-out
   * findings are the highest-value rescue, so they are promotable too.
   *
   * Active-vs-superseded and the corrector linkage are determined EXACTLY the way
   * {@link SessionService.getOverview} / {@link SessionService.getContext} already
   * do it — off the note's `status` field (`getOverview` filters ruled-out by
   * `n.status === "superseded"`), and `supersededBy` is the SESSION note id of the
   * corrector (the same value `getOverview` resolves a correction text from). We
   * pass that origin note id straight through: U1's `promoteFindings` rewrites the
   * supersede graph over the freshly-minted workspace twin ids, so it needs the
   * corrector's ORIGIN note id here, NOT a workspace id.
   *
   * `provisionalFindings` (the observer seam — unconfirmed) are EXCLUDED in v1:
   * only confirmed `notes` are promotable.
   *
   * Unknown `sessionId` → `[]`.
   */
  getPromotableFindings(sessionId: string): PromoteEntry[] {
    const s = this.sessions.get(sessionId)
    if (!s) return []
    return s.notes.map((n) => ({
      text: n.text,
      originSessionId: sessionId,
      originNoteId: n.id,
      createdAt: n.createdAt,
      // status carried verbatim — "superseded" === ruled-out (getOverview:1167-1168).
      status: n.status,
      // corrector linkage: n.supersededBy is the corrector's ORIGIN note id
      // (getOverview:1172 / getContext:1202 resolve the correction off this id).
      ...(n.supersededBy != null ? { supersededBy: n.supersededBy } : {}),
      source: n.source,
    }))
  }

  /** The single promote candidate matching `noteId` (by `originNoteId === noteId`),
   *  or undefined if the session/note isn't found. See {@link getPromotableFindings}. */
  getPromotableFinding(sessionId: string, noteId: string): PromoteEntry | undefined {
    return this.getPromotableFindings(sessionId).find((e) => e.originNoteId === noteId)
  }

  /**
   * CAPP-96 — the SHARED, pure session-context sections both `getContext` (the pull
   * tool) and the auto-load builder ({@link buildSessionTier}) read, so the two can
   * never drift. Returns the session name + the three durable sections — summary,
   * active findings, ruled-out/corrected — as a structured object (NOT the rendered
   * string), so the auto-load builder can value-order + length-cap them independently
   * before rendering while the primer renders them exactly as before.
   *
   * DELIBERATELY EXCLUDES the `## Related from other sessions` cross-session recall
   * block — that's firehose-adjacent and stays pull-only (`getContext` appends it
   * separately under its config gate). Unknown sessionId → undefined.
   */
  getSessionContextSections(sessionId: string):
    | {
        name: string
        summary: string
        active: { text: string }[]
        ruledOut: { text: string; correction?: string }[]
      }
    | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    const active = s.notes.filter((n) => n.status === "active").map((n) => ({ text: n.text }))
    const ruledOut = s.notes
      .filter((n) => n.status === "superseded")
      .map((n) => {
        const correction = s.notes.find((c) => c.id === n.supersededBy)
        return correction ? { text: n.text, correction: correction.text } : { text: n.text }
      })
    return { name: s.name, summary: s.summary.trim(), active, ruledOut }
  }

  /** The primer a terminal pulls: summary, then active notes, then ruled-out (with corrections). */
  getContext(sessionId: string): string | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    const sections = this.getSessionContextSections(sessionId)!
    const parts: string[] = []
    parts.push(`# Session: ${sections.name}`)
    if (sections.summary) parts.push(`## Summary\n${sections.summary}`)

    if (sections.active.length) {
      parts.push(`## Findings\n` + sections.active.map((n) => `- ${n.text}`).join("\n"))
    }

    if (sections.ruledOut.length) {
      const lines = sections.ruledOut.map((n) =>
        n.correction ? `- ~~${n.text}~~ → ${n.correction}` : `- ~~${n.text}~~`,
      )
      parts.push(`## Ruled out / corrected\n` + lines.join("\n"))
    }

    // CAPP-86 — GATED primer enrichment (default OFF → byte-identical primer). When
    // the owner has opted in (config.context.primerRecall) AND a recall seam is
    // wired, append a capped "## Related from other sessions" block of cross-session
    // hits keyed off this session's name + summary, so a fresh terminal inherits
    // relevant knowledge from OTHER sessions. Ruled-out hits keep the same
    // `~~old~~ → new` correction-arrow rendering as the section above.
    if (this.recallRelated && this.primerRecallEnabled()) {
      const query = `${s.name} ${s.summary}`.trim()
      if (query) {
        const related = this.recallRelated({
          sessionId: s.id,
          workspaceId: s.workspaceId,
          query,
          limit: 3,
        })
        if (related.length) {
          const lines = related.map((r) => {
            const text =
              r.status === "ruled-out"
                ? r.correction
                  ? `~~${r.text}~~ → ${r.correction}`
                  : `~~${r.text}~~`
                : r.text
            return `- ${text} _(from "${r.sessionName}")_`
          })
          parts.push(`## Related from other sessions\n` + lines.join("\n"))
        }
      }
    }

    return parts.join("\n\n")
  }

  /**
   * Append one terse entry to a session's durable life-history (ST-1). Does NOT
   * persist on its own — callers already route through persist() right after the
   * mutation the event describes, so the event rides along on that same write
   * (one disk write per lifecycle action, not two). The log is capped at
   * MAX_EVENTS, dropping the oldest so a long-lived session's JSON stays bounded.
   */
  private logEvent(s: WorkSession, kind: SessionEvent["kind"], text: string, terminalId?: string): void {
    if (!s.eventLog) s.eventLog = []
    s.eventLog.push({ time: this.now(), kind, text, ...(terminalId ? { terminalId } : {}) })
    if (s.eventLog.length > MAX_EVENTS) s.eventLog.splice(0, s.eventLog.length - MAX_EVENTS)
  }

  /**
   * The session's life-history, sorted oldest→newest (ST-1). For sessions that
   * predate the event log (empty/undefined `eventLog`), BACKFILL a best-effort
   * timeline from existing durable data — the session's own creation, each note's
   * createdAt, and corrections inferred from superseded notes — so an old session
   * still shows something rather than a blank panel.
   */
  getSessionTimeline(sessionId: string): SessionEvent[] {
    const s = this.sessions.get(sessionId)
    if (!s) return []
    if (s.eventLog && s.eventLog.length > 0) {
      return [...s.eventLog].sort((a, b) => a.time - b.time)
    }
    // Backfill: reconstruct from createdAt + notes (+ corrections).
    const events: SessionEvent[] = [
      { time: s.createdAt, kind: "spawn", text: `Session "${s.name}" created` },
    ]
    for (const n of s.notes) {
      if (n.status === "superseded") {
        events.push({ time: n.createdAt, kind: "correction", text: `Corrected: ${n.text}` })
      } else {
        events.push({ time: n.createdAt, kind: "note", text: `Note: ${n.text}` })
      }
    }
    return events.sort((a, b) => a.time - b.time)
  }

  private persist(s: WorkSession): void {
    s.updatedAt = this.now()
    // CAPP-39 gate ② — NEVER persist the one-time `claude /login` terminal: it's an
    // ephemeral OAuth affordance, so it must not resurrect as a ghost "Sign in" tab
    // on the next app launch. It stays a live tab in the IN-MEMORY session (so the
    // user can complete sign-in), but is stripped from the on-disk record via a
    // shallow clone (the live `s.terminals` array is left untouched). Cheap no-op
    // for the common case (no login ref present).
    const hasLogin = s.terminals.some((t) => t.isLogin)
    const toPersist = hasLogin ? { ...s, terminals: s.terminals.filter((t) => !t.isLogin) } : s
    saveVersioned(join(this.dir, `${s.id}.json`), SCHEMA_VERSION, toPersist)
  }
}
