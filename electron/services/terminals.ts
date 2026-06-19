import * as pty from "node-pty"
import { spawn as cpSpawn } from "node:child_process"
import { randomBytes } from "crypto"
import { existsSync, writeFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"
import { tmpdir, homedir } from "os"
import { BrowserWindow } from "electron"
import { TranscriptAssigner } from "./transcripts"
import { fakeStreamProc } from "./fakeStream"
import { logWarn } from "../log"
import type { RenderingEngine } from "../config"
import type { NotificationLevel } from "./notifications"
import { LineBuffer, parseStreamLine } from "./streamEvents"
import { readTranscriptEvents } from "./transcriptHistory"
import {
  HEADLESS_FLAGS,
  DEFAULT_MODEL,
  userMessage,
  PERMISSION_PROMPT_TOOL,
  PERMISSION_REQUEST_CHANNEL,
  PERMISSION_RESOLVED_CHANNEL,
  type StreamEvent,
  type AgentUserMessage,
  type AgentCatalog,
  type PermissionRequest,
  type PermissionDecision,
} from "./streamProtocol"

/**
 * Encode an absolute cwd into the directory name Claude Code uses under
 * ~/.claude/projects/. CC replaces every path separator and the drive colon
 * with "-": "C:\\Users\\ryguy\\app" -> "C--Users-ryguy-app".
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[:/\\]/g, "-")
}

/**
 * Snapshot the transcript ids (`.jsonl` basenames) already present in
 * ~/.claude/projects/<encoded-cwd>/ right now. Captured at spawn time so we can
 * later tell which transcript THIS terminal created versus ones a sibling
 * terminal in the same cwd had already written. Returns an empty set if the
 * directory doesn't exist yet.
 */
export function listTranscriptIds(projectsRoot: string, cwd: string): Set<string> {
  const dir = join(projectsRoot, encodeProjectDir(cwd))
  try {
    return new Set(
      readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.slice(0, -".jsonl".length)),
    )
  } catch {
    return new Set()
  }
}

/**
 * Resolve the Claude Code conversation id for a terminal by finding the newest
 * transcript .jsonl in ~/.claude/projects/<encoded-cwd>/ whose mtime is at or
 * after the terminal's spawn time (minus a small skew). Returns the uuid (file
 * basename) or undefined if CC hasn't written one yet.
 *
 * `excludeIds` lists transcripts that already existed when this terminal
 * spawned — a sibling terminal in the same cwd writes into the SAME project
 * dir, so without this exclusion we could pick up its (more recently written)
 * transcript and resume the wrong conversation. Pass the snapshot from
 * listTranscriptIds() taken at spawn time so only a NEW transcript qualifies.
 *
 * `projectsRoot` is injectable for tests; production passes
 * join(homedir(), ".claude", "projects").
 */
export function resolveTranscriptId(
  projectsRoot: string,
  cwd: string,
  spawnedAt: number,
  excludeIds?: ReadonlySet<string>,
): string | undefined {
  const dir = join(projectsRoot, encodeProjectDir(cwd))
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return undefined
  }
  const skewMs = 2000
  let best: { id: string; mtime: number } | undefined
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue
    const tid = f.slice(0, -".jsonl".length)
    if (excludeIds?.has(tid)) continue
    let mtime: number
    try {
      mtime = statSync(join(dir, f)).mtimeMs
    } catch {
      continue
    }
    if (mtime < spawnedAt - skewMs) continue
    if (!best || mtime > best.mtime) best = { id: tid, mtime }
  }
  return best?.id
}

/**
 * The extra CLI args to reattach a terminal to its prior Claude Code chat:
 * ["--resume", id] when we have an id AND its transcript still exists on disk,
 * otherwise [] (spawn fresh — the always-works fallback).
 */
export function resumeArgs(
  projectsRoot: string,
  cwd: string,
  ccConversationId: string | undefined,
): string[] {
  if (!ccConversationId) return []
  const file = join(projectsRoot, encodeProjectDir(cwd), `${ccConversationId}.jsonl`)
  return existsSync(file) ? ["--resume", ccConversationId] : []
}

/**
 * BO-3 — pure merge for the "always allow <tool>" persistence (proved live:
 * `.claude/settings.local.json` `permissions.allow` is honored by Claude Code's
 * DEFAULT setting sources on the next spawn). Given the existing settings.json
 * contents (parsed object, or null/garbage) and a tool name, return the updated
 * settings object and whether anything changed. Idempotent: a tool already in the
 * allow list is a no-op. Never throws — a non-object/garbage input is replaced.
 */
export function addAllowRule(
  existing: unknown,
  toolName: string,
): { changed: boolean; next: { permissions: { allow: string[]; [k: string]: unknown }; [k: string]: unknown } } {
  const base: Record<string, unknown> =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {}
  const perms: Record<string, unknown> =
    base.permissions && typeof base.permissions === "object" && !Array.isArray(base.permissions)
      ? { ...(base.permissions as Record<string, unknown>) }
      : {}
  const allow: string[] = Array.isArray(perms.allow)
    ? (perms.allow as unknown[]).filter((x): x is string => typeof x === "string")
    : []
  const changed = toolName.length > 0 && !allow.includes(toolName)
  if (changed) allow.push(toolName)
  perms.allow = allow
  base.permissions = perms
  return { changed, next: base as { permissions: { allow: string[] } } & Record<string, unknown> }
}

/**
 * Best-effort: pull the most recent Claude Code tool-call line ("● Edit(x)")
 * from captured (ANSI-stripped) output, returning the part after the bullet.
 * Used as the activity fallback when self-narration goes stale.
 */
export function parseActivityLine(output: string): string | undefined {
  const lines = output.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*●\s+([A-Z][A-Za-z0-9]*\(.*\).*)$/)
    if (m) return m[1].trim()
  }
  return undefined
}

/**
 * BO-5 — pick a short, human-readable summary of a tool_use `input` for the
 * plain-text projection (search/export) and the sidebar activity line. Prefers a
 * recognizable primary field (file_path/command/query/…) so the projected line
 * reads like Claude Code's own `● Edit(src/App.tsx)` activity, which
 * `parseActivityLine` already recognizes; otherwise falls back to compact JSON.
 */
export function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const o = input as Record<string, unknown>
  for (const k of ["file_path", "path", "command", "query", "pattern", "url", "prompt", "name"]) {
    if (typeof o[k] === "string" && o[k]) return (o[k] as string).split("\n")[0].slice(0, 80)
  }
  try {
    const s = JSON.stringify(o)
    return s.length > 60 ? s.slice(0, 57) + "…" : s
  } catch {
    return ""
  }
}

/** BO-5 — flatten a tool_result `content` (string | block[]) to a short summary line. */
export function summarizeToolResult(content: unknown): string {
  const take = (s: string) => s.replace(/\s+/g, " ").trim()
  if (typeof content === "string") return take(content).slice(0, 200)
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const b of content) {
      if (typeof b === "string") parts.push(b)
      else if (b && typeof b === "object") {
        const o = b as Record<string, unknown>
        if (typeof o.text === "string") parts.push(o.text)
        else if (typeof o.tool_name === "string") parts.push(o.tool_name)
      }
    }
    return take(parts.join(" ")).slice(0, 200)
  }
  return ""
}

/**
 * BO-5 — project ONE structured StreamEvent (BO-1) to a plain-text fragment for
 * the search/export buffer, or null to skip it. A headless terminal produces no
 * ANSI into `outputBuffers`, so without this projection history-search and
 * `export_session_log` would be empty for structured terminals. Mirrors what a
 * user would have seen scroll past: assistant prose, `● Tool(args)` activity
 * lines (also consumed by `parseActivityLine` for the sidebar), tool-result
 * summaries, and the final turn result. Thinking/init/unknown are intentionally
 * omitted (internal / not user-facing scrollback).
 */
export function projectStreamEvent(e: StreamEvent): string | null {
  switch (e.kind) {
    case "assistant_delta":
      // Token deltas append verbatim; their own newlines form the message lines.
      return e.text || null
    case "tool_use":
      return `\n● ${e.name}(${summarizeToolInput(e.input)})\n`
    case "tool_result": {
      const s = summarizeToolResult(e.content)
      return s ? `  ⎿ ${s}\n` : null
    }
    case "result":
      return e.result ? `\n${e.result}\n` : null
    case "user_message":
      // The user's own turn, projected as a prompt line so history-search/export
      // captures both sides of the conversation.
      return e.text ? `\n> ${e.text}\n` : null
    case "init":
    case "thinking_delta":
    case "needs_auth":
    case "unknown":
      return null
  }
}

/**
 * The named patterns `detectPromptState` recognizes, kept as exported constants
 * so wrong guesses are cheap to fix and the fixture tests can reference them by
 * name. Seeded from real Claude Code idle output (per AQ-1): the input box
 * renders as a bordered line whose content is just a `>` prompt, sitting above a
 * footer line that mentions the permission/cycle hint. A busy session instead
 * shows tool-call activity lines (`● Edit(…)`, see parseActivityLine) or a
 * spinner/status line, never the bare prompt.
 */
export const PROMPT_PATTERNS = {
  /**
   * The footer line under the input box. Claude Code prints a hint like
   * "bypass permissions on (shift+tab to cycle)" beneath the prompt when it is
   * sitting idle awaiting input. Matched case-insensitively and loosely so minor
   * wording drift ("⏵⏵ bypass permissions on") still resolves.
   */
  footerHint: /bypass permissions on|shift\+tab to cycle/i,
  /**
   * The empty input box: a line whose only meaningful content is a leading `>`
   * prompt. We allow common box-drawing glyphs (│ ╭ ╮ ╰ ╯ ─ etc.) and whitespace
   * on BOTH sides — the real box renders as "│ >                    │" — so the
   * trailing border is tolerated. The remainder after the `>` must be box/space
   * only (an empty input), never typed text.
   */
  emptyPrompt: /^[\s│╭╮╰╯─┌┐└┘|]*>[\s│╭╮╰╯─┌┐└┘|]*$/,
} as const

/**
 * Pure detector: given a tail of (ANSI-stripped) terminal output captured at the
 * moment a terminal went idle, answer "is Claude Code sitting at its input prompt
 * awaiting a human reply?". A sibling of `parseActivityLine`.
 *
 * Best-effort by design (per the spec's error-handling note): a miss merely
 * degrades an `asked` attention entry into a lower-tier `finished` one — it never
 * crashes and never gates the authoritative tier-1 `blocked` path (which comes
 * from PanelService's pending-form state, not parsing).
 *
 * Heuristic: among the last handful of trailing lines, require BOTH the footer
 * hint line AND a bare `>` prompt box. Requiring both keeps mid-output `>`
 * characters (inside code, diffs, or quoted text) from triggering a false
 * positive when no prompt is actually showing.
 */
export function detectPromptState(tail: string): boolean {
  if (!tail) return false
  const lines = tail.split("\n").map((l) => l.replace(/\s+$/, ""))
  // Scan only the trailing region — the prompt box is always the last thing
  // rendered when idle. 14 lines comfortably covers the box + footer + slack.
  const window = lines.slice(-14)
  const hasFooter = window.some((l) => PROMPT_PATTERNS.footerHint.test(l))
  if (!hasFooter) return false
  return window.some((l) => l.includes(">") && PROMPT_PATTERNS.emptyPrompt.test(l))
}

export interface TerminalInfo {
  id: string
  name: string
  cwd: string
  state: "active" | "idle" | "dead"
  /**
   * BO-4b — the transport this terminal was ACTUALLY spawned with: "xterm" for an
   * interactive PTY (TerminalPane), "structured" for a headless stream-json proc
   * (AgentView + AgentComposer). Surfaced to the renderer so it forks PER TERMINAL
   * on ground truth instead of a single global config boolean (which raced the
   * async config load and left structured sessions blank). The backend is the
   * source of truth — see `create()` vs `createHeadless()`.
   *
   * Optional so test mocks of the mission SessionDriver (which returns TerminalInfo
   * and never reads engine) need no churn; the REAL producers — create(),
   * createHeadless(), list() — always set it, and an absent value resolves to the
   * "xterm" default in the renderer.
   */
  engine?: RenderingEngine
  /**
   * BO-6 — the `--model` a STRUCTURED terminal was spawned with (the resolved
   * alias/id passed to `claude -p --model`). Surfaced to the renderer so the
   * in-app picker can show the current model, and persisted on the terminal ref
   * so a restore/respawn reuses the same choice. Undefined for an xterm PTY (the
   * legacy interactive path takes no `--model`).
   */
  model?: string
  /**
   * CAPP-46 — the `--effort` a STRUCTURED terminal was spawned with, or undefined
   * if no level was picked (the spawn then OMITS `--effort`). Surfaced to the
   * renderer so the in-app effort picker can show the current level, and persisted
   * on the terminal ref so a restore/respawn reuses the same choice. Undefined for
   * an xterm PTY (the legacy interactive path takes no `--effort`).
   */
  effort?: string
  /**
   * CAPP-39 gate ② — true for the one-time interactive `claude /login` terminal
   * (see {@link TerminalService.createLogin}). The container uses it to mark the
   * persisted ref so the login terminal is excluded from idle-flush/broadcast and
   * is not auto-restored as a normal terminal. Undefined/false for every normal
   * terminal.
   */
  isLogin?: boolean
}

/**
 * The minimal slice of node-pty's `IPty` that TerminalService actually uses.
 * Declaring our own surface (rather than depending on `pty.IPty`) is what makes
 * the spawn path testable: a test can inject a `spawnPty` that returns a fake
 * conforming to THIS interface, with no real process behind it.
 */
export interface PtyLike {
  readonly pid: number
  readonly cols: number
  readonly rows: number
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

/** Options accepted by `spawnPty` — the subset of node-pty spawn options we pass. */
export interface SpawnPtyOptions {
  name: string
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
}

/**
 * The injectable spawn seam. Production passes the real `pty.spawn`; tests pass a
 * fake that records args and returns a `PtyLike` with no OS process behind it —
 * so `npm test` never launches a real `powershell → claude` (the P1-6 leak).
 */
export type SpawnPty = (file: string, args: string[], options: SpawnPtyOptions) => PtyLike

/** The default spawn seam: the real node-pty. */
const realSpawnPty: SpawnPty = (file, args, options) => pty.spawn(file, args, options)

/**
 * The minimal slice of a `child_process.ChildProcess` the HEADLESS (BO-1)
 * transport uses. Distinct from `PtyLike` on purpose: the headless stream-json
 * protocol wants a clean byte stream (piped stdio, no PTY echo / ANSI / terminal
 * control), and stdin is a structured-message sink rather than keystrokes.
 * Declaring our own surface is what makes the headless spawn path testable: a
 * test injects a `FakeStreamProc` with no OS process behind it.
 */
export interface ProcLike {
  readonly pid: number
  /** stdout `data` (decoded to a string). */
  onStdout(cb: (data: string) => void): void
  /** stderr `data` (decoded to a string). */
  onStderr(cb: (data: string) => void): void
  /** Process exit. `code` is null when the process was killed by a signal. */
  onExit(cb: (e: { code: number | null }) => void): void
  /** Write to the child's stdin (the structured user-message sink). */
  write(data: string): void
  kill(signal?: string): void
}

/** The subset of child_process spawn options the headless path passes. */
export interface SpawnProcOptions {
  cwd: string
  env: Record<string, string>
}

/**
 * The injectable HEADLESS spawn seam (spawn path B). Production passes
 * `realSpawnProc` (child_process.spawn with piped stdio); tests pass a fake that
 * records args + drives stdout/stderr/exit by hand — so `npm test` never
 * launches a real `claude` on the headless path either.
 */
export type SpawnProc = (file: string, args: string[], options: SpawnProcOptions) => ProcLike

/**
 * The default headless spawn seam: `child_process.spawn` with fully piped stdio.
 * Verified live on Windows (BO-1 de-risk): headless `claude` emits clean NDJSON
 * on stdout (no ANSI) and accepts structured user messages on stdin, both when
 * spawned directly and through the existing `shellWrap` powershell wrapper.
 */
const realSpawnProc: SpawnProc = (file, args, options) => {
  const child = cpSpawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  })
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  return {
    get pid() {
      return child.pid ?? -1
    },
    onStdout: (cb) => {
      child.stdout?.on("data", (d: string) => cb(d))
    },
    onStderr: (cb) => {
      child.stderr?.on("data", (d: string) => cb(d))
    },
    onExit: (cb) => {
      child.on("exit", (code) => cb({ code }))
    },
    write: (data) => {
      child.stdin?.write(data)
    },
    kill: (signal) => {
      child.kill(signal as NodeJS.Signals | undefined)
    },
  }
}

interface Terminal {
  id: string
  name: string
  cwd: string
  pty: PtyLike
  state: "active" | "idle" | "dead"
  /** Epoch ms of the last terminal output — drives idle detection. */
  lastActivity: number
  /**
   * Epoch ms the terminal entered its current ACTIVE burst (set on create/reopen
   * and on every idle→active flip). The burst length at the idle transition feeds
   * the attention queue's 10s "finished" guardrail so fresh spawns and one-line
   * blips never enqueue. Undefined while idle.
   */
  activeSince?: number
  /**
   * CAPP-39 gate ② — true for the one-time interactive `claude /login` PTY spawned
   * by {@link TerminalService.createLogin}. It is NOT a normal agent terminal: it's
   * an ephemeral OAuth affordance, so the agent-terminal machinery (idle-flush
   * summary-refresh, broadcast fan-out, restart auto-restore) MUST exclude it — see
   * {@link TerminalService.isLogin} and SessionService's guards. Surfaced on the
   * persisted TerminalRef too so the (live) container knows without a lookup.
   */
  isLogin?: boolean
}

/**
 * BO-1: a HEADLESS terminal's runtime bookkeeping. Kept in a registry parallel
 * to `terminals` (whose `Terminal.pty` is a `PtyLike`) because a headless proc is
 * a `ProcLike` with a different I/O surface and no idle/ANSI tracking. This
 * ticket only spawns/parses/emits — the engine switch that decides PTY-vs-headless
 * in `create()` is BO-4.
 */
interface HeadlessTerminal {
  id: string
  name: string
  cwd: string
  proc: ProcLike
  /** BO-6 — the resolved `--model` this headless proc was spawned with. */
  model: string
  /** CAPP-46 — the `--effort` this headless proc was spawned with, or undefined
   *  when no level was picked (the spawn then omitted `--effort`). */
  effort?: string
  /** Reassembles NDJSON across stdout chunks. */
  buffer: LineBuffer
  /** Whether an `init` event has been seen — drives the needs-auth signal. */
  sawInit: boolean
  /**
   * BO-7 — the `/`-command picker catalog captured off the `init` event
   * (slash_commands + skills). Undefined until init arrives (a headless
   * `claude -p` emits init after the first user message). Surfaced to the renderer
   * via {@link TerminalService.getCatalog} + the `agent:catalog` IPC accessor.
   */
  catalog?: AgentCatalog
  /**
   * BO-5: the same active/idle machine the PTY path runs, but EVENT-driven (a
   * structured terminal has no output-quiet clock). Streaming events
   * (assistant/tool_use/tool_result) → active; a `result` (or the BO-3
   * permission hook) → idle. Drives the SAME `terminal:state` renderer emit +
   * `{type:"state"}` onEvent seam, so AttentionService and SessionService
   * consume structured terminals with no changes.
   */
  state: "active" | "idle" | "dead"
  /** Epoch ms of the last structured event — parity with `Terminal.lastActivity`. */
  lastActivity: number
  /** Epoch ms the current active burst began; feeds the attention `burstMs`. */
  activeSince?: number
  /**
   * BO-3 HOOK — set by {@link TerminalService.markAwaitingPermission} so the next
   * idle transition reports `promptDetected=true` (a tier-2 `asked`, not a
   * tier-3 `finished`). Until BO-3 emits permission events on the stream seam,
   * nothing sets this and every structured idle is `finished`.
   */
  permissionPending?: boolean
  /**
   * CAPP-54 gate ② — parity with {@link TerminalInfo.isLogin} so list()/getActivity()
   * can copy `s.isLogin` off either registry without a type split. A headless proc
   * is NEVER a login terminal (the interactive `claude /login` PTY is always xterm),
   * so this is always undefined here — present only for shape consistency.
   */
  isLogin?: boolean
}

/** Per-session activity snapshot for the "which session needs me?" view. */
export interface TerminalActivity {
  id: string
  name: string
  state: "active" | "idle" | "dead"
  /** Milliseconds since the session last produced output. */
  idleMs: number
  /**
   * CAPP-54 gate ② (FIX C) — true for the one-time interactive `claude /login` PTY.
   * getActivity() is read-only (no injection path), but surfacing isLogin lets all
   * list-style read paths distinguish a login terminal consistently with list().
   */
  isLogin?: boolean
}

export type TerminalEvent =
  | { type: "created"; info: TerminalInfo }
  | {
      type: "state"
      id: string
      state: "active" | "idle" | "dead"
      /**
       * On an active→idle transition only: how long the just-ended active burst
       * lasted (ms), and whether the output tail shows Claude Code's input
       * prompt. Other subscribers (SessionService) ignore these; the attention
       * queue uses them for the finished-guardrail and asked-vs-finished split.
       */
      burstMs?: number
      promptDetected?: boolean
    }
  | { type: "exit"; id: string }
  | { type: "convo"; id: string; ccConversationId: string }
  | { type: "renamed"; id: string; name: string }
  /**
   * BO-1: a typed event parsed from a HEADLESS terminal's stream-json stdout,
   * attributed to its owning terminal. Emitted on the SAME `onEvent` seam as the
   * lifecycle events above (no second emitter) so SessionService and future
   * consumers (BO-2 renderer) watch one stream. The legacy ANSI
   * `sendToRenderer("terminal:data")` path is untouched — cutover is BO-4.
   */
  | { type: "stream"; id: string; event: StreamEvent }

/** Wrap a command in a shell so PATH resolution works reliably in Electron */
function shellWrap(command: string, args: string[]): { shell: string; shellArgs: string[] } {
  if (process.platform === "win32") {
    return {
      shell: "powershell.exe",
      shellArgs: ["-NoLogo", "-NoProfile", "-Command", [command, ...args].join(" ")],
    }
  }
  return {
    shell: "bash",
    shellArgs: ["-l", "-c", [command, ...args].join(" ")],
  }
}

/** Strip ANSI escape sequences so captured output is searchable plain text. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g

export interface OutputMatch {
  /** Session the match came from. */
  sessionId: string
  /** Session name for display. */
  name: string
  /** 0-based line index within the captured buffer. */
  line: number
  /** The matching line text. */
  text: string
}

export class TerminalService {
  private terminals = new Map<string, Terminal>()
  /** Bounded plain-text scrollback per session, for history search/review. */
  private outputBuffers = new Map<string, string>()
  /** Max characters of scrollback retained per session. */
  private readonly maxBufferChars = 100_000
  /** Transcript IDs already claimed by a terminal in this process — prevents
   *  parallel restores from all binding to the same conversation. */
  private claimedConvoIds = new Set<string>()
  private nextId = 1
  private mainWin: BrowserWindow | null = null
  private mcpConfigPath: string | null = null
  private mcpServerUrl: string | null = null
  private ccProjectsRoot = join(homedir(), ".claude", "projects")
  private defaultCommand = "claude"
  private defaultArgs = ["--dangerously-skip-permissions"]
  /**
   * BO-4a — the rendering transport new terminals spawn with. "xterm" routes
   * create() to the legacy interactive PTY; "structured" routes it to
   * createHeadless (stream-json engine). Defaults to "xterm" so create() is
   * byte-behavior-unchanged until the switch is flipped from config (ipc.ts).
   */
  private engine: RenderingEngine = "xterm"
  /**
   * BO-6 — the default `--model` new STRUCTURED terminals spawn with (wired from
   * config.rendering.model in ipc.ts via {@link resolveRenderingModel}). A
   * per-terminal model passed to create()/createHeadless() (the picker respawn or
   * a persisted ref on restore) overrides this. Defaults to the `opus` ALIAS so a
   * specific disabled version (the fable-5 failure) can never pin us.
   */
  private defaultModel: string = DEFAULT_MODEL
  /**
   * CAPP-46 — the default `--effort` new STRUCTURED terminals spawn with (wired
   * from config.rendering.effort in ipc.ts via {@link resolveRenderingEffort}). A
   * per-terminal effort passed to create()/createHeadless() (the picker respawn or
   * a persisted ref on restore) overrides this. UNDEFINED by default: when no level
   * is configured AND none is passed, the spawn OMITS `--effort` so the default
   * behavior is byte-unchanged.
   */
  private defaultEffort: string | undefined = undefined
  /**
   * DEV-skip-permissions — when true (DEFAULT), a STRUCTURED (headless) spawn uses
   * `--dangerously-skip-permissions` and OMITS the BO-3 `--permission-prompt-tool`
   * gate, so tools run without the per-tool Allow/Deny prompt (matching the legacy
   * xterm path, which already skips). When false, today's BO-3 behavior is restored
   * (the prompt-tool gate, NO skip flag). Wired from config.permissions.skipApproval
   * in ipc.ts via {@link resolveSkipApproval} + {@link setSkipApproval}.
   *
   * ⚠️ DEV POSTURE — RELEASE BLOCKER. Defaulting to skip is the owner-locked
   * dev-velocity choice; the trust thesis ("no runaway you can't stop") means a
   * PUBLIC release must NOT ship this default. The full BO-3 machinery (approve_tool
   * MCP tool, requestPermission, PermissionPrompt UI, usePermissions, attention
   * permission seam) is PRESERVED, only dormant while skip=true — it re-arms the
   * instant this is false. A release-blocker ticket tracks re-approaching the
   * posture before shipping.
   */
  private skipApproval = true
  /** Quiet period after which a live session is considered idle (waiting). */
  private readonly idleThresholdMs = 1500
  private idleTimer: ReturnType<typeof setInterval> | null = null
  /**
   * One shared transcript poll loop (lazy-built). Replaces the old per-terminal
   * convo pollers: terminals register an expectation on spawn and cancel it on
   * kill / convo-capture; a single loop assigns new transcripts to the oldest
   * pending expectation per cwd. See electron/services/transcripts.ts.
   */
  private _assigner: TranscriptAssigner | null = null
  /**
   * Per-terminal MCP identity tokens. Minted when an identity-bearing config is
   * written, resolved at SSE-connect time, and invalidated when the terminal is
   * killed. The token is the only trusted carrier of identity — raw sid/tid on
   * the URL are debug breadcrumbs, not authority.
   */
  private identityTokens = new Map<string, { sessionId: string; terminalId: string }>()

  /**
   * The spawn seam. Defaults to the real node-pty; tests inject a fake so the
   * suite never launches a real `powershell → claude` process. Matches the
   * `ccProjectsRoot` test-override pattern, but injected at construction so the
   * fake is impossible to forget (see `makeTestTerminalService` in tests).
   */
  private spawnPty: SpawnPty

  /**
   * The HEADLESS (BO-1) spawn seam. Defaults to `child_process.spawn` with piped
   * stdio; tests inject a `FakeStreamProc` so the suite never launches a real
   * `claude` on the headless path. Mirrors the `spawnPty` injection pattern.
   */
  private spawnProc: SpawnProc

  /** Live headless terminals, keyed by terminal id (parallel to `terminals`). */
  private headless = new Map<string, HeadlessTerminal>()

  /**
   * BO-3 — pending tool-permission prompts, keyed by request id. Mirrors
   * PanelService.pendingForms: the approve_tool MCP call stays open on this
   * resolver until the user decides (or the terminal exits → reject as deny).
   *
   * BO-10 — `timer` is the guard-timeout handle (Claude Code has NO permission
   * timeout of its own; it blocks forever). If unresolved after
   * {@link permissionGuardMs} the timer auto-denies so the agent never hangs.
   */
  private pendingPermissions = new Map<
    string,
    {
      terminalId: string
      toolName: string
      resolve: (d: PermissionDecision) => void
      timer?: ReturnType<typeof setTimeout>
    }
  >()

  /**
   * BO-10 — how long a permission prompt may sit unanswered before the guard
   * auto-denies it (Claude blocks forever otherwise). Overridable at construction
   * for fast hermetic tests. Default 5 minutes.
   */
  private readonly permissionGuardMs: number

  /**
   * BO-10 — a user-visible notification seam (set in ipc.ts to
   * NotificationService.notify). Used to surface a permission that timed out or a
   * tool call we could not attribute to any terminal — failures that would
   * otherwise be a SILENT hang. Optional: undefined in most unit tests (no toast).
   */
  private notify?: (message: string, level: NotificationLevel, title?: string) => void

  constructor(
    opts: {
      spawnPty?: SpawnPty
      spawnProc?: SpawnProc
      permissionGuardMs?: number
      notify?: (message: string, level: NotificationLevel, title?: string) => void
    } = {},
  ) {
    this.spawnPty = opts.spawnPty ?? realSpawnPty
    // BO-4b — env-gated hermetic seam: with CLAUDETUI_FAKE_STREAM=1 the headless
    // path drives a canned stream (fakeStreamProc) instead of spawning a real
    // `claude`, so the e2e structured-engine smoke stays hermetic. An explicitly
    // injected spawnProc (unit tests) always wins; production (env unset) uses the
    // real child_process spawn unchanged.
    this.spawnProc =
      opts.spawnProc ?? (process.env.CLAUDETUI_FAKE_STREAM === "1" ? fakeStreamProc : realSpawnProc)
    this.permissionGuardMs = opts.permissionGuardMs ?? 5 * 60 * 1000
    this.notify = opts.notify
  }

  /** BO-10 — wire the user-visible notification seam after construction (ipc.ts,
   *  once NotificationService exists). Mirrors {@link setMainWindow}. */
  setNotifier(fn: (message: string, level: NotificationLevel, title?: string) => void): void {
    this.notify = fn
  }

  private eventListeners = new Set<(e: TerminalEvent) => void>()

  /** Subscribe to in-process terminal lifecycle events. Returns an unsubscribe fn. */
  onEvent(cb: (e: TerminalEvent) => void): () => void {
    this.eventListeners.add(cb)
    return () => this.eventListeners.delete(cb)
  }

  private emitEvent(e: TerminalEvent): void {
    for (const cb of this.eventListeners) cb(e)
  }

  setMainWindow(win: BrowserWindow) {
    this.mainWin = win
    this.startIdleMonitor()
  }

  /**
   * Poll for sessions that have gone quiet and flip them active → idle. A single
   * shared timer covers every session, so cost is O(sessions) once per second.
   */
  private startIdleMonitor() {
    if (this.idleTimer) return
    this.idleTimer = setInterval(() => {
      const now = Date.now()
      for (const terminal of this.terminals.values()) {
        if (terminal.state === "active" && now - terminal.lastActivity > this.idleThresholdMs) {
          terminal.state = "idle"
          // Length of the active burst that just ended + whether the output tail
          // is sitting at Claude Code's input prompt. The attention queue needs
          // both to decide finished-vs-asked and to apply the 10s guardrail.
          const burstMs = terminal.activeSince != null ? now - terminal.activeSince : 0
          const promptDetected = detectPromptState(this.outputBuffers.get(terminal.id) ?? "")
          terminal.activeSince = undefined
          this.sendToRenderer("terminal:state", terminal.id, "idle")
          this.emitEvent({ type: "state", id: terminal.id, state: "idle", burstMs, promptDetected })
        }
      }
    }, 1000)
  }

  /** Record output activity and flip a session back to active if it was idle. */
  private markActive(terminal: Terminal) {
    terminal.lastActivity = Date.now()
    if (terminal.state === "idle") {
      terminal.state = "active"
      terminal.activeSince = terminal.lastActivity
      this.sendToRenderer("terminal:state", terminal.id, "active")
      this.emitEvent({ type: "state", id: terminal.id, state: "active" })
    }
  }

  setMcpConfigPath(path: string) {
    this.mcpConfigPath = path
  }

  /** Base SSE URL (e.g. http://127.0.0.1:PORT/sse) used to mint per-terminal,
   *  identity-bound MCP configs so a spawned terminal's tools know its own ids. */
  setMcpServerUrl(url: string) {
    this.mcpServerUrl = url
  }

  /**
   * Mint a random, unforgeable token bound to a terminal's identity and record
   * it so the MCP server can resolve a connection's real sid/tid at connect
   * time (instead of trusting the URL's claims). Returns the token string.
   */
  issueIdentityToken(sessionId: string, terminalId: string): string {
    const token = randomBytes(24).toString("base64url")
    this.identityTokens.set(token, { sessionId, terminalId })
    return token
  }

  /**
   * Resolve a token to its bound identity, or `undefined` if the token is
   * unknown (never issued, or invalidated by a terminal kill). The MCP server
   * treats `undefined` as anonymous — never as a reason to reject the
   * connection.
   */
  resolveIdentityToken(token: string): { sessionId: string; terminalId: string } | undefined {
    return this.identityTokens.get(token)
  }

  /** Drop a terminal's identity token so a stale config file can't resurrect it. */
  private invalidateIdentityTokens(terminalId: string): void {
    for (const [token, id] of this.identityTokens) {
      if (id.terminalId === terminalId) this.identityTokens.delete(token)
    }
  }

  /**
   * Write a per-terminal MCP config whose SSE URL carries this terminal's
   * identity (sid/tid for debuggability, plus a random token that is the only
   * trusted carrier of identity), and return its path. Falls back to the shared
   * config (no identity) when we don't have a server URL or a work-session id yet.
   */
  private mcpConfigFor(terminalId: string, sessionId?: string): string | null {
    if (!this.mcpServerUrl || !sessionId) return this.mcpConfigPath
    const configDir = join(tmpdir(), "claudetui")
    mkdirSync(configDir, { recursive: true })
    const path = join(configDir, `mcp-config-${terminalId}.json`)
    const token = this.issueIdentityToken(sessionId, terminalId)
    const url = `${this.mcpServerUrl}?sid=${encodeURIComponent(sessionId)}&tid=${encodeURIComponent(terminalId)}&token=${encodeURIComponent(token)}`
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { claudetui: { type: "sse", url } } }, null, 2),
    )
    return path
  }

  setDefaults(command: string, args: string[]) {
    this.defaultCommand = command
    this.defaultArgs = args
  }

  /**
   * BO-4a — set the rendering engine new terminals spawn with (wired from
   * config.rendering.engine in ipc.ts via {@link resolveRenderingEngine}). Any
   * value other than "structured" pins "xterm", so an unrecognized config can
   * only ever degrade to the safe default.
   */
  setEngine(engine: RenderingEngine): void {
    this.engine = engine === "structured" ? "structured" : "xterm"
  }

  /** BO-4a test/inspection accessor — the engine new terminals currently use. */
  getEngine(): RenderingEngine {
    return this.engine
  }

  /**
   * BO-6 — set the default `--model` new structured terminals spawn with (wired
   * from config.rendering.model in ipc.ts). An empty/blank value is ignored so a
   * malformed config can only ever degrade to the existing default, never to no
   * model (which would re-expose the resume-pin 404 bug).
   */
  setModel(model: string): void {
    if (typeof model === "string" && model.trim()) this.defaultModel = model.trim()
  }

  /** BO-6 test/inspection accessor — the default model new terminals currently use. */
  getModel(): string {
    return this.defaultModel
  }

  /**
   * CAPP-46 — set the default `--effort` new structured terminals spawn with (wired
   * from config.rendering.effort in ipc.ts). A blank/empty value CLEARS it to
   * undefined so the spawn omits `--effort` again (byte-unchanged default). Unlike
   * {@link setModel} a falsy value is meaningful (clear), not ignored — there's no
   * resume-pin bug to guard against.
   */
  setEffort(effort: string | undefined): void {
    this.defaultEffort = typeof effort === "string" && effort.trim() ? effort.trim() : undefined
  }

  /** CAPP-46 test/inspection accessor — the default effort new terminals currently use (undefined = none). */
  getEffort(): string | undefined {
    return this.defaultEffort
  }

  /**
   * DEV-skip-permissions — set the structured permission posture (wired from
   * config.permissions.skipApproval in ipc.ts via {@link resolveSkipApproval}).
   * true (default) = `--dangerously-skip-permissions`, no BO-3 gate; false = the
   * BO-3 `--permission-prompt-tool` gate, no skip flag. See the field doc for the
   * RELEASE-BLOCKER note — the BO-3 machinery is preserved and re-arms at false.
   */
  setSkipApproval(skip: boolean): void {
    this.skipApproval = skip !== false
  }

  /** DEV-skip-permissions test/inspection accessor — the current posture. */
  getSkipApproval(): boolean {
    return this.skipApproval
  }

  private sendToRenderer(channel: string, ...args: unknown[]) {
    if (this.mainWin && !this.mainWin.isDestroyed()) {
      this.mainWin.webContents.send(channel, ...args)
    }
  }

  private attachPtyListeners(terminal: Terminal) {
    terminal.pty.onData((data) => {
      this.sendToRenderer("terminal:data", terminal.id, data)
      this.captureOutput(terminal.id, data)
      this.markActive(terminal)
    })

    terminal.pty.onExit(() => {
      terminal.state = "dead"
      this.sendToRenderer("terminal:exit", terminal.id)
      this.emitEvent({ type: "exit", id: terminal.id })

      // Check for handoff file -- auto-respawn if present
      const handoffPath = join(terminal.cwd, "ephemeral", "handoff.md")
      if (existsSync(handoffPath)) {
        setTimeout(() => {
          const args = [...this.defaultArgs]
          if (this.mcpConfigPath) {
            args.push("--mcp-config", this.mcpConfigPath)
          }

          const { shell: hShell, shellArgs: hShellArgs } = shellWrap(
            this.defaultCommand, [...args, "continue from handoff"]
          )

          const newProc = this.spawnPty(hShell, hShellArgs, {
            name: "xterm-256color",
            cols: terminal.pty.cols,
            rows: terminal.pty.rows,
            cwd: terminal.cwd,
            env: { ...process.env, CLAUDE_TUI: "1" } as Record<string, string>,
          })

          terminal.pty = newProc
          terminal.state = "active"
          terminal.lastActivity = Date.now()
          terminal.activeSince = Date.now()
          this.attachPtyListeners(terminal)

          this.sendToRenderer("terminal:created", {
            id: terminal.id,
            name: terminal.name,
            cwd: terminal.cwd,
            state: "active",
            engine: "xterm",
          })
        }, 500)
      }
    })
  }

  /**
   * Mint a fresh terminal's id/name/cwd — shared by `create()` and
   * `createHeadless()` so the id scheme + the friendly per-run name sequence live
   * in one place. The id is collision-proof and must NOT be a resettable counter:
   * nextId resets to 1 on every app restart, so a counter-based id would collide
   * with terminal refs persisted by prior runs — two work sessions would then
   * share an id and reconcile() would fold one terminal's state into the wrong
   * session (the shared-green-dot bug). The display NAME keeps the friendly
   * per-run sequence.
   */
  private mintTerminal(name?: string, cwd?: string): { id: string; sessionName: string; sessionCwd: string } {
    return {
      id: `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionName: name || `Terminal ${this.nextId++}`,
      sessionCwd: cwd || process.cwd(),
    }
  }

  /**
   * Resume-or-capture the Claude Code conversation id for a freshly spawned
   * terminal — the identical tail for BOTH spawn paths. If resuming a known
   * conversation, re-emit its id immediately (CC reuses the same transcript file)
   * and claim it so siblings don't grab it; otherwise register a transcript
   * expectation the shared assigner fulfils with a `convo` event.
   */
  private bindConversation(id: string, sessionCwd: string, args: string[], resumeConvId?: string): void {
    if (resumeConvId && args.includes("--resume")) {
      this.claimedConvoIds.add(resumeConvId)
      this.emitEvent({ type: "convo", id, ccConversationId: resumeConvId })
    } else {
      this.captureConversationId(id, sessionCwd, Date.now())
    }
  }

  create(name?: string, cwd?: string, sessionId?: string, resumeConvId?: string, model?: string, effort?: string): TerminalInfo {
    // BO-4a ENGINE SWITCH: when configured for the structured transport a new
    // terminal is a HEADLESS stream-json process (createHeadless) rather than an
    // interactive PTY. The xterm branch below is byte-behavior-unchanged — the
    // shellWrap args, spawn options, and env are exactly as before. BO-6: a
    // per-terminal `model` flows to the headless spawn (the picker respawn / a
    // persisted ref on restore); CAPP-46: a per-terminal `effort` flows the same
    // way; the xterm branch deliberately IGNORES both (the legacy interactive path
    // takes no `--model`/`--effort`).
    if (this.engine === "structured") {
      return this.createHeadless(name, cwd, sessionId, resumeConvId, undefined, model, effort)
    }

    // The legacy interactive PTY path. Factored into spawnXterm so the
    // CAPP-39 gate ③ escape hatch ({@link createXterm}) can reach the SAME body
    // INDEPENDENT of the global engine routing (modeled on createLogin). create()'s
    // routing is byte-unchanged: a normal xterm spawn lands here exactly as before.
    return this.spawnXterm(name, cwd, sessionId, resumeConvId)
  }

  /**
   * CAPP-39 gate ③ — spawn a terminal on the legacy interactive PTY (xterm)
   * transport REGARDLESS of the configured global engine, so the per-terminal
   * "raw view" escape hatch can switch a structured terminal back to a real
   * terminal even when the default engine is "structured". Mirrors how
   * {@link createLogin} spawns an xterm PTY irrespective of `this.engine`; here we
   * reuse the FULL normal create() xterm body (identity-bound `--mcp-config`,
   * `--resume`, default interactive flags) via {@link spawnXterm} so a switched
   * terminal is a fully-featured agent terminal, not a spartan one.
   *
   * `resumeConvId` carries the structured terminal's captured Claude Code
   * conversation id so the PTY `--resume`s the SAME chat (the engine switch keeps
   * the conversation; only the transport changes). `model` is accepted for call-site
   * parity but IGNORED on the xterm path (a PTY takes no `--model`) — the caller
   * preserves the structured model on the ref so a later round-trip restores it.
   */
  createXterm(
    name?: string,
    cwd?: string,
    sessionId?: string,
    resumeConvId?: string,
    _model?: string,
  ): TerminalInfo {
    return this.spawnXterm(name, cwd, sessionId, resumeConvId)
  }

  /**
   * The shared interactive-PTY spawn body, EXACTLY the xterm half create() always
   * ran. Pulled out so it has one home: create() (the global-engine xterm branch)
   * and createXterm (the engine-independent escape-hatch spawn) both call it, so the
   * spawn is identical on both paths and create()'s normal routing stays
   * byte-equivalent.
   */
  private spawnXterm(name?: string, cwd?: string, sessionId?: string, resumeConvId?: string): TerminalInfo {
    const { id, sessionName, sessionCwd } = this.mintTerminal(name, cwd)

    const args = [...this.defaultArgs]
    for (const a of resumeArgs(this.ccProjectsRoot, sessionCwd, resumeConvId)) args.push(a)
    // Prefer a per-terminal, identity-bound MCP config so this terminal's
    // work-session tools default to its own ids; fall back to the shared config.
    const mcpConfig = this.mcpConfigFor(id, sessionId)
    if (mcpConfig) {
      args.push("--mcp-config", mcpConfig)
    }

    const { shell, shellArgs } = shellWrap(this.defaultCommand, args)

    const proc = this.spawnPty(shell, shellArgs, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: sessionCwd,
      env: {
        ...process.env,
        CLAUDE_TUI: "1",
        ...(sessionId ? { CLAUDETUI_SESSION_ID: sessionId } : {}),
        CLAUDETUI_TERMINAL_ID: id,
      } as Record<string, string>,
    })

    const terminal: Terminal = {
      id,
      name: sessionName,
      cwd: sessionCwd,
      pty: proc,
      state: "active",
      lastActivity: Date.now(),
      activeSince: Date.now(),
    }

    this.terminals.set(id, terminal)
    this.attachPtyListeners(terminal)

    const info: TerminalInfo = { id, name: sessionName, cwd: sessionCwd, state: "active", engine: "xterm" }
    this.sendToRenderer("terminal:created", info)
    this.emitEvent({ type: "created", info })

    this.bindConversation(id, sessionCwd, args, resumeConvId)
    return info
  }

  /**
   * CAPP-39 gate ② — spawn a ONE-TIME INTERACTIVE login terminal running
   * `claude /login`. The headless `claude -p` path cannot show Claude's OAuth login
   * UI (it's a non-interactive pipe), so when a structured session reports
   * `needs_auth` the renderer's Sign-in button lands here. This ALWAYS spawns an
   * interactive xterm PTY (engine:"xterm") REGARDLESS of the configured engine, so
   * the user sees Claude's real login flow in a normal terminal tab. Deliberately
   * spartan vs create(): NO --dangerously-skip-permissions, NO --mcp-config, NO
   * --resume, NO --model — just `claude /login`. Once the user completes the OAuth
   * flow the auth is persisted by Claude Code globally, and they re-send their
   * message in the structured session (auto-retry of the failed turn is a
   * follow-up). Byte-unchanged: the existing create() xterm path is untouched.
   */
  createLogin(name?: string, cwd?: string, sessionId?: string): TerminalInfo {
    const { id, sessionName, sessionCwd } = this.mintTerminal(name || "Sign in", cwd)

    const { shell, shellArgs } = shellWrap(this.defaultCommand, ["/login"])

    const proc = this.spawnPty(shell, shellArgs, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: sessionCwd,
      env: {
        ...process.env,
        CLAUDE_TUI: "1",
        ...(sessionId ? { CLAUDETUI_SESSION_ID: sessionId } : {}),
        CLAUDETUI_TERMINAL_ID: id,
      } as Record<string, string>,
    })

    const terminal: Terminal = {
      id,
      name: sessionName,
      cwd: sessionCwd,
      pty: proc,
      state: "active",
      lastActivity: Date.now(),
      activeSince: Date.now(),
      // CAPP-39 gate ② — mark this as the ephemeral OAuth terminal so the
      // agent-terminal machinery (idle-flush, broadcast, auto-restore) excludes it.
      isLogin: true,
    }

    this.terminals.set(id, terminal)
    this.attachPtyListeners(terminal)

    const info: TerminalInfo = { id, name: sessionName, cwd: sessionCwd, state: "active", engine: "xterm", isLogin: true }
    this.sendToRenderer("terminal:created", info)
    this.emitEvent({ type: "created", info })
    // No conversation binding: /login writes no transcript to resume.
    return info
  }

  /**
   * BO-1 — spawn a terminal in HEADLESS stream-json mode (spawn path B). The
   * transport HELPER only: it spawns `claude` with {@link HEADLESS_FLAGS} (+ the
   * existing identity-bound `--mcp-config` and, when resuming, `--resume`), wires
   * its stdout through the tolerant parser, and emits each typed event on the
   * SAME `onEvent`/`TerminalEvent` seam as `create()`. It does NOT render, accept
   * composer input, handle permissions, or touch the ANSI `terminal:data` path —
   * those are BO-2/BO-3/BO-4. BO-4 wires the engine switch in `create()` that
   * decides whether to call this; BO-1 leaves `create()` untouched.
   *
   * Identity + resume ride along unchanged: `mcpConfigFor` mints the per-terminal
   * token (resolved at SSE connect), `resumeArgs` adds `--resume`, and convo-id
   * capture flows through the same `TranscriptAssigner` → `convo` event path.
   */
  createHeadless(
    name?: string,
    cwd?: string,
    sessionId?: string,
    resumeConvId?: string,
    allowedTools?: string[],
    model?: string,
    effort?: string,
  ): TerminalInfo {
    const { id, sessionName, sessionCwd } = this.mintTerminal(name, cwd)

    // EXACTLY the pinned headless flag set, then the BO-6 model pin, the CAPP-46
    // effort pin, the BO-3 permission gate, resume, optional pre-approvals, and the
    // identity-bound mcp-config.
    const args = [...HEADLESS_FLAGS]
    // BO-6 — ALWAYS pass `--model`, on BOTH the fresh and the resume path. A
    // resumed `claude -p` otherwise keeps the model the transcript was saved with
    // (fable-5 → a permanent 404); `--model` OVERRIDES that pin (proven live). The
    // per-terminal `model` (picker respawn / persisted ref) wins over the config
    // default; both fall back to the `opus` alias, never to no model.
    const resolvedModel = (typeof model === "string" && model.trim()) || this.defaultModel
    args.push("--model", resolvedModel)
    // CAPP-46 — the reasoning `--effort` knob. UNLIKE `--model` this is CONDITIONAL:
    // a per-terminal `effort` (picker respawn / persisted ref) wins over the config
    // default, but when NEITHER is set the flag is OMITTED entirely so the default
    // spawn is byte-unchanged (Claude uses its own built-in effort default). There's
    // no resume-pin bug, so there's nothing to force on the resume path.
    const resolvedEffort = (typeof effort === "string" && effort.trim()) || this.defaultEffort
    if (resolvedEffort) args.push("--effort", resolvedEffort)
    // DEV-skip-permissions — DEV POSTURE, RELEASE BLOCKER. When skipApproval is
    // true (the owner-locked default), the structured spawn skips the per-tool
    // approval gate with `--dangerously-skip-permissions` (matching the legacy
    // xterm path) and OMITS the BO-3 prompt-tool. When false, today's BO-3 gate is
    // restored: route every un-pre-approved tool permission through OUR MCP tool
    // (it blocks on the user's decision; see requestPermission), with NO skip flag.
    //
    // The trust thesis is "no runaway you can't stop" — a PUBLIC release MUST NOT
    // ship the skip default; a release-blocker ticket tracks re-approaching this.
    // The BO-3 machinery (approve_tool, requestPermission, PermissionPrompt UI,
    // attention seam) is PRESERVED and goes dormant only while skip=true (Claude
    // never calls approve_tool); it re-arms verbatim when skipApproval is false.
    if (this.skipApproval) {
      args.push("--dangerously-skip-permissions")
    } else {
      args.push("--permission-prompt-tool", PERMISSION_PROMPT_TOOL)
    }
    for (const a of resumeArgs(this.ccProjectsRoot, sessionCwd, resumeConvId)) args.push(a)
    // Pre-approved tools skip the gate entirely (proved live). Bare tool names
    // only (e.g. "Read", "Write") — parenthesized specifiers aren't shell-safe
    // through the powershell wrapper's space-joined command string.
    const allow = (allowedTools ?? []).filter((t) => t && /^[A-Za-z0-9_]+$/.test(t))
    if (allow.length) args.push("--allowedTools", ...allow)
    const mcpConfig = this.mcpConfigFor(id, sessionId)
    if (mcpConfig) {
      args.push("--mcp-config", mcpConfig)
    }

    // Keep the existing shellWrap PATH-resolution behavior (verified to preserve
    // a clean NDJSON byte stream under piped stdio on Windows).
    const { shell, shellArgs } = shellWrap(this.defaultCommand, args)

    const proc = this.spawnProc(shell, shellArgs, {
      cwd: sessionCwd,
      env: {
        ...process.env,
        CLAUDE_TUI: "1",
        ...(sessionId ? { CLAUDETUI_SESSION_ID: sessionId } : {}),
        CLAUDETUI_TERMINAL_ID: id,
      } as Record<string, string>,
    })

    const entry: HeadlessTerminal = {
      id,
      name: sessionName,
      cwd: sessionCwd,
      proc,
      model: resolvedModel,
      effort: resolvedEffort,
      buffer: new LineBuffer(),
      sawInit: false,
      // BO-4b NO-INPUT IDLE: a freshly spawned `claude -p` (stream-json input)
      // emits NOTHING until the first user message lands on stdin, so the
      // event-driven idle machine would otherwise leave a brand-new structured
      // terminal pinned "active" (pulsing green) forever. Park it idle on spawn;
      // the first message flips it active via the normal idle→active edge.
      state: "idle",
      lastActivity: Date.now(),
      activeSince: undefined,
    }
    this.headless.set(id, entry)

    const drain = (lines: string[]) => {
      for (const line of lines) {
        for (const event of parseStreamLine(line)) {
          if (event.kind === "init") {
            entry.sawInit = true
            // BO-7 — retain the picker catalog (slash commands + skills).
            entry.catalog = {
              slashCommands: event.slashCommands ?? [],
              skills: event.skills ?? [],
            }
          }
          this.emitEvent({ type: "stream", id, event })
          // BO-5: project to the search/export buffer + drive the active/idle
          // machine off the SAME typed events, so the ANSI consumers light up.
          this.onStructuredEvent(entry, event)
        }
      }
    }

    proc.onStdout((chunk) => drain(entry.buffer.push(chunk)))
    proc.onStderr((chunk) => {
      // Best-effort visibility; the stream itself is the source of truth.
      logWarn("headless", `${id} stderr: ${String(chunk).trim().slice(0, 200)}`)
    })
    proc.onExit(() => {
      // Flush any buffered final (newline-less) line before tearing down. A
      // process that exited on its own (not an explicit kill that already tore
      // it down) gets the needs-auth check.
      drain(entry.buffer.flush())
      this.teardownHeadless(id, { synthAuth: true })
    })

    const info: TerminalInfo = { id, name: sessionName, cwd: sessionCwd, state: "idle", engine: "structured", model: resolvedModel, effort: resolvedEffort }
    this.emitEvent({ type: "created", info })

    this.bindConversation(id, sessionCwd, args, resumeConvId)
    return info
  }

  /**
   * Idempotent teardown for a headless terminal — shared by explicit `kill()`
   * (synthAuth=false: a deliberate kill is never an auth failure) and process
   * exit (synthAuth=true: an exit before any `init` event is a clean
   * non-interactive auth failure). Running once is guaranteed by the
   * `headless.has(id)` guard, so a kill followed by the proc's own async exit
   * doesn't double-emit.
   */
  private teardownHeadless(id: string, opts: { synthAuth: boolean }): void {
    const entry = this.headless.get(id)
    if (!entry) return
    entry.state = "dead"
    // BO-3 — settle any in-flight permission so a blocked approve_tool call
    // doesn't hang past the agent's life (a deny is the safe orphan resolution).
    this.rejectPendingPermissions(id, "agent-exited")
    if (opts.synthAuth && !entry.sawInit) {
      this.emitEvent({
        type: "stream",
        id,
        event: {
          kind: "needs_auth",
          message:
            "Claude Code exited before initializing (no init event) — likely missing or expired subscription auth.",
        },
      })
    }
    this.headless.delete(id)
    this.outputBuffers.delete(id)
    this.invalidateIdentityTokens(id)
    this._assigner?.cancel(id)
    this.emitEvent({ type: "exit", id })
  }

  /**
   * BO-1 — the stdin sink for a headless terminal: send a structured user message
   * over `--input-format stream-json`. BO-1 only EXPOSES this sink + the contract
   * type ({@link AgentUserMessage}); the input composer is BO-3. Returns false if
   * the terminal is unknown or already dead.
   */
  sendAgentMessage(id: string, msg: AgentUserMessage): boolean {
    const entry = this.headless.get(id)
    if (!entry || entry.state === "dead") return false
    entry.proc.write(JSON.stringify(msg) + "\n")
    // BO-4b — echo the user's own message onto the SAME stream seam so AgentView
    // renders a two-sided conversation (Claude never echoes the user turn back as
    // text). Emitted for EVERY input path (composer, broadcast, mission, waitForIdle
    // inject) since they all funnel through here. Empty/whitespace-only messages
    // (e.g. an attachment-only send) don't add a blank bubble.
    const text = msg.message.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("")
      .trim()
    if (text) this.emitEvent({ type: "stream", id, event: { kind: "user_message", text } })
    // A new user message starts a new turn — flip the structured terminal active
    // (parity with the PTY path's markActive on input).
    this.markActiveHeadless(entry)
    return true
  }

  /** BO-5: is this terminal a HEADLESS (structured) one? Lets callers (e.g.
   *  SessionService.handoffTerminal) branch xterm-vs-structured behavior. */
  isHeadless(id: string): boolean {
    return this.headless.has(id)
  }

  /** CAPP-39 gate ②: is this terminal the one-time interactive `claude /login` PTY?
   *  Lets the container/broadcast exclude it from agent-terminal machinery
   *  (idle-flush summary-refresh, broadcast fan-out). A headless terminal is never
   *  a login terminal, so only the PTY registry is consulted. */
  isLogin(id: string): boolean {
    return this.terminals.get(id)?.isLogin === true
  }

  /**
   * CAPP-39 gate ③ — is this STRUCTURED terminal mid-flight (generating a turn) or
   * parked on a permission prompt? The renderer's `isTerminalBusy` derives the same
   * answer from `terminal:state` + the pending-permission queue; this is the backend
   * source of truth so {@link SessionService.setTerminalEngine} can REFUSE an engine
   * switch while busy (killing a live turn to swap transports would lose the turn the
   * same way a naive Stop would — gate ③ refuses instead of draining). An xterm PTY
   * has no turn machine, so it is never "busy" here; an unknown/dead terminal is not
   * busy. Mirrors the headless active/idle machine ({@link idleHeadless}).
   */
  isBusy(id: string): boolean {
    if (this.hasPendingPermission(id)) return true
    const head = this.headless.get(id)
    return head ? head.state === "active" : false
  }

  /**
   * BO-7 — the `/`-command picker catalog (slash commands + skills) captured off a
   * structured terminal's `init` event, or null if the terminal is unknown / not
   * headless / hasn't emitted init yet. The renderer's AgentComposer pulls this on
   * mount via the `agent:catalog` IPC accessor (and also tracks live `init` stream
   * events), so the picker reflects the LIVE catalog, never a hardcoded list.
   */
  getCatalog(id: string): AgentCatalog | null {
    return this.headless.get(id)?.catalog ?? null
  }

  /**
   * BO-12 (CAPP-51) — rehydrate a structured chat view: read a conversation's
   * on-disk Claude Code transcript (`~/.claude/projects/<encoded-cwd>/<id>.jsonl`)
   * and return the ordered StreamEvent[] it folds into (via the renderer's shared
   * `reduceTranscript`). Keyed by the Claude Code conversation id (stable across a
   * `--resume` respawn — Stop/model-switch/handoff/restart all append to the SAME
   * file), so a freshly-remounted AgentView can re-seed the prior turns instead of
   * blanking. The reader scans the project dirs for the id and tolerates a partial
   * last line + unknown types; returns [] for a missing/unreadable transcript.
   */
  getTranscriptEvents(ccConversationId: string): StreamEvent[] {
    return readTranscriptEvents(this.ccProjectsRoot, ccConversationId)
  }

  /**
   * BO-5 — per-structured-event side effects: feed the search/export projection
   * and drive the active/idle machine. Streaming events keep the terminal active;
   * a `result` parks it idle (`finished`). Called for every parsed event so the
   * ANSI-consumer features (history search, export, sidebar activity, attention)
   * work for headless terminals with no ANSI buffer behind them.
   */
  private onStructuredEvent(entry: HeadlessTerminal, event: StreamEvent): void {
    // RESURRECTION GUARD (punch-list e): a late async stdout flush after teardown
    // (kill → headless.delete + outputBuffers.delete, then the proc's own exit
    // drains the final buffered line) must not re-create a deleted terminal's
    // outputBuffer or re-emit state. If it's already gone/dead, drop the event.
    if (entry.state === "dead" || !this.headless.has(entry.id)) return

    const fragment = projectStreamEvent(event)
    if (fragment) this.captureOutput(entry.id, fragment)

    switch (event.kind) {
      case "assistant_delta":
      case "thinking_delta":
      case "tool_use":
      case "tool_result":
        this.markActiveHeadless(entry)
        break
      case "init":
        // RUNTIME-INTEGRATION FIX (CAPP-58): on the stream-json path `init` arrives
        // AFTER the first user message — mid-turn, BEFORE the assistant deltas — so
        // parking idle here tore `busy` down for the 4-5s cold-start dead-air gap:
        // active(submit)→idle(init)→active(first delta). That false idle blanked the
        // "Thinking" row AND the streaming caret during the EXACT gap they exist to
        // cover, and made AttentionService classify on the init edge instead of the
        // real turn end. So we do NOT idle on init. A freshly spawned terminal is
        // already `state:"idle"` (terminals.ts ~:1227) and `markActiveHeadless` only
        // flips it active on a real activity event, so a spawned-but-unsent terminal
        // fed `init` stays idle (BO-4b preserved); a mid-turn terminal stays active
        // until `result` parks it idle below — one continuous active→idle per turn.
        //
        // BOOT-RACE GUARD (punch-list d) KEPT: reset the active burst baseline at
        // init so a slow (>10s) cold MCP boot can't trip the 10s finished-guardrail.
        // For an idle terminal this is an inert write; for the mid-turn case it makes
        // the burst measured from init (cold-boot time excluded), so `result`'s
        // burstMs stays honest and AttentionService never sees a spurious finished.
        entry.activeSince = Date.now()
        break
      case "result":
        // Turn complete → idle. AttentionService classifies this as `finished`
        // (or `asked` when the BO-3 permission hook armed promptDetected).
        this.idleHeadless(entry)
        break
      // needs_auth/unknown carry no activity signal.
    }
  }

  /** Flip a structured terminal active on new activity; emits state only on the
   *  idle→active edge (mirrors the PTY `markActive`). */
  private markActiveHeadless(entry: HeadlessTerminal): void {
    entry.lastActivity = Date.now()
    if (entry.state === "idle") {
      entry.state = "active"
      entry.activeSince = entry.lastActivity
      this.sendToRenderer("terminal:state", entry.id, "active")
      this.emitEvent({ type: "state", id: entry.id, state: "active" })
    }
  }

  /** Park a structured terminal idle; emits the SAME active→idle `state` event the
   *  PTY idle-monitor does (with `burstMs` + `promptDetected`) so AttentionService
   *  classifies asked-vs-finished and applies its guardrail unchanged. */
  private idleHeadless(entry: HeadlessTerminal): void {
    if (entry.state !== "active") return
    entry.state = "idle"
    const burstMs = entry.activeSince != null ? Date.now() - entry.activeSince : 0
    const promptDetected = entry.permissionPending === true
    entry.permissionPending = false
    entry.activeSince = undefined
    this.sendToRenderer("terminal:state", entry.id, "idle")
    this.emitEvent({ type: "state", id: entry.id, state: "idle", burstMs, promptDetected })
  }

  /**
   * BO-3 HOOK — pending-permission → "asked". When the approve_tool MCP gate is
   * invoked mid-turn, this parks the terminal as "awaiting you": flip to idle with
   * `promptDetected=true`, so AttentionService raises a tier-2 `asked` rather than
   * a tier-3 `finished`. The decision re-marks active ({@link resolvePermission}).
   *
   * GUARD (BO-3 fix): only arm when the terminal is mid-turn ACTIVE. Setting
   * `permissionPending` while already idle leaked the flag — `idleHeadless`
   * early-returns when `state !== "active"` and so never cleared it, mis-arming
   * the NEXT genuine idle as a spurious "asked". No-op for unknown/dead/idle.
   */
  markAwaitingPermission(id: string): void {
    const entry = this.headless.get(id)
    if (!entry || entry.state === "dead") return
    if (entry.state !== "active") return
    entry.permissionPending = true
    this.idleHeadless(entry)
  }

  /**
   * BO-3 — the agent-driven permission gate's service half (mirrors
   * PanelService.showForm). Registers a pending resolver, arms the attention
   * "asked" tier via {@link markAwaitingPermission}, pushes the request to the
   * renderer's PermissionPrompt, and returns a promise that resolves when the user
   * decides (or with a deny if the terminal exits first). The approve_tool MCP
   * tool awaits this and serializes the result back to Claude.
   */
  requestPermission(req: {
    terminalId: string
    toolName: string
    toolInput: unknown
    toolUseId?: string
  }): Promise<PermissionDecision> {
    // LIVENESS GUARD (punch-list a): an unknown or already-dead terminal can never
    // surface a prompt to anyone. Resolve immediately as a deny instead of
    // registering a resolver that would leave the blocked approve_tool MCP call
    // hanging forever. TOCTOU: the terminal can die between the assistant's
    // tool_use and this synchronous gate call, so this must be the FIRST thing we
    // check — before minting an id or pushing to the renderer.
    const entry = this.headless.get(req.terminalId)
    if (!entry || entry.state === "dead") {
      return Promise.resolve({
        id: `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        behavior: "deny",
        message: "ClaudeTUI: the requesting terminal is no longer alive; permission auto-denied.",
      })
    }

    const id = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const request: PermissionRequest = {
      id,
      toolName: req.toolName,
      toolInput: req.toolInput,
      toolUseId: req.toolUseId,
      terminalId: req.terminalId,
    }
    // Tier-2 "asked" in the attention queue. Mid-turn ACTIVE → markAwaitingPermission
    // parks it idle with promptDetected. ALREADY idle (markAwaitingPermission no-ops
    // to avoid the BO-3 flag leak) → raise the asked signal directly: a pending
    // permission must ALWAYS surface in NEEDS YOU (punch-list g), even when it's
    // requested between turns while the terminal is sitting idle.
    if (entry.state === "active") this.markAwaitingPermission(req.terminalId)
    else this.signalAsked(entry)
    // Surface the prompt regardless of attention tier.
    this.sendToRenderer(PERMISSION_REQUEST_CHANNEL, request)
    return new Promise<PermissionDecision>((resolve) => {
      // BO-10 — guard timeout. Claude Code has no permission timeout of its own
      // (it blocks the turn forever), so we own one: if the user never answers,
      // auto-deny with a user-facing reason rather than hang the agent for good.
      const timer = setTimeout(() => this.expirePermission(id), this.permissionGuardMs)
      // Never let the guard keep the process alive on its own (parity with the
      // idle monitor): it only matters while the app is running.
      ;(timer as { unref?: () => void }).unref?.()
      this.pendingPermissions.set(id, {
        terminalId: req.terminalId,
        toolName: req.toolName,
        resolve,
        timer,
      })
    })
  }

  /**
   * BO-10 — is a permission prompt currently blocking this terminal? The composer
   * input path (`agent:send-input`) checks this so it never writes to a stdin the
   * parked turn can't read — a message that would silently buffer unread while the
   * agent reports "sent". The renderer disables Send on the same busy signal; this
   * is the backend safety net.
   */
  hasPendingPermission(terminalId: string): boolean {
    for (const p of this.pendingPermissions.values()) {
      if (p.terminalId === terminalId) return true
    }
    return false
  }

  /**
   * BO-11 (CAPP-50) — the turn-CLOSING half of the Stop handbrake. When a structured
   * terminal is parked on a permission prompt, simply killing the proc drops the turn
   * from the LIVE process but leaves it HALF-OPEN in the on-disk transcript (a
   * tool_use with no tool_result). The respawned `--resume` proc then reads that
   * half-open tool_use as the last turn and can RE-ATTEMPT the tool on the next user
   * message — Claude-side resume-replay with no new instruction (the CAPP-50 safety
   * bug). The kill path's best-effort deny (rejectPendingPermissions → "agent-exited")
   * only closes the turn if it happens to reach the dying proc in time — a race that
   * loses under teardown pressure (a Stop racing a Ctrl+K), which is exactly the
   * dogfooding repro.
   *
   * This settles the parked permission(s) as a DENY through the STILL-LIVE proc (so
   * Claude actually receives it over the open approve_tool MCP call, writes the denial
   * tool_result, and winds the turn down to a `result`), then awaits that `result` —
   * CLOSING the turn on disk BEFORE any kill. {@link SessionService.interruptAgent}
   * awaits this when {@link hasPendingPermission} is true, so the subsequent kill +
   * `--resume` lands on a CLEAN, closed transcript and the agent stays idle instead
   * of re-attempting. The deny message is surfaced to the agent so the resumed
   * conversation carries explicit "the user cancelled this" context.
   *
   * Returns true if a `result` was drained, false if nothing was pending or the guard
   * timed out (the caller then falls back to the bare kill+resume — never worse than
   * the old behavior). Robust against a re-plan: if the agent parks on ANOTHER
   * permission after the first deny, each is re-denied until the turn winds down.
   * Proven live — docs/spikes/bo11-stop-abort.md (EXP-2, EXP-B).
   */
  async abortPendingPermissionAndDrain(
    terminalId: string,
    message: string,
    timeoutMs = 30_000,
  ): Promise<boolean> {
    if (!this.hasPendingPermission(terminalId)) return false
    let sawResult = false
    const off = this.onEvent((e) => {
      if (e.type === "stream" && e.id === terminalId && e.event.kind === "result") {
        sawResult = true
      }
    })
    try {
      this.denyPendingFor(terminalId, message)
      const start = Date.now()
      while (!sawResult && Date.now() - start < timeoutMs && this.headless.has(terminalId)) {
        // Re-deny any permission the agent parks on while re-planning the aborted
        // action, so the turn can actually wind down to its `result`.
        if (this.hasPendingPermission(terminalId)) this.denyPendingFor(terminalId, message)
        await new Promise((r) => setTimeout(r, 100))
      }
    } finally {
      off()
    }
    if (!sawResult) {
      logWarn(
        "permission",
        `abort-drain for ${terminalId} did not reach a result within ${timeoutMs}ms; killing anyway`,
      )
    }
    return sawResult
  }

  /**
   * BO-11 — settle every pending permission owned by a terminal as a DENY through the
   * LIVE proc ({@link resolvePermission} delivers the deny back over the still-open
   * approve_tool MCP call). Distinct from {@link rejectPendingPermissions}, which is
   * the teardown-time orphan resolution to a DYING proc.
   */
  private denyPendingFor(terminalId: string, message: string): void {
    for (const [id, p] of this.pendingPermissions) {
      if (p.terminalId !== terminalId) continue
      // resolvePermission deletes `id` from the map; deleting the current key during
      // a Map for..of is safe.
      this.resolvePermission(id, { id, behavior: "deny", message })
    }
  }

  /**
   * BO-10 — the guard timeout fired: a permission sat unanswered past
   * {@link permissionGuardMs}. Settle it as a deny with a user-facing reason (so
   * the blocked approve_tool call returns and the turn winds down) and raise a
   * visible toast — a timed-out prompt must never read as a silent hang. A no-op
   * if the prompt was already resolved/rejected (the timer is cleared on both).
   */
  private expirePermission(id: string): void {
    const pending = this.pendingPermissions.get(id)
    if (!pending) return
    this.pendingPermissions.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    this.sendToRenderer(PERMISSION_RESOLVED_CHANNEL, id)
    pending.resolve({
      id,
      behavior: "deny",
      message:
        "ClaudeTUI: this permission request went unanswered and was auto-denied after a timeout. Re-run the action to try again.",
    })
    this.notify?.(
      `A tool permission request for "${pending.toolName}" went unanswered and was automatically denied.`,
      "warning",
      "Permission timed out",
    )
  }

  /**
   * BO-4a (punch-list g) — raise a one-shot idle+promptDetected signal so
   * AttentionService classifies a tier-2 "asked" for a terminal that is ALREADY
   * idle when a permission is requested. Deliberately does NOT set the persistent
   * `permissionPending` flag: that is exactly the BO-3 leak `markAwaitingPermission`
   * guards against (a flag set while idle is never cleared by `idleHeadless` and
   * would mis-arm the NEXT genuine idle). This emits the asked now without arming
   * the state machine.
   */
  private signalAsked(entry: HeadlessTerminal): void {
    this.sendToRenderer("terminal:state", entry.id, "idle")
    this.emitEvent({ type: "state", id: entry.id, state: "idle", burstMs: 0, promptDetected: true })
  }

  /**
   * Resolve a pending permission with the user's decision. Double-resolve / an
   * unknown id is a safe no-op (returns false). On resolve: re-mark the terminal
   * active (the agent resumes its turn — immediate sidebar dot update), persist an
   * "always allow" rule when asked, clear the renderer prompt, and settle the
   * promise the approve_tool call is awaiting.
   */
  resolvePermission(id: string, decision: PermissionDecision): boolean {
    const pending = this.pendingPermissions.get(id)
    if (!pending) return false
    this.pendingPermissions.delete(id)
    // BO-10 — the user answered: disarm the guard timeout so it can't fire a
    // spurious late deny.
    if (pending.timer) clearTimeout(pending.timer)
    const entry = this.headless.get(pending.terminalId)
    if (entry && entry.state !== "dead") this.markActiveHeadless(entry)
    if (decision.behavior === "allow" && decision.alwaysAllow) {
      this.persistAllowRule(pending.terminalId, pending.toolName)
    }
    this.sendToRenderer(PERMISSION_RESOLVED_CHANNEL, id)
    pending.resolve({ ...decision, id })
    return true
  }

  /**
   * Reject every pending permission owned by a terminal as a deny — called when
   * the terminal is killed/exits so a blocked approve_tool call never hangs
   * (mirrors PanelService.hideAll resolving orphaned forms as cancelled).
   */
  private rejectPendingPermissions(terminalId: string, message: string): void {
    for (const [id, p] of this.pendingPermissions) {
      if (p.terminalId !== terminalId) continue
      this.pendingPermissions.delete(id)
      // BO-10 — disarm the guard timeout; this terminal is going away.
      if (p.timer) clearTimeout(p.timer)
      this.sendToRenderer(PERMISSION_RESOLVED_CHANNEL, id)
      p.resolve({ id, behavior: "deny", message })
    }
  }

  /**
   * "Always allow <tool>" persistence — append the tool to the terminal cwd's
   * `.claude/settings.local.json` `permissions.allow`, which Claude Code's DEFAULT
   * setting sources honor on the next spawn (proved live, BO-3 spike). The `local`
   * source is conventionally gitignored, so it neither pollutes commits nor
   * collides with sibling agents. Best-effort: never throws.
   */
  private persistAllowRule(terminalId: string, toolName: string): void {
    const cwd = this.headless.get(terminalId)?.cwd
    if (!cwd || !toolName) return
    try {
      const dir = join(cwd, ".claude")
      const file = join(dir, "settings.local.json")
      let existing: unknown = null
      if (existsSync(file)) {
        try {
          existing = JSON.parse(readFileSync(file, "utf8"))
        } catch {
          existing = null
        }
      }
      const { changed, next } = addAllowRule(existing, toolName)
      if (!changed) return
      mkdirSync(dir, { recursive: true })
      // Punch-list b: the moment we create a target project's `.claude/`, ensure
      // `settings.local.json` is gitignored — so the gitignored-local property
      // holds in ANY user project, not just ones `claude` init already touched.
      this.ensureLocalSettingsGitignored(dir)
      writeFileSync(file, JSON.stringify(next, null, 2))
    } catch (err) {
      logWarn("permission", `failed to persist allow rule for ${toolName}: ${String(err)}`)
    }
  }

  /**
   * BO-4a (punch-list b) — drop a `.claude/.gitignore` that ignores
   * `settings.local.json` (mirroring `claude` init), so the local settings source
   * we write the "always allow" rule into is never accidentally committed. The
   * `local` source is meant to be untracked. Non-clobbering: only writes when no
   * `.gitignore` exists yet, so a user's existing rules are left alone.
   */
  private ensureLocalSettingsGitignored(claudeDir: string): void {
    const gitignore = join(claudeDir, ".gitignore")
    if (existsSync(gitignore)) return
    writeFileSync(gitignore, "settings.local.json\n")
  }

  /**
   * The shared transcript assigner, built on first use so it can read the
   * (possibly test-overridden) ccProjectsRoot and share claimedConvoIds by
   * reference. When a transcript is bound, claimedConvoIds is already updated by
   * the assigner; we just emit the `convo` event the container consumes.
   */
  private get assigner(): TranscriptAssigner {
    if (!this._assigner) {
      this._assigner = new TranscriptAssigner(
        this.ccProjectsRoot,
        this.claimedConvoIds,
        (terminalId, ccConversationId) => {
          this.emitEvent({ type: "convo", id: terminalId, ccConversationId })
        },
      )
    }
    return this._assigner
  }

  /**
   * Register this freshly-spawned terminal as awaiting the Claude Code transcript
   * it is about to write. The shared assigner emits a `convo` event once it binds
   * one — no per-terminal timer, no give-up; the expectation lives until the
   * terminal exits or captures an id. The durable session record, not CC
   * internals, remains the source of truth.
   */
  private captureConversationId(id: string, cwd: string, spawnedAt: number): void {
    this.assigner.expect({ terminalId: id, cwd, spawnedAt })
  }

  kill(id: string): boolean {
    // Headless terminals (BO-1) live in a parallel registry. Killing the proc
    // fires its `onExit`, which emits the `exit` event and cleans up identity +
    // the transcript expectation — so an explicit kill and a process death take
    // the identical teardown path.
    const head = this.headless.get(id)
    if (head) {
      head.proc.kill()
      // Tear down synchronously (synthAuth=false) so identity/expectation cleanup
      // and the `exit` event don't depend on the proc's async exit firing; the
      // proc's own onExit then finds it already gone and no-ops.
      this.teardownHeadless(id, { synthAuth: false })
      return true
    }

    const terminal = this.terminals.get(id)
    if (!terminal) return false
    terminal.pty.kill()
    this.terminals.delete(id)
    this.outputBuffers.delete(id)
    this.invalidateIdentityTokens(id)
    this._assigner?.cancel(id)
    // Emit the same `exit` event a PTY death would, so every subscriber (session
    // reconcile, attention-queue cleanup) treats an explicit kill identically to
    // the process exiting on its own — no per-kill-path wiring needed.
    this.emitEvent({ type: "exit", id })
    return true
  }

  /** Append stripped terminal output to a session's bounded scrollback buffer. */
  private captureOutput(id: string, data: string): void {
    // RESURRECTION GUARD (punch-list e): never (re)create a buffer for a terminal
    // that's no longer live. A late async flush after kill would otherwise leave a
    // ghost outputBuffer that getOutput would serve as if the terminal still
    // existed (it keys "known" on outputBuffers presence).
    if (!this.terminals.has(id) && !this.headless.has(id)) return
    const clean = data.replace(ANSI_RE, "")
    if (!clean) return
    const prev = this.outputBuffers.get(id) ?? ""
    let next = prev + clean
    if (next.length > this.maxBufferChars) {
      next = next.slice(next.length - this.maxBufferChars)
    }
    this.outputBuffers.set(id, next)
  }

  /** Return the tail of a session's captured output, or null if unknown. */
  getOutput(id: string, maxChars = 8000): string | null {
    const buf = this.outputBuffers.get(id)
    // A live terminal with no captured output yet returns "" (not null). BO-5:
    // a headless terminal counts too — its projection may not have landed yet.
    if (buf == null) return this.terminals.has(id) || this.headless.has(id) ? "" : null
    return buf.length > maxChars ? buf.slice(buf.length - maxChars) : buf
  }

  /**
   * Search captured session output for `query` (case-insensitive). Scoped to one
   * session when `sessionId` is given, otherwise across all sessions. Returns the
   * matching lines so a user can review what Claude did while they were away.
   */
  searchOutput(query: string, sessionId?: string, limit = 50): OutputMatch[] {
    const needle = query.toLowerCase()
    const ids = sessionId ? [sessionId] : Array.from(this.outputBuffers.keys())
    const results: OutputMatch[] = []
    for (const id of ids) {
      const buf = this.outputBuffers.get(id)
      if (!buf) continue
      const name = this.terminals.get(id)?.name ?? id
      const lines = buf.split("\n")
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          results.push({ sessionId: id, name, line: i, text: lines[i].trimEnd() })
          if (results.length >= limit) return results
        }
      }
    }
    return results
  }

  list(): TerminalInfo[] {
    // BO-4a — include HEADLESS (structured) terminals alongside the PTY ones.
    // Both registries are real terminals; consumers that read list() (e.g.
    // broadcast_input, companion panel input, list_sessions) must see structured
    // terminals or they'd be invisible the moment the engine switch is on.
    const ptys = Array.from(this.terminals.values()).map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      state: s.state,
      engine: "xterm" as const,
      // CAPP-54 gate ② (re-review BLOCKER) — carry isLogin on the returned object.
      // BroadcastService excludes login terminals via `.filter((s) => !s.isLogin)`,
      // which is a NO-OP unless list() actually surfaces the flag. The login PTY is
      // always xterm, but we copy it on both branches for consistency.
      isLogin: s.isLogin,
    }))
    const headless = Array.from(this.headless.values()).map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      state: s.state,
      engine: "structured" as const,
      model: s.model,
      effort: s.effort,
      isLogin: s.isLogin,
    }))
    return [...ptys, ...headless]
  }

  /**
   * Per-session activity snapshot: which sessions are actively working vs. idle
   * (waiting for input), and how long each has been quiet. Lets a user — or
   * Claude itself — tell at a glance which background session needs attention.
   */
  getActivity(): TerminalActivity[] {
    const now = Date.now()
    // BO-4a — structured terminals run the SAME active/idle machine (event-driven
    // instead of output-quiet), so they belong in the activity snapshot too. This
    // is the big BO-5 review item: get_session_activity AND MissionService's
    // reapStalledWorkers read getActivity(), so a healthy headless worker would be
    // seen as "absent => stalled" and reaped without this inclusion.
    const ptys = Array.from(this.terminals.values()).map((s) => ({
      id: s.id,
      name: s.name,
      state: s.state,
      idleMs: now - s.lastActivity,
      // CAPP-54 gate ② (FIX C) — consistency with list(); read-only path, no injection.
      isLogin: s.isLogin,
    }))
    const headless = Array.from(this.headless.values()).map((s) => ({
      id: s.id,
      name: s.name,
      state: s.state,
      idleMs: now - s.lastActivity,
      isLogin: s.isLogin,
    }))
    return [...ptys, ...headless]
  }

  /**
   * Block until a session has been quiet for `quietMs` (i.e. finished working),
   * or `timeoutMs` elapses. The orchestration primitive: optionally inject
   * `input` first, then wait for the session to settle — so a caller can
   * delegate a task to a session and wait for it to complete instead of polling.
   *
   * Injecting input resets the quiet clock, which sidesteps the startup race
   * where a freshly-prompted session hasn't produced its first output yet.
   *
   * `notBefore`: don't treat the session as idle until it has produced output
   * AT OR AFTER this timestamp. A caller that injected a prompt out-of-band
   * (e.g. a deferred boot-delayed write) passes the prompt's send time so the
   * pre-prompt welcome-screen quiet can't be mistaken for "finished the work".
   */
  waitForIdle(
    id: string,
    opts: { input?: string; submit?: boolean; quietMs?: number; timeoutMs?: number; notBefore?: number } = {},
  ): Promise<{ idle: boolean; timedOut: boolean; reason?: string }> {
    // BO-5: a structured terminal isn't in `terminals` and has no quiet clock —
    // its idle is the `result` event. Inject input through the stdin sink (not a
    // dead PTY) and resolve when the turn parks idle.
    const head = this.headless.get(id)
    if (head) return this.waitForIdleHeadless(head, opts)

    const terminal = this.terminals.get(id)
    if (!terminal) return Promise.resolve({ idle: false, timedOut: false, reason: "not found" })
    if (terminal.state === "dead") {
      return Promise.resolve({ idle: false, timedOut: false, reason: "dead" })
    }

    const quietMs = opts.quietMs ?? this.idleThresholdMs
    const timeoutMs = opts.timeoutMs ?? 120_000
    const notBefore = opts.notBefore ?? 0

    if (opts.input != null) {
      // Start the quiet clock now so we wait for output that follows our input.
      terminal.lastActivity = Date.now()
      if (terminal.state === "idle") {
        terminal.state = "active"
        terminal.activeSince = terminal.lastActivity
        this.sendToRenderer("terminal:state", id, "active")
        this.emitEvent({ type: "state", id, state: "active" })
      }
      terminal.pty.write(opts.submit ? opts.input + "\r" : opts.input)
    }

    const start = Date.now()
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const s = this.terminals.get(id)
        if (!s || s.state === "dead") {
          clearInterval(timer)
          resolve({ idle: false, timedOut: false, reason: "ended" })
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer)
          resolve({ idle: false, timedOut: true })
        } else if (Date.now() - s.lastActivity >= quietMs && s.lastActivity >= notBefore) {
          clearInterval(timer)
          resolve({ idle: true, timedOut: false })
        }
      }, 250)
    })
  }

  /**
   * BO-5 — the structured analogue of `waitForIdle`'s PTY polling. A headless
   * terminal has no output-quiet clock: it is idle exactly when its turn parked
   * (the `result` event flipped {@link idleHeadless}). Optionally inject `input`
   * first via the stdin sink (a complete user message — `submit` is implicit
   * headless, so it's accepted for call-site parity but not separately honored),
   * which marks the terminal active; then resolve on the next idle or timeout.
   */
  private waitForIdleHeadless(
    entry: HeadlessTerminal,
    opts: { input?: string; submit?: boolean; quietMs?: number; timeoutMs?: number; notBefore?: number },
  ): Promise<{ idle: boolean; timedOut: boolean; reason?: string }> {
    if (entry.state === "dead") return Promise.resolve({ idle: false, timedOut: false, reason: "dead" })
    const timeoutMs = opts.timeoutMs ?? 120_000

    if (opts.input != null && opts.input.length > 0) {
      // sendAgentMessage marks the terminal active, so we wait for the turn that
      // follows our input rather than an already-idle state.
      this.sendAgentMessage(entry.id, userMessage(opts.input))
    }

    const start = Date.now()
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const e = this.headless.get(entry.id)
        if (!e || e.state === "dead") {
          clearInterval(timer)
          resolve({ idle: false, timedOut: false, reason: "ended" })
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer)
          resolve({ idle: false, timedOut: true })
        } else if (e.state === "idle") {
          clearInterval(timer)
          resolve({ idle: true, timedOut: false })
        }
      }, 250)
    })
  }

  rename(id: string, newName: string): boolean {
    const terminal = this.terminals.get(id)
    if (!terminal) return false
    terminal.name = newName
    this.sendToRenderer("terminal:renamed", id, newName)
    this.emitEvent({ type: "renamed", id, name: newName })
    return true
  }

  write(id: string, data: string): void {
    // BO-5: a structured terminal has no interactive PTY — its stdin is the
    // stream-json user-message sink. Route legacy write() callers (broadcast_input,
    // templates, mission dispatch, panel input, handoff force-flush) there instead
    // of a dead PTY. Strip the PTY-only idioms (bracketed-paste markers + a trailing
    // submit CR) so the agent receives clean prompt text. (BO-3 owns the richer
    // user composer on sendAgentMessage; this is the LEGACY write() path only.)
    const head = this.headless.get(id)
    if (head) {
      if (head.state === "dead") return
      const text = data.replace(/\x1b\[20[01]~/g, "").replace(/[\r\n]+$/, "")
      if (text.length > 0) this.sendAgentMessage(id, userMessage(text))
      return
    }
    const terminal = this.terminals.get(id)
    if (terminal) terminal.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(id)
    if (terminal) terminal.pty.resize(cols, rows)
  }

  handoff(id: string): boolean {
    const terminal = this.terminals.get(id)
    if (terminal) {
      terminal.pty.write("/handoff\r")
    }
    return true
  }

  focus(id: string): boolean {
    // Switching the visible tab is a renderer concern — tell it to activate this
    // session (so the MCP focus_session tool actually changes the active tab).
    if (!this.terminals.has(id)) return false
    this.sendToRenderer("terminal:focus", id)
    return true
  }

  splitPanes(leftId: string, rightId: string): boolean {
    if (!this.terminals.has(leftId) || !this.terminals.has(rightId)) return false
    this.sendToRenderer("split:set", leftId, rightId)
    return true
  }

  closeSplit(): boolean {
    this.sendToRenderer("split:close")
    return true
  }

  killAll(): void {
    for (const terminal of this.terminals.values()) {
      try {
        terminal.pty.kill()
      } catch {
        // Ignore cleanup errors
      }
    }
    // BO-1: also tear down headless terminals.
    for (const entry of this.headless.values()) {
      try {
        entry.proc.kill()
      } catch {
        // Ignore cleanup errors
      }
    }
    // BO-3 — settle any in-flight permissions (killAll bypasses teardownHeadless).
    for (const [id, p] of this.pendingPermissions) {
      if (p.timer) clearTimeout(p.timer) // BO-10 — disarm the guard timeout
      this.sendToRenderer(PERMISSION_RESOLVED_CHANNEL, id)
      p.resolve({ id, behavior: "deny", message: "agent-exited" })
    }
    this.pendingPermissions.clear()
    this.headless.clear()
    this.terminals.clear()
    this.outputBuffers.clear()
    this.identityTokens.clear()
    this._assigner?.dispose()
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
  }
}
