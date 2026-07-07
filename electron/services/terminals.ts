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
// CAPP-129 — REUSE the exact CAPP-125 cost extractor/delta semantics (pure, zero React/
// Electron imports; type-only StreamEvent) instead of forking the token/cost math. The
// main build already imports from src/lib at runtime (electron/mcp/tools/panels.ts →
// questionSubmit; transcriptHistory folds through agentTranscript), so this is an
// established cross-boundary import, not a new one.
import { extractCost, toPerTurnCost } from "../../src/lib/agentTranscript"
import {
  HEADLESS_FLAGS,
  DEFAULT_MODEL,
  ULTRACODE_SETTINGS,
  userMessage,
  agentMessageFromInput,
  AGENT_QUEUE_CHANGED_CHANNEL,
  PERMISSION_PROMPT_TOOL,
  PERMISSION_REQUEST_CHANNEL,
  PERMISSION_RESOLVED_CHANNEL,
  type StreamEvent,
  type AgentUserMessage,
  type AgentCatalog,
  type QueuedAgentInput,
  type PermissionRequest,
  type PermissionDecision,
  type RailOutputDraft,
} from "./streamProtocol"
import {
  newTurnBuffer,
  addFileTouch,
  suppressDerived,
  flushTurn,
  type TurnOutputBuffer,
} from "./outputDerivation"
import {
  classifySlashInput,
  UI_SLASH_COMMAND_CHANNEL,
  type UiSlashCommandPayload,
} from "./slashCommands"

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
    case "background_task_started":
    case "background_task_done":
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
   * Optional so test mocks of the SessionDriver (which returns TerminalInfo
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
   * CAPP-113 — the RESOLVED full model id the headless `init` event reported (e.g.
   * `claude-opus-4-8`), distinct from {@link TerminalInfo.model} (the alias/id we
   * spawned with). Diagnostic-only (the picker's tooltip). Undefined until init
   * arrives / for an xterm PTY.
   */
  resolvedModel?: string
  /**
   * CAPP-46 — the `--effort` a STRUCTURED terminal was spawned with, or undefined
   * if no level was picked (the spawn then OMITS `--effort`). Surfaced to the
   * renderer so the in-app effort picker can show the current level, and persisted
   * on the terminal ref so a restore/respawn reuses the same choice. Undefined for
   * an xterm PTY (the legacy interactive path takes no `--effort`).
   */
  effort?: string
  /**
   * CAPP-108 — true when this STRUCTURED terminal was spawned with ultracode ON
   * (the spawn appends `--settings '{"ultracode":true}'` and OMITS `--effort`,
   * since ultracode forces xhigh). Surfaced to the renderer so the in-app toggle
   * shows the current state, and persisted on the terminal ref so a restore/respawn
   * re-passes it (ultracode is session-only, so it must ride on every `--resume`
   * spawn). Undefined/false for an xterm PTY (the legacy path takes no `--settings`).
   */
  ultracode?: boolean
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
  /**
   * Async spawn failure (e.g. an invalid `cwd` → ENOENT). OPTIONAL on the
   * contract so the hermetic fakes (FakeStreamProc, fakeStreamProc) need not
   * implement it; the real `realSpawnProc` always wires it. When a spawn fails
   * `error` fires INSTEAD of `exit` (Node never emits `exit` for a process that
   * never started), so the consumer must tear down on `error` too — otherwise an
   * unhandled `error` on a ChildProcess crashes the main process.
   */
  onError?(cb: (err: Error) => void): void
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
    onError: (cb) => {
      // A spawn failure (invalid cwd → ENOENT, missing shell, EACCES) emits
      // 'error' INSTEAD of 'exit'. Without a listener Node re-throws it as an
      // uncaught exception that crashes the main process — so we must forward it
      // to the consumer (which tears the terminal down gracefully).
      child.on("error", (err) => cb(err))
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
  /** CAPP-108 — true when this headless proc was spawned with ultracode ON
   *  (`--settings '{"ultracode":true}'`; `--effort` is omitted in that case). */
  ultracode?: boolean
  /** Reassembles NDJSON across stdout chunks. */
  buffer: LineBuffer
  /** Whether an `init` event has been seen — drives the needs-auth signal. */
  sawInit: boolean
  /** CAPP-117 — the most recent non-empty stderr line, kept so an exit-BEFORE-init
   *  can be classified honestly: only a stderr that actually reads like an auth
   *  failure synthesizes `needs_auth`; anything else surfaces the real line as a
   *  plain errored result (so e.g. a bad `--settings`/flag self-describes instead of
   *  a misleading "not signed in"). */
  lastStderr?: string
  /**
   * BO-7 — the `/`-command picker catalog captured off the `init` event
   * (slash_commands + skills). Undefined until init arrives (a headless
   * `claude -p` emits init after the first user message). Surfaced to the renderer
   * via {@link TerminalService.getCatalog} + the `agent:catalog` IPC accessor.
   */
  catalog?: AgentCatalog
  /**
   * CAPP-113 — the RESOLVED full model id the headless `init` event reported (e.g.
   * `claude-opus-4-8` when spawned with the `opus` alias). Diagnostic-only: surfaced
   * to the renderer as the model picker's tooltip so the user can see what an alias
   * resolved to. Undefined until `init` arrives (after the first user message on the
   * stream-json path). Distinct from {@link HeadlessTerminal.model}, which is the
   * alias/id we SPAWNED with.
   */
  resolvedModel?: string
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
   * CAPP-131 — the LAST foreground state pushed to the RENDERER on the
   * `terminal:state` channel ({@link emitForegroundState}), so that emit can be
   * deduped and, crucially, kept FOREGROUND-ONLY. The renderer's
   * `useGeneratingTerminals` gates the composer Send off this channel, so it must
   * track the foreground turn ONLY — never the background-work hold that keeps the
   * EFFECTIVE machine ({@link state}) active. Deduping on THIS field (not
   * {@link state}) is what lets a foreground turn re-emit "active" to the renderer
   * even while a background task already holds `state` active (the latent
   * Send-gating bug). Seeded "idle" on spawn to match the terminal's spawn state
   * (createHeadless returns `state:"idle"`), so the renderer's initial view agrees.
   */
  fgEmitted?: "active" | "idle"
  /**
   * BACKGROUND WORK — true while the FOREGROUND turn is generating (set on any activity
   * event, cleared on `result`). Separated from {@link backgroundTasks} so the effective
   * state is a clean OR: the terminal is "active" (green) while EITHER the foreground turn
   * runs OR any background task is outstanding. Without this split, `result` unconditionally
   * parked the session idle even though detached work was still running (the reported bug).
   */
  foregroundActive?: boolean
  /**
   * BACKGROUND WORK — outstanding background tasks by task-id → epoch-ms launched. A
   * `background_task_started` adds; a `background_task_done` removes; the idle poll prunes
   * entries older than {@link backgroundTaskMaxMs} (a missed completion can't pin a session
   * green forever). Non-empty ⇒ the session holds "active" (green) past the foreground
   * `result`; the size is surfaced to the sidebar as the `⚙ N` badge.
   */
  backgroundTasks?: Map<string, number>
  /**
   * BACKGROUND WORK — epoch ms the LAST background task drained while no foreground turn
   * was live, arming a short grace before parking idle. A background completion often
   * WAKES a follow-up turn (Claude reacts to the `<task-notification>`), so idling
   * synchronously would flap active→idle→active and raise a spurious "finished". The idle
   * monitor parks idle only after {@link idleThresholdMs} with no follow-up; real activity
   * ({@link markActiveHeadless}) clears this, cancelling the settle. Undefined when not settling.
   */
  bgSettleAt?: number
  /**
   * CAPP-54 gate ② — parity with {@link TerminalInfo.isLogin} so list()/getActivity()
   * can copy `s.isLogin` off either registry without a type split. A headless proc
   * is NEVER a login terminal (the interactive `claude /login` PTY is always xterm),
   * so this is always undefined here — present only for shape consistency.
   */
  isLogin?: boolean
  /**
   * CAPP-129 — the RAW cumulative `total_cost_usd` reported by the LAST `result` this
   * proc emitted, so the next turn's PER-TURN cost is `current − this` (via
   * {@link toPerTurnCost}). CAPP-125 TRAP: `total_cost_usd` is cumulative PER PROCESS,
   * so summing it triangular-overcounts — we accumulate DELTAS only. This baseline is
   * PER-ENTRY: a respawn/`--resume` mints a FRESH HeadlessTerminal, so it resets to
   * undefined and the resumed proc's first delta is its own raw cumulative (which, per
   * the CAPP-125 fixtures, excludes the pre-resume history — no double-count). Undefined
   * until the first cost-bearing result.
   */
  lastCumulativeCostUsd?: number
  /**
   * CAPP-132 — the current turn's DERIVED-output accumulator (file drafts from
   * Write/Edit/NotebookEdit tool_uses, plus the suppress-set an explicit post_output
   * writes so a matching derived draft is dropped at the turn flush). Reset on spawn
   * (a fresh entry starts with an empty buffer) and after each `result` flush. Undefined
   * only transiently before the first derivation; treated as an empty buffer.
   */
  derivedOutputs?: TurnOutputBuffer
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
   * BACKGROUND WORK — the outstanding background-task COUNT for a terminal changed
   * (a task started or completed), without necessarily a state change. SessionService
   * re-emits the session snapshot so the sidebar `⚙ N` badge tracks it live. Carries no
   * payload beyond `id` — consumers read the count via {@link TerminalService.backgroundCount}.
   */
  | { type: "background"; id: string }
  /**
   * CAPP-129 — a turn-complete PER-TURN cost delta for a HEADLESS terminal, attributed
   * to its owning terminal. Emitted on the SAME `onEvent` seam right after the turn's
   * `result` (before the CAPP-130 queue flush). SessionService folds it into the durable
   * per-terminal + per-session rolling totals. `costUsd`/`totalTokens` are already
   * PER-TURN (the cumulative→delta conversion happened upstream via {@link toPerTurnCost});
   * either may be undefined when the result reported neither, but the event still fires so
   * the "N turns" count advances. xterm terminals have no result stream → they never emit.
   */
  | { type: "cost"; id: string; costUsd?: number; totalTokens?: number }
  /**
   * CAPP-132 — a batch of DELIVERABLE drafts (links/files/notes) for the OUTPUTS
   * feed, attributed to its owning terminal (`id`). Emitted on the SAME `onEvent`
   * seam: DERIVED drafts flush as ONE batch at a turn's `result` (right after the
   * CAPP-129 cost emit, before the CAPP-130 queue flush); an EXPLICIT `post_output`
   * forwards a single-entry batch IMMEDIATELY (mid-turn). SessionService maps the
   * terminal→session, mints an id + ts per draft, appends to the durable feed, and
   * emits the dedicated `worksession:outputs-changed`. Drafts carry no id/ts/terminalId
   * (SessionService stamps them). Never a blocking gate (tier-1 contract untouched).
   */
  | { type: "output"; id: string; outputs: RailOutputDraft[] }
  /**
   * BO-1: a typed event parsed from a HEADLESS terminal's stream-json stdout,
   * attributed to its owning terminal. Emitted on the SAME `onEvent` seam as the
   * lifecycle events above (no second emitter) so SessionService and future
   * consumers (BO-2 renderer) watch one stream. The legacy ANSI
   * `sendToRenderer("terminal:data")` path is untouched — cutover is BO-4.
   */
  | { type: "stream"; id: string; event: StreamEvent }

/**
 * CAPP-96 — argv-safe quoting for the `shellWrap` PATH wrapper.
 *
 * `shellWrap` packs the whole command into ONE `-Command` / `-c` string, which the
 * shell then re-parses — so any arg with a space or a shell metacharacter is word-split,
 * variable-expanded, or COMMAND-INJECTED (the auto-load payload path can carry a space on
 * a `C:\Users\John Doe\…` homedir, and findings are partly agent-authored). Before this,
 * `--allowedTools` had to be hard-filtered to `/^[A-Za-z0-9_]+$/` precisely because of
 * this. We now quote per-arg so any value round-trips intact.
 *
 * Quote ONLY when needed (a plain flag like `-p` / `--model` / `opus` / `stream-json` is
 * left bare) so the existing pinned-flag-order assertions still hold and the byte stream
 * is byte-unchanged for the common no-special-char case.
 */
// Bare-safe = the chars a flag/alias/simple value uses; anything else is quoted. Includes
// `[` `]` so the model alias `opus[1m]` stays unquoted (brackets are literal when passed as
// an arg to a NATIVE exe — PowerShell only treats them as wildcards inside its own path
// cmdlets, never in a native-command argument, and a POSIX shell leaves them literal too).
const BARE_SAFE_RE = /^[A-Za-z0-9_./:=@,+[\]-]+$/

/** PowerShell single-quote: wrap in '…' and double any interior single quote. Inside a
 *  single-quoted PowerShell string NOTHING is special (no `$`, no backtick, no `;`). */
export function quotePowerShellArg(arg: string): string {
  if (arg.length > 0 && BARE_SAFE_RE.test(arg)) return arg
  return `'${arg.replace(/'/g, "''")}'`
}

/** POSIX single-quote: wrap in '…' and escape any interior single quote as '\''. Inside a
 *  single-quoted POSIX string NOTHING is special. */
export function quotePosixArg(arg: string): string {
  if (arg.length > 0 && BARE_SAFE_RE.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** Wrap a command in a shell so PATH resolution works reliably in Electron */
function shellWrap(command: string, args: string[]): { shell: string; shellArgs: string[] } {
  if (process.platform === "win32") {
    const cmd = [command, ...args].map(quotePowerShellArg).join(" ")
    return {
      shell: "powershell.exe",
      shellArgs: ["-NoLogo", "-NoProfile", "-Command", cmd],
    }
  }
  const cmd = [command, ...args].map(quotePosixArg).join(" ")
  return {
    shell: "bash",
    shellArgs: ["-l", "-c", cmd],
  }
}

/**
 * CAPP-117 — does a headless process's captured stderr read like an auth failure?
 * Gates the exit-before-init `needs_auth` synth so a NON-auth early crash (a bad
 * `--settings` JSON, a bad flag, a bad model) surfaces its real stderr instead of a
 * misleading Sign-in banner. Broad but auth-specific: "sign in", "log in"/"login",
 * "auth", "API key".
 */
const AUTH_STDERR_RE = /sign ?in|log ?in|login|auth|api key/i

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
   * createHeadless (stream-json engine). CAPP-39 gate ④ — defaults to "structured"
   * (the headless engine is now the default surface); ipc.ts still wires the config
   * via setEngine(resolveRenderingEngine(config)), so an explicit `rendering.engine:
   * "xterm"` pins the legacy PTY globally and the per-terminal raw-view escape hatch
   * (createXterm / setTerminalEngine) remains the per-terminal way back.
   */
  private engine: RenderingEngine = "structured"
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
   * CAPP-108 — the default ultracode posture new STRUCTURED terminals spawn with.
   * A per-terminal `ultracode` passed to create()/createHeadless() (the toggle
   * respawn or a persisted ref on restore) overrides this. FALSE by default: when
   * ultracode is off AND none is passed, the spawn OMITS `--settings`, so the
   * default behavior is byte-unchanged. There is no config seam for this yet (it's
   * a per-session knob); the field exists so the spawn path has one consistent
   * resolve point mirroring {@link defaultEffort}.
   */
  private defaultUltracode = false
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
  /**
   * BACKGROUND WORK — the safety cap: a background task we never saw complete is pruned
   * from a terminal's outstanding-set after this long, so a MISSED completion (a dropped
   * `<task-notification>`, a killed child) can't pin a session green forever. Generous
   * because legitimate background work (builds, benchmarks) runs long; the common case
   * drains via the real completion notice well before this. Pruned by the idle monitor.
   */
  private readonly backgroundTaskMaxMs = 20 * 60_000
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
   * CAPP-130 — per-terminal QUEUE of composer submissions typed while the
   * foreground turn is busy. Holds the RAW payload (text/attachments), NOT a built
   * AgentUserMessage, so a flushed item re-routes through the EXACT same submit path
   * a fresh send does ({@link submitAgentInputNow}: slash-command classification +
   * message-building). Auto-flushed FIFO, one per turn, at each `result` once the
   * foreground is truly idle and no permission is parked. In-memory only (a restart
   * drops it — auto-firing queued turns at launch would surprise the user). Dropped
   * on kill/teardown; transferred across a respawn re-point ({@link transferAgentQueue}).
   */
  private agentQueues = new Map<string, QueuedAgentInput[]>()

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
      // BACKGROUND WORK — per headless terminal: (1) prune stale tasks (a completion we
      // never saw) so a missed notice can't hold a session green forever, then (2) confirm
      // a pending settle — park idle only after the grace window elapses with no woken
      // follow-up turn (a real activity event clears bgSettleAt).
      for (const entry of this.headless.values()) {
        const tasks = entry.backgroundTasks
        if (tasks && tasks.size > 0) {
          let pruned = false
          for (const [taskId, startedAt] of tasks) {
            if (now - startedAt > this.backgroundTaskMaxMs) {
              tasks.delete(taskId)
              pruned = true
            }
          }
          if (pruned) {
            this.emitEvent({ type: "background", id: entry.id })
            const stillWorking = entry.foregroundActive === true || tasks.size > 0
            if (!stillWorking && entry.state === "active" && entry.bgSettleAt == null) {
              entry.bgSettleAt = now
            }
          }
        }
        if (
          entry.bgSettleAt != null &&
          entry.state === "active" &&
          entry.foregroundActive !== true &&
          (entry.backgroundTasks?.size ?? 0) === 0 &&
          now - entry.bgSettleAt >= this.idleThresholdMs
        ) {
          entry.bgSettleAt = undefined
          this.idleHeadless(entry)
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

  /**
   * CAPP-117 — materialize the CONSTANT {@link ULTRACODE_SETTINGS} payload to a stable
   * temp FILE and return its absolute path (`{tmpdir}/claudetui/ultracode-settings.json`),
   * or null on ANY fs failure. Ultracode is enabled with `--settings <path>`, NOT the
   * inline JSON string: the embedded `{ } " :` do NOT survive the powershell→claude argv
   * hop on Windows (the downstream-argv quirk documented in shellWrap.test.ts:20-24), so
   * `--settings '{"ultracode":true}'` reaches `claude` as mangled JSON and it dies with
   * `Error: Invalid JSON provided to --settings`. A bare file path has no interior
   * metachars, so it round-trips intact (file-based `--settings` is live-verified with
   * auth intact). The content is CONSTANT → one shared file suffices; only (re)written
   * when missing or divergent (idempotent, no churn). A dedicated seam so the failure
   * path (null → omit the flag) is unit-testable. */
  private ultracodeSettingsPath(): string | null {
    try {
      const dir = join(tmpdir(), "claudetui")
      mkdirSync(dir, { recursive: true })
      const path = join(dir, "ultracode-settings.json")
      let current: string | null = null
      try {
        current = readFileSync(path, "utf8")
      } catch {
        current = null
      }
      if (current !== ULTRACODE_SETTINGS) writeFileSync(path, ULTRACODE_SETTINGS)
      return path
    } catch {
      return null
    }
  }

  setDefaults(command: string, args: string[]) {
    this.defaultCommand = command
    this.defaultArgs = args
  }

  /**
   * BO-4a — set the rendering engine new terminals spawn with (wired from
   * config.rendering.engine in ipc.ts via {@link resolveRenderingEngine}). CAPP-39
   * gate ④ — only an explicit "xterm" pins the legacy PTY; any other value (including
   * an unrecognized config) resolves to the "structured" default, mirroring
   * resolveRenderingEngine so the service and the resolver agree.
   */
  setEngine(engine: RenderingEngine): void {
    this.engine = engine === "xterm" ? "xterm" : "structured"
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
   * CAPP-108 — set the default ultracode posture new structured terminals spawn
   * with. Coerced to a strict boolean so a malformed value can only ever degrade to
   * off (the spawn then omits `--settings`, byte-unchanged default).
   */
  setUltracode(on: boolean): void {
    this.defaultUltracode = on === true
  }

  /** CAPP-108 test/inspection accessor — the default ultracode posture new terminals currently use. */
  getUltracode(): boolean {
    return this.defaultUltracode
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

  create(name?: string, cwd?: string, sessionId?: string, resumeConvId?: string, model?: string, effort?: string, ultracode?: boolean): TerminalInfo {
    // BO-4a ENGINE SWITCH: when configured for the structured transport a new
    // terminal is a HEADLESS stream-json process (createHeadless) rather than an
    // interactive PTY. The xterm branch below is byte-behavior-unchanged — the
    // shellWrap args, spawn options, and env are exactly as before. BO-6: a
    // per-terminal `model` flows to the headless spawn (the picker respawn / a
    // persisted ref on restore); CAPP-46: a per-terminal `effort` flows the same
    // way; the xterm branch deliberately IGNORES both (the legacy interactive path
    // takes no `--model`/`--effort`).
    if (this.engine === "structured") {
      return this.createHeadless(name, cwd, sessionId, resumeConvId, undefined, model, effort, ultracode)
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
    _effort?: string,
    _ultracode?: boolean,
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
    const resume = resumeArgs(this.ccProjectsRoot, sessionCwd, resumeConvId)
    for (const a of resume) args.push(a)
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
    ultracode?: boolean,
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
    // CAPP-108/117 — the ultracode knob (a per-session BOOLEAN). When ON, the spawn
    // appends `--settings <path>` pointing at a temp FILE that holds the ultracode
    // payload (see {@link ultracodeSettingsPath}). It is NOT passed inline: the
    // embedded `{ } " :` do NOT survive the powershell→claude argv hop on Windows —
    // `claude` would receive mangled JSON and die instantly with
    // `Error: Invalid JSON provided to --settings` (live-verified). A bare file path
    // round-trips intact. Ultracode forces xhigh reasoning internally, so when it's
    // ON we OMIT `--effort` entirely (passing both is undefined behavior — see below).
    // A per-terminal `ultracode` (toggle respawn / persisted ref) wins over the
    // default; FALSE → the spawn omits `--settings` (byte-unchanged default).
    const resolvedUltracode = ultracode != null ? ultracode === true : this.defaultUltracode
    // CAPP-46 — the reasoning `--effort` knob. UNLIKE `--model` this is CONDITIONAL:
    // a per-terminal `effort` (picker respawn / persisted ref) wins over the config
    // default, but when NEITHER is set the flag is OMITTED entirely so the default
    // spawn is byte-unchanged (Claude uses its own built-in effort default). There's
    // no resume-pin bug, so there's nothing to force on the resume path. CAPP-108:
    // when ultracode is ON `--effort` is SUPPRESSED — ultracode already forces xhigh
    // and passing both is undefined.
    const resolvedEffort = resolvedUltracode
      ? undefined
      : (typeof effort === "string" && effort.trim()) || this.defaultEffort
    if (resolvedEffort) args.push("--effort", resolvedEffort)
    if (resolvedUltracode) {
      // CAPP-117 — file-backed `--settings` (the inline JSON dies on the powershell
      // argv hop). If the file can't be written, OMIT the flag and warn: a spawn
      // without ultracode beats a dead terminal that never initializes.
      const settingsPath = this.ultracodeSettingsPath()
      if (settingsPath) {
        args.push("--settings", settingsPath)
      } else {
        logWarn("headless", `${id} — could not write the ultracode settings file; spawning WITHOUT ultracode`)
      }
    }
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
    const resume = resumeArgs(this.ccProjectsRoot, sessionCwd, resumeConvId)
    for (const a of resume) args.push(a)
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
      ultracode: resolvedUltracode,
      buffer: new LineBuffer(),
      sawInit: false,
      // BO-4b NO-INPUT IDLE: a freshly spawned `claude -p` (stream-json input)
      // emits NOTHING until the first user message lands on stdin, so the
      // event-driven idle machine would otherwise leave a brand-new structured
      // terminal pinned "active" (pulsing green) forever. Park it idle on spawn;
      // the first message flips it active via the normal idle→active edge.
      state: "idle",
      // CAPP-131 — the renderer's initial view of a freshly-spawned structured
      // terminal is "idle" (the returned info carries state:"idle"), so seed the
      // foreground-emit dedupe to match; the first foreground activity emits "active".
      fgEmitted: "idle",
      lastActivity: Date.now(),
      activeSince: undefined,
      // CAPP-132 — fresh (empty) OUTPUTS turn buffer per spawn (reset-on-spawn).
      derivedOutputs: newTurnBuffer(),
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
            // CAPP-113 — retain the RESOLVED full model id the init event reports
            // (diagnostic-only; surfaced as the picker's tooltip). SessionService
            // also watches this stream event to propagate it onto the terminal ref.
            if (typeof event.model === "string" && event.model.trim()) {
              entry.resolvedModel = event.model.trim()
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
      const text = String(chunk).trim()
      // CAPP-117 — retain the most recent non-empty stderr line so an exit-before-init
      // can be classified from what `claude` actually said (auth vs. a bad flag), not
      // blanket-assumed to be an auth failure.
      if (text) entry.lastStderr = text.slice(0, 500)
      logWarn("headless", `${id} stderr: ${text.slice(0, 200)}`)
    })
    proc.onExit(() => {
      // Flush any buffered final (newline-less) line before tearing down. A
      // process that exited on its own (not an explicit kill that already tore
      // it down) gets the needs-auth check.
      drain(entry.buffer.flush())
      this.teardownHeadless(id, { synthAuth: true })
    })
    // A bad cwd (TOCTOU after the statSync guard, or a caller-supplied cwd that
    // bypassed it) makes child_process.spawn emit an async 'error' (ENOENT)
    // INSTEAD of 'exit'. Without this listener that error is an uncaught
    // exception that crashes the main process. Route it through the SAME teardown
    // as a normal exit (mark dead, settle pending permissions, emit exit) so the
    // headless terminal degrades gracefully, plus a logged warning + a toast.
    proc.onError?.((err) => {
      logWarn("headless", `${id} spawn error: ${err?.message ?? err}`)
      this.notify?.(
        `Could not start the agent — ${err?.message ?? err}. Check the working directory.`,
        "error",
        "Agent spawn failed",
      )
      this.teardownHeadless(id, { synthAuth: false })
    })

    const info: TerminalInfo = { id, name: sessionName, cwd: sessionCwd, state: "idle", engine: "structured", model: resolvedModel, effort: resolvedEffort, ultracode: resolvedUltracode }
    this.emitEvent({ type: "created", info })

    this.bindConversation(id, sessionCwd, args, resumeConvId)
    return info
  }

  /**
   * Idempotent teardown for a headless terminal — shared by explicit `kill()`
   * (synthAuth=false: a deliberate kill is never an auth failure) and process
   * exit (synthAuth=true: an exit before any `init` event MIGHT be an auth failure,
   * but only when the captured stderr actually reads like one — see CAPP-117 below).
   * Running once is guaranteed by the `headless.has(id)` guard, so a kill followed by
   * the proc's own async exit doesn't double-emit.
   */
  private teardownHeadless(id: string, opts: { synthAuth: boolean }): void {
    const entry = this.headless.get(id)
    if (!entry) return
    entry.state = "dead"
    // BO-3 — settle any in-flight permission so a blocked approve_tool call
    // doesn't hang past the agent's life (a deny is the safe orphan resolution).
    this.rejectPendingPermissions(id, "agent-exited")
    if (opts.synthAuth && !entry.sawInit) {
      // CAPP-117 — an exit-before-init is NOT automatically an auth failure. Only
      // claim "not signed in" when the captured stderr actually reads like one;
      // otherwise surface the REAL stderr as a plain errored `result` so the next
      // spawn failure self-describes (e.g. a bad `--settings`/`--model`/flag) instead
      // of a misleading Sign-in banner. (The live post-init auth shape emits `init`
      // first and is classified by parseStreamLine, so it never reaches here.)
      const stderr = entry.lastStderr?.trim()
      if (stderr && AUTH_STDERR_RE.test(stderr)) {
        this.emitEvent({ type: "stream", id, event: { kind: "needs_auth", message: stderr } })
      } else {
        this.emitEvent({
          type: "stream",
          id,
          event: {
            kind: "result",
            isError: true,
            subtype: "spawn_failed",
            result: stderr
              ? `Claude Code exited before initializing: ${stderr}`
              : "Claude Code exited before initializing (no output).",
            raw: {},
          },
        })
      }
    }
    this.headless.delete(id)
    this.outputBuffers.delete(id)
    // CAPP-130 — a killed/exited terminal drops its queue (a respawn snapshots it
    // BEFORE the kill and re-installs onto the fresh id, so an interrupt/restart still
    // preserves it — see transferAgentQueue).
    this.dropAgentQueue(id)
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
    // text). Emitted for EVERY input path (composer, waitForIdle inject,
    // scheduler) since they all funnel through here. Empty/whitespace-only messages
    // (e.g. an attachment-only send) don't add a blank bubble.
    const text = msg.message.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("")
      .trim()
    if (text) this.emitEvent({ type: "stream", id, event: { kind: "user_message", text } })
    // A new user message starts a new turn — flip the structured terminal active
    // (parity with the PTY path's markActive on input). CAPP-131: mark the FOREGROUND
    // live from the moment we write to stdin (not just on the first assistant delta).
    // This closes the pre-first-delta hole where `foregroundActive` stayed false, so a
    // background task starting between send and first-delta could mask the foreground
    // turn; it also means markActiveHeadless re-emits foreground "active" to the
    // renderer even when a background hold already has the effective state active.
    entry.foregroundActive = true
    this.markActiveHeadless(entry)
    return true
  }

  // -------------------------------------------------------------------------
  // CAPP-130 — queued composer input. Send-while-busy ENQUEUES (per terminal);
  // queued messages auto-flush FIFO, one per turn, when the foreground goes idle.
  // -------------------------------------------------------------------------

  /**
   * CAPP-130 — the ONE entry point for a composer submission (the `agent:send-input`
   * IPC calls this). THE SERVICE DECIDES queue-vs-send, which kills the renderer↔
   * service race where the turn ends between the renderer's busy check and the IPC
   * arriving: if the FOREGROUND is busy (`foregroundActive` OR a parked permission —
   * the exact window from the stdin write to the turn's `result`/permission park),
   * the raw payload is ENQUEUED and a queue-changed event is emitted (returns
   * "queued"); otherwise it submits immediately through the shared path (returns
   * "sent", or false when the terminal is gone / the write fails).
   *
   * NATIVE slash commands (/config, /resume) BYPASS the queue entirely and fire
   * immediately even while busy: they route to a renderer app affordance and never
   * touch stdin, so the BO-10 buffer-unread hazard doesn't apply — and delaying
   * "open the config UI" to the end of a turn would be a pointless regression from
   * the pre-queue behavior (the old IPC handler fired them regardless of busy).
   * (flushAgentQueue keeps its native-drain branch as forward-compat defense: if a
   * command's classification changes to native while items sit queued, the flush
   * still drains it without stranding the rest of the queue.)
   */
  submitAgentInput(id: string, payload: { text?: string; attachments?: string[] }): "sent" | "queued" | false {
    if (classifySlashInput(payload?.text ?? "").kind === "native") {
      return this.submitAgentInputNow(id, payload) === false ? false : "sent"
    }
    const entry = this.headless.get(id)
    const foregroundBusy = (entry?.foregroundActive === true) || this.hasPendingPermission(id)
    if (entry && entry.state !== "dead" && foregroundBusy) {
      this.enqueueAgentInput(id, payload)
      return "queued"
    }
    return this.submitAgentInputNow(id, payload) === false ? false : "sent"
  }

  /**
   * CAPP-130 — the SHARED submit path both a fresh send and a queue flush funnel
   * through, so a queued item routes EXACTLY like a fresh one. Classifies the input
   * first (BO-7): a native-mapped built-in (/config, /resume) fires the renderer app
   * affordance via `ui:slash-command` and does NOT touch stdin ("native"); everything
   * else — Claude built-ins, skills, custom commands, prose — is folded into a
   * structured user message and written to the stdin sink ("sent"). Returns false
   * when the message could not be sent (unknown/dead terminal). Previously lived in
   * the `agent:send-input` IPC handler; centralized here so the flush can reuse it.
   */
  private submitAgentInputNow(id: string, payload: { text?: string; attachments?: string[] }): "sent" | "native" | false {
    const route = classifySlashInput(payload?.text ?? "")
    if (route.kind === "native") {
      const p: UiSlashCommandPayload = { command: route.command, terminalId: id }
      this.sendToRenderer(UI_SLASH_COMMAND_CHANNEL, p)
      return "native"
    }
    return this.sendAgentMessage(id, agentMessageFromInput(payload ?? {})) ? "sent" : false
  }

  /** CAPP-130 — append a raw payload to a terminal's queue + emit the changed snapshot. */
  private enqueueAgentInput(id: string, payload: { text?: string; attachments?: string[] }): void {
    const item: QueuedAgentInput = {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: payload?.text,
      attachments: payload?.attachments && payload.attachments.length ? [...payload.attachments] : undefined,
      queuedAt: Date.now(),
    }
    const q = this.agentQueues.get(id) ?? []
    q.push(item)
    this.agentQueues.set(id, q)
    this.emitAgentQueueChanged(id)
  }

  /** CAPP-130 — the current queued-input snapshot for a terminal (a copy; empty when
   *  none). Backs the `terminal:get-agent-queue` pull the composer does on mount/switch. */
  getAgentQueue(id: string): QueuedAgentInput[] {
    return (this.agentQueues.get(id) ?? []).map((x) => ({ ...x }))
  }

  /** CAPP-130 — remove ONE queued item by its queued id. Returns false when the item
   *  is unknown (already flushed / removed) — a safe no-op, so removing a mid-flight
   *  item that just flushed does nothing. Emits queue-changed when it removes. */
  removeQueuedInput(id: string, queuedId: string): boolean {
    const q = this.agentQueues.get(id)
    if (!q) return false
    const i = q.findIndex((x) => x.id === queuedId)
    if (i < 0) return false
    q.splice(i, 1)
    if (q.length === 0) this.agentQueues.delete(id)
    this.emitAgentQueueChanged(id)
    return true
  }

  /** CAPP-130 — emit the foreground-renderer queue-changed push for a terminal. */
  private emitAgentQueueChanged(id: string): void {
    this.sendToRenderer(AGENT_QUEUE_CHANGED_CHANNEL, id, this.getAgentQueue(id))
  }

  /** CAPP-130 — drop a terminal's queue (kill/teardown). Emits an (empty) snapshot
   *  only if there was something to drop, so a plain kill of a queue-less terminal is
   *  byte-quiet. */
  private dropAgentQueue(id: string): void {
    if (!this.agentQueues.has(id)) return
    this.agentQueues.delete(id)
    this.emitAgentQueueChanged(id)
  }

  /**
   * CAPP-130 — carry a terminal's queue across a respawn re-point (Stop/interrupt,
   * restart, model/effort/ultracode switch, engine switch, handoff — each mints a NEW
   * terminal id and SessionService re-points the ref in place). Queued messages SURVIVE
   * the respawn ("the user still wants it said"). Moves queue[oldId] → queue[newId] and
   * flushes the head onto the fresh idle terminal (the fresh `claude -p` is dormant until
   * stdin, so booting it with the queued message is the fire-and-forget the owner wants).
   *
   * `carried` is an OPTIONAL pre-captured snapshot for the seam where the respawn kill
   * runs BEFORE the new spawn (respawnRefWithEngine): kill() drops queue[oldId], so that
   * seam snapshots the queue with getAgentQueue() before the kill and passes it here. The
   * handoff seam (spawn-before-kill) passes no snapshot and this reads the live queue[oldId].
   */
  transferAgentQueue(oldId: string, newId: string, carried?: QueuedAgentInput[]): void {
    const q = carried ?? this.agentQueues.get(oldId) ?? []
    if (this.agentQueues.has(oldId)) {
      this.agentQueues.delete(oldId)
      this.emitAgentQueueChanged(oldId)
    }
    if (q.length === 0 || oldId === newId) return
    const existing = this.agentQueues.get(newId) ?? []
    this.agentQueues.set(newId, [...existing, ...q.map((x) => ({ ...x }))])
    this.emitAgentQueueChanged(newId)
    // Boot the fresh idle terminal with the head (dormant-until-stdin fire-and-forget).
    this.scheduleAgentQueueFlush(newId)
  }

  /**
   * CAPP-130 — defer a flush past the current stream-event processing (queueMicrotask)
   * to avoid re-entrancy inside {@link onStructuredEvent}. Test-observable: awaiting a
   * tick (`await Promise.resolve()` / a 0ms timeout) runs the pending flush.
   */
  private scheduleAgentQueueFlush(id: string): void {
    queueMicrotask(() => this.flushAgentQueue(id))
  }

  /**
   * CAPP-130 — flush ONE queued message FIFO, if the terminal is live, the foreground
   * is truly idle, and no permission is parked (writing to a permission-parked stdin
   * would buffer unread — the BO-10 reason this was blocked). A flushed "send" flips
   * `foregroundActive` true again, so the NEXT `result` flushes the next item (one per
   * turn). A flushed "native" command starts no turn, so we drain the next head too.
   */
  private flushAgentQueue(id: string): void {
    const entry = this.headless.get(id)
    if (!entry || entry.state === "dead") return
    if (entry.foregroundActive === true || this.hasPendingPermission(id)) return
    const q = this.agentQueues.get(id)
    if (!q || q.length === 0) return
    const next = q.shift()!
    if (q.length === 0) this.agentQueues.delete(id)
    this.emitAgentQueueChanged(id)
    const result = this.submitAgentInputNow(id, { text: next.text, attachments: next.attachments })
    // A native command (fired an app affordance, no turn started) leaves the foreground
    // idle → there's no `result` coming to drive the next flush, so drain the next head.
    if (result === "native") this.scheduleAgentQueueFlush(id)
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
   *
   * CAPP-126 — `live` reports whether a LIVE `init` has arrived on THIS spawn
   * (`sawInit`), vs. a catalog seeded from the persisted ref on restore. Freshness is
   * a property of the SPAWN, not of the picker component — the composer remounts on
   * every terminal switch and must not re-show the "from last session" hint for a
   * catalog init already refreshed this process.
   */
  getCatalog(id: string): (AgentCatalog & { live: boolean }) | null {
    const entry = this.headless.get(id)
    if (!entry?.catalog) return null
    return { ...entry.catalog, live: entry.sawInit === true }
  }

  /**
   * CAPP-126 — seed a headless terminal's picker catalog from a persisted copy (the
   * SessionService ref, captured off a previous session's `init`). Called on RESTORE
   * (`reopenTerminal`) so the `/`-autocomplete works immediately with last session's
   * catalog BEFORE the first turn re-emits `init`. Only fills an entry that has no
   * catalog yet — a fresh live `init` (which lands after the first message) always
   * WINS and is never clobbered. No-op for an unknown / xterm (non-headless) terminal.
   */
  seedCatalog(id: string, catalog: AgentCatalog): void {
    const entry = this.headless.get(id)
    if (entry && !entry.catalog) entry.catalog = catalog
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
      case "tool_use":
        entry.foregroundActive = true
        this.markActiveHeadless(entry)
        // CAPP-132 — DERIVE a file draft from a Write/Edit/NotebookEdit tool_use into
        // this turn's buffer (coalesced + first-touch order; flushed at `result`).
        this.deriveFileOutput(entry, event)
        break
      case "assistant_delta":
      case "thinking_delta":
      case "tool_result":
        entry.foregroundActive = true
        this.markActiveHeadless(entry)
        break
      case "background_task_started":
        this.addBackgroundTask(entry, event.taskId)
        break
      case "background_task_done":
        this.removeBackgroundTask(entry, event.taskId)
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
        // Foreground turn complete. Park idle ONLY if no background task is still
        // running; otherwise HOLD active (green) — the session is still working
        // (the reported bug: `result` used to idle unconditionally, so a session that
        // had launched background work looked "done"). When the last background task
        // drains (or is pruned), reconcile parks it idle → AttentionService then sees
        // the `finished`/`asked` transition, so the "needs you?" signal fires when the
        // WHOLE thing is actually done, not at the foreground turn's end.
        entry.foregroundActive = false
        // CAPP-131 — the FOREGROUND turn is done: tell the renderer idle NOW so the
        // composer Send re-enables immediately, EVEN IF a background task still holds
        // the effective state active. (This was THE bug: `result` during background
        // work left the terminal in the renderer's generating set, so Send stayed
        // disabled though stdin was writable and the foreground was idle.) The
        // effective machine + AttentionService are handled by reconcileHeadless below
        // (which, holding active for background, deliberately does NOT re-emit here).
        this.emitForegroundState(entry, "idle")
        this.reconcileHeadless(entry)
        // CAPP-129 — emit this turn's PER-TURN cost delta BEFORE the CAPP-130 queue flush
        // (so event order reads turn-complete → cost → next queued turn). `total_cost_usd`
        // is CUMULATIVE per process (the CAPP-125 trap), so convert to a delta off THIS
        // proc's last cumulative (undefined baseline on a fresh spawn/resume → the raw
        // cumulative, which excludes pre-resume history). REUSE extractCost/toPerTurnCost —
        // never a forked copy of the math. `totalTokens` is already per-turn (top-level usage).
        this.emitTurnCost(entry, event)
        // CAPP-132 — flush this turn's DERIVED OUTPUTS as ONE batch (files in touch
        // order, then links from the final text), right AFTER the cost emit and BEFORE
        // the queue flush (order: cost → outputs → queue-flush). Never a blocking gate.
        this.emitTurnOutputs(entry, event)
        // CAPP-130 — the foreground turn ended: auto-flush ONE queued message FIFO.
        // Deferred a tick (avoids re-entrancy inside this handler). NEVER flush while a
        // permission is still pending at result-time (stdin would buffer unread); the
        // flush itself re-checks that guard. The flushed send re-arms foregroundActive,
        // so the next `result` flushes the next item — one message per turn.
        if (!this.hasPendingPermission(entry.id) && (this.agentQueues.get(entry.id)?.length ?? 0) > 0) {
          this.scheduleAgentQueueFlush(entry.id)
        }
        break
      // needs_auth/unknown/user_message carry no activity signal.
    }
  }

  /**
   * CAPP-129 — compute a turn's PER-TURN cost delta off a `result` event and emit it on
   * the onEvent seam for SessionService to fold into the durable rolling totals.
   *
   * THE CAPP-125 TRAP: `result.total_cost_usd` is CUMULATIVE per process, so summing it
   * across turns triangular-overcounts. We keep the LAST raw cumulative per HeadlessTerminal
   * ({@link HeadlessTerminal.lastCumulativeCostUsd}) and delta off it via the SHARED
   * {@link toPerTurnCost} (reset-safe: a lower cumulative — a fresh `--resume` proc —
   * contributes its own cost, never a negative). A respawn mints a fresh entry, so the
   * baseline is undefined and the first delta is that proc's raw cumulative (which excludes
   * pre-resume history per the CAPP-125 fixtures — no double-count across the re-point).
   *
   * `totalTokens` comes straight from {@link extractCost} (top-level `usage`, already
   * per-turn — safe as-is). Emits even when neither field is present so the session's
   * per-turn count still advances; SessionService guards a (defensive) negative delta to 0.
   */
  private emitTurnCost(entry: HeadlessTerminal, event: StreamEvent): void {
    if (event.kind !== "result") return
    const raw = extractCost(event.raw)
    const perTurn = toPerTurnCost(raw, entry.lastCumulativeCostUsd ?? 0)
    if (perTurn.cumulativeCostUsd != null) entry.lastCumulativeCostUsd = perTurn.cumulativeCostUsd
    this.emitEvent({
      type: "cost",
      id: entry.id,
      costUsd: perTurn.costUsd,
      totalTokens: perTurn.totalTokens,
    })
  }

  /**
   * CAPP-132 — derive a FILE draft from a Write/Edit/NotebookEdit tool_use into the
   * terminal's current turn buffer. `event.input` is `unknown` (the raw tool args), so
   * we read `file_path`/`notebook_path` DEFENSIVELY — a missing/non-string field is
   * skipped (never throws). The same path touched twice in a turn coalesces to ONE draft
   * (addFileTouch keeps first-touch order). Other tool names are ignored (deliverables,
   * not a play-by-play of every tool call).
   */
  private deriveFileOutput(entry: HeadlessTerminal, event: StreamEvent): void {
    if (event.kind !== "tool_use") return
    if (event.name !== "Write" && event.name !== "Edit" && event.name !== "NotebookEdit") return
    const input = event.input
    if (!input || typeof input !== "object") return
    const rec = input as Record<string, unknown>
    const filePath = rec.file_path ?? rec.notebook_path
    if (!entry.derivedOutputs) entry.derivedOutputs = newTurnBuffer()
    addFileTouch(entry.derivedOutputs, filePath)
  }

  /**
   * CAPP-132 — at a turn's `result`, FLUSH the whole turn buffer into ONE `{type:"output"}`
   * batch (files in touch order, then links extracted from the final assistant text, minus
   * anything an explicit post suppressed; per-turn noise caps applied). Then RESET the buffer
   * (reset-after-flush). Emits nothing when the turn produced no deliverables.
   */
  private emitTurnOutputs(entry: HeadlessTerminal, event: StreamEvent): void {
    if (event.kind !== "result") return
    const buf = entry.derivedOutputs ?? newTurnBuffer()
    const resultText = typeof event.result === "string" ? event.result : ""
    const drafts = flushTurn(buf, resultText)
    entry.derivedOutputs = newTurnBuffer() // reset for the next turn
    if (drafts.length > 0) this.emitEvent({ type: "output", id: entry.id, outputs: drafts })
  }

  /**
   * CAPP-132 — the EXPLICIT `post_output` path (design §4.B), routed here by the MCP tool.
   * (a) Forwards the entry IMMEDIATELY on the same `{type:"output"}` seam, so an agent post
   * appears MID-turn (not deferred to `result`), and (b) records its dedupe key in the current
   * turn buffer's suppress set so the result-flush DROPS a matching derived draft (explicit
   * beats derived — the agent's title wins). Works for xterm terminals too (they have no
   * headless entry / turn buffer, so only the forward happens — path B only, per the design).
   */
  postExplicitOutput(terminalId: string, entry: RailOutputDraft): boolean {
    const h = this.headless.get(terminalId)
    if (h) {
      if (!h.derivedOutputs) h.derivedOutputs = newTurnBuffer()
      suppressDerived(h.derivedOutputs, entry)
    }
    this.emitEvent({ type: "output", id: terminalId, outputs: [entry] })
    return true
  }

  /**
   * CAPP-131 — the FOREGROUND-ONLY renderer `terminal:state` emit for a structured
   * terminal. The renderer's `useGeneratingTerminals` gates the composer Send off this
   * channel, so it must follow the FOREGROUND turn only — never the background-work hold
   * that keeps the EFFECTIVE machine ({@link HeadlessTerminal.state}) active. Deduped on
   * {@link HeadlessTerminal.fgEmitted} (NOT `state`): that both suppresses redundant
   * pushes AND lets a foreground turn emit "active" while a background task already holds
   * `state` active (the latent bug — there'd be no idle→active edge to fire on otherwise).
   * The effective machine + AttentionService ride the separate `emitEvent({type:"state"})`
   * bus, which is unchanged. The PTY path keeps its own raw sendToRenderer.
   */
  private emitForegroundState(entry: HeadlessTerminal, state: "active" | "idle"): void {
    if (entry.fgEmitted === state) return
    entry.fgEmitted = state
    this.sendToRenderer("terminal:state", entry.id, state)
  }

  /** Flip a structured terminal active on new activity; emits state only on the
   *  idle→active edge (mirrors the PTY `markActive`). Real activity also cancels any
   *  pending background settle (a woken follow-up turn keeps the session green).
   *  CAPP-131 — every caller (sendAgentMessage, the activity cases of
   *  onStructuredEvent, resolvePermission) is genuine FOREGROUND activity, so the
   *  renderer emit here is the foreground-only push; it sits OUTSIDE the idle→active
   *  guard so a foreground turn resuming under a background hold (state already active)
   *  still tells the renderer "active". */
  private markActiveHeadless(entry: HeadlessTerminal): void {
    entry.lastActivity = Date.now()
    entry.bgSettleAt = undefined
    this.emitForegroundState(entry, "active")
    if (entry.state === "idle") {
      entry.state = "active"
      entry.activeSince = entry.lastActivity
      this.emitEvent({ type: "state", id: entry.id, state: "active" })
    }
  }

  /**
   * BACKGROUND WORK — the effective active/idle state is `foregroundActive OR any
   * background task outstanding`. Called whenever either input changes (`result`,
   * task start/done, prune): flips to active if it should be and isn't, or parks idle
   * via {@link idleHeadless} when neither the turn nor any background work remains.
   * The active edge mirrors {@link markActiveHeadless} but does NOT bump `lastActivity`
   * (a background hold is not foreground output).
   */
  private reconcileHeadless(entry: HeadlessTerminal): void {
    const shouldBeActive = entry.foregroundActive === true || (entry.backgroundTasks?.size ?? 0) > 0
    if (shouldBeActive) {
      entry.bgSettleAt = undefined // work is (still) happening — cancel any pending settle
      if (entry.state === "idle") {
        entry.state = "active"
        entry.activeSince = entry.activeSince ?? Date.now()
        // CAPP-131 — NO renderer emit here: this active edge is BACKGROUND-ONLY (a
        // background task started while the foreground was idle; a foreground turn
        // takes the markActiveHeadless path instead). The renderer's Send-gating
        // generating set must track the FOREGROUND turn only — the sidebar/TabBar
        // green dot is driven independently off the effective machine (this emitEvent
        // → lastState) and the backgroundCount badge. Emitting "active" to the
        // renderer here is exactly what wedged Send off during background-only work.
        this.emitEvent({ type: "state", id: entry.id, state: "active" })
      }
    } else {
      this.idleHeadless(entry)
    }
  }

  /** BACKGROUND WORK — record a launched background task and refresh the sidebar count.
   *  Also reconciles state (defensive: a start while somehow idle re-greens the row). */
  private addBackgroundTask(entry: HeadlessTerminal, taskId: string): void {
    if (!entry.backgroundTasks) entry.backgroundTasks = new Map()
    if (entry.backgroundTasks.has(taskId)) return
    entry.backgroundTasks.set(taskId, Date.now())
    this.reconcileHeadless(entry)
    this.emitEvent({ type: "background", id: entry.id })
  }

  /**
   * BACKGROUND WORK — drop a completed background task and refresh the sidebar count. If
   * the foreground turn is live or other tasks remain, the session simply stays green. If
   * this drained the LAST task with no live turn, we do NOT idle synchronously — a
   * completion frequently wakes a follow-up turn, so we ARM a short settle ({@link
   * bgSettleAt}) that the idle monitor confirms (a woken turn cancels it via markActive).
   * This avoids the active→idle→active flap and the spurious "finished" it would raise.
   */
  private removeBackgroundTask(entry: HeadlessTerminal, taskId: string): void {
    if (!entry.backgroundTasks || !entry.backgroundTasks.delete(taskId)) return
    this.emitEvent({ type: "background", id: entry.id })
    const stillWorking = entry.foregroundActive === true || entry.backgroundTasks.size > 0
    if (!stillWorking && entry.state === "active") entry.bgSettleAt = Date.now()
  }

  /**
   * BACKGROUND WORK — outstanding background-task count for a terminal (0 for an unknown
   * or non-headless terminal). SessionService.withEffectiveActivity reads this into the
   * session snapshot so the sidebar renders the `⚙ N` badge.
   */
  backgroundCount(terminalId: string): number {
    return this.headless.get(terminalId)?.backgroundTasks?.size ?? 0
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
    // CAPP-131 — foreground-only renderer emit (deduped). On the whole-work idle edge
    // (foreground result already emitted idle, then a background drain settles here)
    // this is a no-op push; on the permission-park edge (markAwaitingPermission →
    // idleHeadless while fgEmitted="active") it's the LIVE emit that hands the composer
    // busy-ownership to the pending-permission queue, exactly as before. The effective
    // machine + AttentionService ride the unchanged emitEvent bus below.
    this.emitForegroundState(entry, "idle")
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
    // CAPP-131 — foreground-only renderer emit (deduped). A permission requested while
    // the terminal is already idle: fgEmitted is already "idle", so this is a no-op
    // push to the renderer (the composer hands busy-ownership to the pending-permission
    // queue regardless); the emitEvent below still raises the tier-2 "asked".
    this.emitForegroundState(entry, "idle")
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
    this.dropAgentQueue(id) // CAPP-130 — an xterm terminal has no composer queue, but stay symmetric.
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
    // companion panel input, list_sessions) must see structured
    // terminals or they'd be invisible the moment the engine switch is on.
    const ptys = Array.from(this.terminals.values()).map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      state: s.state,
      engine: "xterm" as const,
      // CAPP-54 gate ② (re-review BLOCKER) — carry isLogin on the returned object.
      // Consumers that special-case the live `claude /login` OAuth PTY rely on the
      // flag surviving list(). The login PTY is always xterm, but we copy it on both
      // branches for consistency.
      isLogin: s.isLogin,
    }))
    const headless = Array.from(this.headless.values()).map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      state: s.state,
      engine: "structured" as const,
      model: s.model,
      resolvedModel: s.resolvedModel,
      effort: s.effort,
      ultracode: s.ultracode,
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
    // is the big BO-5 review item: get_session_activity reads getActivity(), so a
    // healthy headless worker would be seen as "absent => stalled" without this inclusion.
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
    // BO-4a (CAPP-81): a structured terminal lives in `this.headless`, NOT
    // `this.terminals`. Check it FIRST — mirroring kill()/write() — or a rename of a
    // headless tab silently no-ops (returns false, never emits terminal:renamed), so
    // the renderer's onSessionRenamed never fires and the tab snaps back.
    const head = this.headless.get(id)
    if (head) {
      head.name = newName
      this.sendToRenderer("terminal:renamed", id, newName)
      this.emitEvent({ type: "renamed", id, name: newName })
      return true
    }
    const terminal = this.terminals.get(id)
    if (!terminal) return false
    terminal.name = newName
    this.sendToRenderer("terminal:renamed", id, newName)
    this.emitEvent({ type: "renamed", id, name: newName })
    return true
  }

  write(id: string, data: string): void {
    // BO-5: a structured terminal has no interactive PTY — its stdin is the
    // stream-json user-message sink. Route legacy write() callers (panel
    // input, handoff force-flush) there instead
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
    this.agentQueues.clear() // CAPP-130 — queues are in-memory only; drop them all on teardown.
    this.identityTokens.clear()
    this._assigner?.dispose()
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
  }
}
