/**
 * BO-1 — the CANONICAL, shared contract for the headless stream-json transport.
 *
 * This module is the single source of truth that later tickets IMPORT (do not
 * redefine): BO-2 (renderer) consumes `StreamEvent` + the IPC channel; BO-3
 * (input composer / programmatic permissions) consumes `AgentUserMessage`,
 * `PermissionRequest`, `PermissionDecision`; BO-4 (rollout) references
 * `HEADLESS_FLAGS` to wire the engine switch. Everything here is types +
 * constants only — zero runtime deps — so it can be imported from any layer
 * (main, preload, renderer) without pulling in node-pty/child_process.
 *
 * The shapes were pinned against a REAL `claude -p` run (see
 * streamEvents.fixtures.ts), not invented.
 */

// ---------------------------------------------------------------------------
// Spawn flag set — ONE named constant (BO-4 references this, not a string copy)
// ---------------------------------------------------------------------------

/**
 * The headless stream-json flag set, EXACTLY as the acceptance criteria pin it.
 * `--mcp-config <path>` and (when resuming) `--resume <id>` are appended by the
 * spawn helper on top of these — they are per-terminal and so are not baked into
 * the constant. Deliberately does NOT include `--dangerously-skip-permissions`:
 * permission handling on the headless path is programmatic and lands in BO-3.
 *
 *   claude -p --output-format stream-json --input-format stream-json \
 *     --include-partial-messages --verbose
 */
export const HEADLESS_FLAGS: readonly string[] = [
  "-p",
  "--output-format",
  "stream-json",
  "--input-format",
  "stream-json",
  "--include-partial-messages",
  "--verbose",
]

// ---------------------------------------------------------------------------
// Model control (BO-6) — the `--model` knob for the headless engine.
//
// A RESUMED `claude -p` session keeps the model it was SAVED with regardless of
// the current default, so a transcript written while a now-disabled model (e.g.
// fable-5) was default 404s forever on every turn. Passing `--model` on the spawn
// OVERRIDES that pin (proven live), so we always pass it on BOTH the fresh and the
// resume path. The picker offers ALIASES, never pinned version ids: an alias
// (`opus`, `sonnet`, …) resolves to the latest model for the user's tier and is
// immune to a specific version being disabled — exactly the failure that bit
// fable-5. This module is zero-runtime-dep, so the renderer picker and the main
// process share ONE source of truth for the alias list + the default.
// ---------------------------------------------------------------------------

/**
 * The model aliases offered in the structured-engine picker. Order = picker order.
 *
 * CAPP-113 — "never-stale": Claude Code exposes NO dynamic model discovery (no CLI
 * list command, no SDK call, no local file), so this is the full documented alias
 * set. An alias resolves to the latest model for the user's tier and is immune to a
 * specific pinned version being disabled (the fable-5 failure). Staleness is made
 * recoverable WITHOUT a code edit via config `models.extra` (see
 * {@link resolveModelOptions}) + the picker's free-text "Custom…" entry.
 */
export const MODEL_ALIASES: readonly string[] = [
  "best",
  "fable",
  "opus",
  "opus[1m]",
  "sonnet",
  "sonnet[1m]",
  "haiku",
  "opusplan",
]

/** The default model when `config.rendering.model` is unset — the `opus` alias. */
export const DEFAULT_MODEL = "opus"

/**
 * CAPP-113 — the effective, config-extensible model list the picker offers, derived
 * PURELY (no filesystem) so it's Node-testable + shared by the renderer picker: the
 * built-in {@link MODEL_ALIASES} UNION `models.extra`, MINUS `models.hidden`, order
 * preserved (aliases first, extras after) and de-duplicated. A malformed/absent
 * `models` block degrades to just the aliases (each field is type-guarded, never
 * throws). Hidden takes precedence over extra (an entry in both is hidden).
 */
export function resolveModelOptions(
  aliases: readonly string[],
  models?: { extra?: unknown; hidden?: unknown } | null,
): string[] {
  const clean = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
      : []
  const extra = clean(models?.extra)
  const hidden = new Set(clean(models?.hidden))
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of [...aliases, ...extra]) {
    const v = typeof raw === "string" ? raw.trim() : ""
    if (!v || seen.has(v) || hidden.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

// ---------------------------------------------------------------------------
// Reasoning-effort control (CAPP-46) — the `--effort` knob for the headless
// engine. `claude.exe` accepts a real `--effort <level>` spawn flag (proven by
// a live probe), working on the headless path exactly like `--model`.
//
// CRUCIAL difference from `--model`: there is NO DEFAULT_EFFORT and we do NOT
// always pass `--effort`. When the user hasn't picked a level the flag is OMITTED
// entirely, so the default spawn is BYTE-UNCHANGED (Claude uses its own built-in
// effort default). `--effort` has no resume-pin bug (unlike a saved model id that
// can 404), so there's nothing to force on the resume path — we only pass it once
// the user explicitly picks a level. This module is zero-runtime-dep, so the
// renderer picker and the main process share ONE source of truth for the levels.
// ---------------------------------------------------------------------------

/** The reasoning-effort levels offered in the structured-engine picker. Order = picker order. */
export const EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"]

// ---------------------------------------------------------------------------
// Ultracode control (CAPP-108) — a per-session BOOLEAN knob for the headless
// engine. Ultracode is a Claude Code SESSION SETTING (xhigh reasoning + auto
// dynamic-workflows), enabled by passing `--settings '{"ultracode":true}'` on the
// spawn. It is NOT `--effort` (that flag only takes low/medium/high/xhigh/max);
// ultracode forces xhigh internally, so when ultracode is ON the spawn OMITS
// `--effort` (passing both is undefined behavior). The flag was live-verified on
// this machine's `claude` (v2.1.170: `--settings <file-or-json>` exists).
//
// CAPP-117 — this payload is the FILE CONTENT of a temp settings file passed as
// `--settings <path>`, NOT an inline JSON argument. The embedded `{ } " :` do NOT
// survive the powershell→claude argv hop on Windows (the downstream-argv quirk
// documented in shellWrap.test.ts:20-24): even correctly single-quoted, the interior
// double quotes reach `claude` mangled and it dies instantly with
// `Error: Invalid JSON provided to --settings` (live-verified, claude v2.1.198). A
// bare file PATH has no interior metachars, so it round-trips intact — see
// TerminalService.ultracodeSettingsPath. This module is zero-runtime-dep, so the
// renderer toggle and the main process share ONE source of truth for the settings
// payload + the xhigh-model gate.
// ---------------------------------------------------------------------------

/** CAPP-108/117 — the `--settings` JSON value that enables ultracode. Written to a
 *  temp FILE and passed as `--settings <path>` (the inline JSON dies on the Windows
 *  powershell→claude argv hop — see the note above). */
export const ULTRACODE_SETTINGS = `{"ultracode":true}`

/** CAPP-108/113 — model ALIAS prefixes that support `xhigh` reasoning (and thus can
 *  honor ultracode, which forces xhigh). Matched case-insensitively by prefix so
 *  `opus`, `opus[1m]`, `fable`, `best`, `opusplan` all resolve; Sonnet and Haiku are
 *  deliberately absent. Pinned FULL ids (`claude-opus-4-8`, `claude-fable-5-…`) are
 *  matched by the family-substring branch in {@link modelSupportsXhigh}, not here. */
export const XHIGH_MODELS: readonly string[] = ["opus", "fable", "best", "opusplan"]

/** CAPP-113 — full-id family substrings that mark an xhigh-capable model. A pinned id
 *  (`claude-opus-4-8`, `claude-fable-5-20260101`) does NOT start with an alias prefix
 *  (it starts with `claude-`), so it's matched by `includes` on these instead. */
const XHIGH_ID_FAMILIES: readonly string[] = ["opus-4", "fable"]

/**
 * CAPP-108/113 — does the given `--model` (alias or pinned id) support `xhigh`
 * reasoning? Gates the ultracode toggle's visibility (ultracode forces xhigh, so a
 * non-xhigh model can't honor it). Opus / Fable / Best / opusplan support xhigh;
 * Sonnet / Haiku do not. An empty/undefined model defaults to the `opus` alias
 * (DEFAULT_MODEL), which DOES support xhigh, so a fresh terminal shows the toggle.
 * Case-insensitive. Three match strategies (any hit → true):
 *   1. alias prefix    — `m` starts with one of {@link XHIGH_MODELS} (`opus[1m]`, …)
 *   2. full-id family  — `m` contains `opus-4` or `fable` (pinned `claude-opus-4-8`)
 *   3. config override — `m` starts with one of `extraXhigh` (config `models.xhigh`),
 *      an ADDITIVE escape hatch so a NEW xhigh-capable model is honored with no code
 *      edit. Empty/absent override changes nothing (byte-identical to the alias-only
 *      behavior), so existing callers/tests are unaffected.
 */
export function modelSupportsXhigh(model?: string, extraXhigh?: readonly string[]): boolean {
  const m = (model && model.trim() ? model : DEFAULT_MODEL).trim().toLowerCase()
  const extra = Array.isArray(extraXhigh)
    ? extraXhigh.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim().toLowerCase())
    : []
  if ([...XHIGH_MODELS, ...extra].some((x) => m.startsWith(x))) return true
  if (XHIGH_ID_FAMILIES.some((x) => m.includes(x))) return true
  return false
}

// ---------------------------------------------------------------------------
// Output: the typed event union the parser produces
// ---------------------------------------------------------------------------

/** One mcp server's connection status as reported in the `init` event. */
export interface McpServerStatus {
  name: string
  /** e.g. "connected" | "pending" | "needs-auth" | "failed" (Claude Code-defined). */
  status: string
}

/**
 * BO-7 (CAPP-41) — the per-terminal catalog of invokable `/`-names the headless
 * `init` event reports: built-in + custom slash commands, and (a single unified
 * namespace in this Claude Code version) skills. Captured LIVE from `init`, never
 * hardcoded — the structured composer's `/`-autocomplete picker sources from this.
 */
export interface AgentCatalog {
  /** The `slash_commands` array (built-ins like clear/compact + custom commands). */
  slashCommands: string[]
  /** The `skills` array (the user's skills + all enabled plugin skills). */
  skills: string[]
}

/**
 * The transport's output: a tolerant, forward-compatible discriminated union.
 * A single NDJSON line can yield 0..N of these (an `assistant` message bundles
 * several content blocks), so the parser returns `StreamEvent[]`.
 *
 * `needs_auth` arrives via TWO seams (both funnel into this one event so consumers
 * watch a single stream): (a) SYNTHESIZED by the transport when a headless process
 * exits without ever emitting an `init` event (a clean non-interactive auth
 * failure), and (b) PARSED from a line by `parseStreamLine` (CAPP-39 gate ②) — the
 * exact-discriminant `assistant` event whose top-level `error` is
 * "authentication_failed". The trailing `is_error` result the live failure also
 * emits is NOT parsed as needs_auth; the reducer coalesces it into the banner only
 * when one was already raised this turn.
 */
export type StreamEvent =
  | {
      kind: "init"
      sessionId?: string
      cwd?: string
      model?: string
      tools?: string[]
      mcpServers?: McpServerStatus[]
      /** BO-7 — the `slash_commands` array (built-in + custom commands). */
      slashCommands?: string[]
      /** BO-7 — the `skills` array (user + enabled plugin skills). */
      skills?: string[]
      /** "none" on a subscription login (no API key). */
      apiKeySource?: string
      /** The full original event — forward-compat for fields we don't model. */
      raw: unknown
    }
  | { kind: "assistant_delta"; text: string }
  | { kind: "thinking_delta"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; content: unknown; isError?: boolean }
  | {
      kind: "result"
      /** e.g. "success" | "error_max_turns" | … (Claude Code-defined). */
      subtype?: string
      isError: boolean
      /** Final assistant text for the turn, when present. */
      result?: string
      raw: unknown
    }
  | { kind: "needs_auth"; message?: string }
  /**
   * BO-4b — the user's OWN outgoing message, echoed onto the same stream seam by
   * the transport (sendAgentMessage) when we send to stdin. It is NOT parsed from
   * Claude's stdout (Claude doesn't echo the user turn back as text), so without
   * this synthetic event the AgentView would render a one-sided log with no record
   * of what the user typed. The renderer folds it into a `user` chat block.
   */
  | { kind: "user_message"; text: string }
  /**
   * BACKGROUND WORK — a background task (a `Bash(run_in_background:true)`, a
   * TaskCreate/Workflow, …) was LAUNCHED. Parsed from the tool_result whose content
   * reads `Command running in background with ID: <taskId>. Output is being written to:
   * …`. The transport counts these per terminal so the session stays "working" (green)
   * after the foreground `result` while detached work continues — instead of falsely
   * dropping to idle. `taskId` correlates 1:1 with the completing {@link
   * background_task_done} (both carry the SAME id).
   */
  | { kind: "background_task_started"; taskId: string }
  /**
   * BACKGROUND WORK — a background task COMPLETED. Parsed from the `<task-notification>`
   * user message Claude Code injects when a detached task finishes (it carries
   * `<task-id>…</task-id>`). Drains the terminal's outstanding-set; when it empties AND
   * the foreground turn has ended, the session finally parks idle. The SAME line also
   * yields a {@link user_message} carrying the raw wrapper, which the reducer renders as
   * a compact "background task" chip (CAPP-118) so completion is visible live.
   */
  | { kind: "background_task_done"; taskId: string }
  /** Forward-compat escape hatch: an unrecognized top-level event type. */
  | { kind: "unknown"; raw: unknown }

// ---------------------------------------------------------------------------
// Input: the stdin sink contract (BO-3 builds the composer; BO-1 exposes this)
// ---------------------------------------------------------------------------

/** A single content block of a user message. (Text only for now; BO-3 extends.) */
export interface AgentTextBlock {
  type: "text"
  text: string
}

export type AgentContentBlock = AgentTextBlock

/**
 * A structured user message sent to a headless agent over stdin
 * (`--input-format stream-json`). This is the exact shape verified live:
 *   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
 */
export interface AgentUserMessage {
  type: "user"
  message: {
    role: "user"
    content: AgentContentBlock[]
  }
}

/** Convenience builder for the common single-text-block user message. */
export function userMessage(text: string): AgentUserMessage {
  return { type: "user", message: { role: "user", content: [{ type: "text", text }] } }
}

/**
 * BO-3 — fold the composer's `{ text, attachments }` into one structured user
 * message. Image attachments are saved to disk (saveDroppedImage) and referenced
 * by quoted path, matching the legacy PTY behavior (`writeToSession("\"path\" ")`)
 * — Claude Code loads an image from a quoted path in the message text. Keeps
 * AgentContentBlock text-only (no image block type needed).
 */
export function agentMessageFromInput(input: {
  text?: string
  attachments?: string[]
}): AgentUserMessage {
  const text = (input.text ?? "").trim()
  const paths = (input.attachments ?? []).filter((p) => p && p.trim()).map((p) => `"${p}"`)
  const combined = [text, ...paths].filter((s) => s.length > 0).join("\n")
  return userMessage(combined)
}

// ---------------------------------------------------------------------------
// Permission contract — FINALIZED in BO-3 against the REAL wire shape captured
// live (see docs/spikes/bo3-permission-prompt.md + permissionWire.fixtures.ts).
//
// Headless permissions are handled by `--permission-prompt-tool <mcpToolName>`:
// Claude SYNCHRONOUSLY calls that MCP tool and blocks on its return. Permissions
// do NOT ride the stdout StreamEvent union — there is no parser branch for them.
// ---------------------------------------------------------------------------

/** The MCP tool we register as the `--permission-prompt-tool` handler. */
export const PERMISSION_TOOL_NAME = "approve_tool" as const

/**
 * The MCP-prefixed name passed to `--permission-prompt-tool` on spawn. Claude
 * addresses a server's tool as `mcp__<server>__<tool>`; our server is "claudetui".
 */
export const PERMISSION_PROMPT_TOOL = "mcp__claudetui__approve_tool" as const

/** Renderer push channel: a new PermissionRequest to surface. Mirrors TERMINAL_STREAM_CHANNEL. */
export const PERMISSION_REQUEST_CHANNEL = "permission:request" as const
/** Renderer push channel: a pending PermissionRequest was resolved/orphaned (clear its UI). */
export const PERMISSION_RESOLVED_CHANNEL = "permission:resolved" as const

/**
 * The EXACT `arguments` the `--permission-prompt-tool` MCP tool receives, as
 * captured live (snake_case). The approve_tool zod schema mirrors this so it
 * parses what Claude actually sends.
 */
export interface PermissionToolInput {
  /** e.g. "Write" | "Bash" | "Edit" | "mcp__server__tool". */
  tool_name: string
  /** The tool's full argument object (`{command}`, `{file_path,content}`, …). */
  input?: unknown
  /** Correlates back to the assistant's tool_use block. */
  tool_use_id?: string
}

/**
 * An app-level representation of a tool-permission prompt, surfaced to the
 * renderer's PermissionPrompt. Maps the snake_case wire input onto idiomatic
 * camelCase + app-only correlation fields.
 */
export interface PermissionRequest {
  /** App-level id correlating a decision back to its request (the resolver key). */
  id: string
  /** Wire `tool_name`. */
  toolName: string
  /** Wire `input` — the tool's argument object. */
  toolInput: unknown
  /** Wire `tool_use_id` (when present). */
  toolUseId?: string
  /** The terminal whose agent is asking (when known). */
  terminalId?: string
}

/**
 * The user's answer. `behavior`/`updatedInput`/`message` ARE the exact wire
 * fields Claude expects back (see {@link buildPermissionResult}); `id` and
 * `alwaysAllow` are app-only (never serialized to Claude).
 */
export interface PermissionDecision {
  id: string
  behavior: "allow" | "deny"
  /** On allow, the (possibly edited) tool input to run. REQUIRED at the wire —
   *  {@link buildPermissionResult} fills it with the original input when omitted. */
  updatedInput?: unknown
  /** On deny, an optional human-readable reason surfaced back to the agent. */
  message?: string
  /** App-only: also persist an allow rule so the NEXT spawn skips the prompt. */
  alwaysAllow?: boolean
}

/** The wire result a `--permission-prompt-tool` returns (as JSON text content). */
export type PermissionToolResult =
  | { behavior: "allow"; updatedInput: unknown }
  | { behavior: "deny"; message?: string }

/**
 * Build the EXACT JSON the `--permission-prompt-tool` must return. Encapsulates
 * the live-proven rule: ALLOW must carry `updatedInput` (a bare
 * `{"behavior":"allow"}` is rejected and the gated tool never runs), so we echo
 * the original `input` whenever the user didn't supply an edited one.
 */
export function buildPermissionResult(
  decision: Pick<PermissionDecision, "behavior" | "updatedInput" | "message">,
  originalInput: unknown,
): PermissionToolResult {
  if (decision.behavior === "deny") return { behavior: "deny", message: decision.message }
  return { behavior: "allow", updatedInput: decision.updatedInput ?? originalInput }
}

// ---------------------------------------------------------------------------
// Renderer IPC channel (BO-2 wires the renderer; BO-1 owns the name + payload)
// ---------------------------------------------------------------------------

/** The IPC channel a parsed stream event is forwarded to the renderer on. */
export const TERMINAL_STREAM_CHANNEL = "terminal:stream" as const

/** The payload shape sent on {@link TERMINAL_STREAM_CHANNEL}. */
export interface TerminalStreamPayload {
  terminalId: string
  event: StreamEvent
}
