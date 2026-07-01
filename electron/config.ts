import { join } from "node:path"
import { homedir } from "node:os"
import { readFileSync } from "node:fs"
import { loadVersioned, saveVersioned, type Migration } from "./persist"
import { DEFAULT_MODEL, MODEL_ALIASES } from "./services/streamProtocol"

export interface ThemeConfig {
  fontFamily?: string
  fontSize?: number
  background?: string
  foreground?: string
  cursor?: string
  selectionBackground?: string
  black?: string
  red?: string
  green?: string
  yellow?: string
  blue?: string
  magenta?: string
  cyan?: string
  white?: string
  brightBlack?: string
  brightRed?: string
  brightGreen?: string
  brightYellow?: string
  brightBlue?: string
  brightMagenta?: string
  brightCyan?: string
  brightWhite?: string
}

/** Attention-queue options (AQ-1). Additive/optional — no schema version bump. */
export interface AttentionConfig {
  /**
   * Fire a Windows native notification (Electron `Notification`) on a tier-1
   * (blocked) attention enqueue when the main window is unfocused. Default true.
   */
  osNotifications?: boolean
}

/** The session rendering transport. `xterm` = the legacy interactive PTY +
 *  xterm.js view; `structured` = the headless stream-json engine (BO-1..BO-3)
 *  with the AgentView renderer + composer + programmatic permission gate. */
export type RenderingEngine = "xterm" | "structured"

/**
 * Rendering options (BO-4a). Additive/optional — no schema version bump (mirrors
 * the AttentionConfig precedent). `engine` selects which transport a freshly
 * spawned terminal uses; absent/unrecognized resolves to "structured" via
 * {@link resolveRenderingEngine} (CAPP-39 gate ④ — the default is now the headless
 * stream-json engine), so only an EXPLICIT `engine: "xterm"` opts back into the
 * legacy interactive PTY globally.
 *
 * BO-6 — `model` is the default `--model` for new STRUCTURED terminals (the
 * headless engine). Additive/optional; absent resolves to the `opus` ALIAS via
 * {@link resolveRenderingModel}. A per-terminal override (the in-app picker)
 * persists on the terminal ref and wins over this default on respawn/restore.
 */
export interface RenderingConfig {
  engine?: RenderingEngine
  model?: string
  /**
   * CAPP-46 — the default reasoning `--effort` level for new STRUCTURED terminals
   * (the headless engine). Additive/optional. Unlike {@link RenderingConfig.model}
   * there is NO forced default: when unset, {@link resolveRenderingEffort} returns
   * undefined and the spawn OMITS `--effort` entirely (byte-unchanged — Claude uses
   * its own built-in effort default). A per-terminal override (the in-app picker)
   * persists on the terminal ref and wins over this default on respawn/restore.
   */
  effort?: string
}

/**
 * Permission posture for the STRUCTURED (headless stream-json) engine. Additive/
 * optional — no schema version bump (mirrors the RenderingConfig/AttentionConfig
 * precedent).
 *
 * ⚠️ DEV POSTURE — RELEASE BLOCKER. `skipApproval` gates whether a structured
 * spawn carries `--dangerously-skip-permissions` (skip the per-tool approval
 * gate) or the BO-3 `--permission-prompt-tool` gate (route every un-pre-approved
 * tool through the in-app Allow/Deny prompt). The DEFAULT is `true` (skip) as a
 * deliberate, owner-locked DEV-velocity choice — it matches the legacy xterm
 * path, which already skips. The full BO-3 machinery (approve_tool MCP tool,
 * requestPermission, PermissionPrompt UI, attention seam) is PRESERVED, only
 * dormant while skip=true; flipping `skipApproval` to `false` re-arms it.
 *
 * Before any PUBLIC release the permission posture MUST be re-approached: the
 * trust thesis is "no runaway you can't stop" — a packaged build handed to a user
 * cannot silently run tools with no gate. A release-blocker ticket tracks flipping
 * this default (or making it user-visible/per-workspace) before shipping.
 */
export interface PermissionsConfig {
  /** When true (DEFAULT, dev posture), structured spawns skip the approval gate. */
  skipApproval?: boolean
}

/**
 * Agent Rail (v1) UI prefs. Additive/optional — no schema version bump (mirrors the
 * RenderingConfig/AttentionConfig precedent). `open` persists the user's collapse
 * choice for the right-edge agent-state column GLOBALLY (per-workspace is a later
 * refinement). Absent resolves to `true` (open) via {@link resolveAgentRailOpen}.
 * The responsive sub-1400px auto-collapse is a RENDERER-only derivation that never
 * writes here, so a narrow window can't overwrite the saved preference.
 */
export interface AgentRailConfig {
  open?: boolean
}

/**
 * CAPP-86 — "The Lexicon" context-engine options. Additive/optional — no schema
 * version bump (mirrors the RenderingConfig/AttentionConfig precedent).
 *
 * `primerRecall` gates whether {@link SessionService.getContext} appends the capped
 * "## Related from other sessions" cross-session recall block to a fresh terminal's
 * primer. The DEFAULT is FALSE (OFF) so the default primer is BYTE-IDENTICAL — the
 * cross-session enrichment is opt-in until the owner ratifies it (it risks context
 * bloat / off-topic injection; kept gated + capped per the design doc's risks).
 */
export interface ContextConfig {
  primerRecall?: boolean
  /**
   * CAPP-96 — the hard byte cap on the auto-loaded "brain" payload injected into a
   * fresh session's system prompt (file-backed, `--append-system-prompt-file`). The
   * builder value-orders + truncates to stay under this (per-terminal cost multiplies
   * across concurrent terminals, so this is a real budget, not a nicety). Default 8192
   * (8 KB) per the design doc §B.3; resolved via {@link resolveInjectMaxBytes}.
   */
  injectMaxBytes?: number
}

/**
 * CAPP-113 — the config-extensible model list, the "never-stale" escape hatch.
 * Claude Code exposes NO dynamic model discovery, so the app's static
 * {@link MODEL_ALIASES} can only go stale as new models ship. This block lets the
 * user recover staleness WITHOUT a code edit. Additive/optional — no schema version
 * bump (mirrors the RenderingConfig/AttentionConfig precedent). Every field is
 * best-effort + type-guarded by its resolver ({@link resolveModelOptions},
 * {@link resolveModelsDefault}, {@link resolveXhighModels}); a malformed block is
 * ignored, never fatal.
 *
 *  - `default` — override the spawn-default model for NEW terminals (overrides the
 *    hard-coded {@link DEFAULT_MODEL}; a set `rendering.model` still wins over it).
 *  - `extra`   — additional aliases/ids appended to the picker (after the built-ins).
 *  - `hidden`  — aliases/ids removed from the picker (takes precedence over extra).
 *  - `xhigh`   — additional models that support xhigh reasoning (so the ultracode
 *    toggle offers them + a model-switch preserves ultracode); additive to the
 *    built-in {@link XHIGH_MODELS} matcher.
 */
export interface ModelsConfig {
  default?: string
  extra?: string[]
  hidden?: string[]
  xhigh?: string[]
}

export interface TuiConfig {
  workspaceScanPaths: string[]
  defaultCommand?: string
  defaultArgs?: string[]
  theme?: ThemeConfig
  attention?: AttentionConfig
  rendering?: RenderingConfig
  permissions?: PermissionsConfig
  agentRail?: AgentRailConfig
  context?: ContextConfig
  models?: ModelsConfig
}

/**
 * Resolve the rendering engine from a (possibly partial/legacy) config, defaulting
 * to "structured" (CAPP-39 gate ④) when the field is absent or not a recognized
 * value — only an EXPLICIT `engine: "xterm"` selects the legacy interactive PTY.
 * The single place the default lives, shared by the main process (engine switch)
 * and any consumer that reads `config.rendering`. The per-terminal raw-view escape
 * hatch (setTerminalEngine / the AgentView "Raw view" button) remains the way back
 * to xterm for a single terminal.
 */
export function resolveRenderingEngine(config?: { rendering?: RenderingConfig } | null): RenderingEngine {
  return config?.rendering?.engine === "xterm" ? "xterm" : "structured"
}

/**
 * Resolve the default `--model` for new structured terminals from a (possibly
 * partial/legacy) config. Returns `config.rendering.model` when it's a non-empty
 * string, else `fallback` (default: the `opus` alias). Pure + deterministic (no
 * filesystem) so it's trivially testable; the best-effort "seed from the user's
 * ~/.claude/settings.json" nicety is layered on at the wiring layer (ipc.ts) by
 * passing {@link claudeDefaultModel} as the fallback.
 */
export function resolveRenderingModel(
  config?: { rendering?: RenderingConfig } | null,
  fallback: string = DEFAULT_MODEL,
): string {
  const m = config?.rendering?.model
  return typeof m === "string" && m.trim() ? m.trim() : fallback
}

/**
 * CAPP-46 — resolve the default `--effort` for new structured terminals from a
 * (possibly partial/legacy) config. Returns `config.rendering.effort` when it's a
 * non-empty string, else `fallback`. UNLIKE {@link resolveRenderingModel} the
 * fallback defaults to `undefined` (NOT a forced level): an unset effort resolves
 * to undefined so the spawn OMITS `--effort` and the default behavior is
 * byte-unchanged. Pure + deterministic (no filesystem); the wiring layer (ipc.ts)
 * may pass {@link claudeDefaultEffort} as the fallback for a best-effort seed.
 */
export function resolveRenderingEffort(
  config?: { rendering?: RenderingConfig } | null,
  fallback: string | undefined = undefined,
): string | undefined {
  const e = config?.rendering?.effort
  return typeof e === "string" && e.trim() ? e.trim() : fallback
}

/**
 * Resolve the structured permission posture from a (possibly partial/legacy)
 * config. Returns `true` (skip the approval gate) unless `permissions.skipApproval`
 * is EXPLICITLY `false`. The single place the default lives, shared by the wiring
 * layer (ipc.ts → TerminalService.setSkipApproval). Pure + deterministic.
 *
 * ⚠️ DEV POSTURE — RELEASE BLOCKER: defaulting to `true` (skip) is the owner-locked
 * dev choice; see {@link PermissionsConfig}. The BO-3 gate machinery is preserved
 * and re-arms when this resolves to `false`.
 */
export function resolveSkipApproval(config?: { permissions?: PermissionsConfig } | null): boolean {
  return config?.permissions?.skipApproval !== false
}

/**
 * Agent Rail (v1) — resolve the persisted open/collapsed preference from a (possibly
 * partial/legacy) config. Returns `true` (open) unless `agentRail.open` is EXPLICITLY
 * `false`. The single place the default lives, shared by the wiring layer (the
 * renderer seeds the rail's collapsed state from this on mount). Pure + deterministic.
 */
export function resolveAgentRailOpen(config?: { agentRail?: AgentRailConfig } | null): boolean {
  return config?.agentRail?.open !== false
}

/**
 * CAPP-86 — resolve whether the context primer is enriched with the cross-session
 * "## Related from other sessions" recall block. Returns `false` (OFF) unless
 * `context.primerRecall` is EXPLICITLY `true`. The single place the default lives:
 * default-OFF keeps the default primer BYTE-IDENTICAL until the owner opts in. Pure
 * + deterministic.
 */
export function resolvePrimerRecall(config?: { context?: ContextConfig } | null): boolean {
  return config?.context?.primerRecall === true
}

/** CAPP-96 — the default auto-load payload cap (8 KB) per the design doc §B.3. */
export const DEFAULT_INJECT_MAX_BYTES = 8192

/**
 * CAPP-96 — resolve the auto-load payload byte cap. Returns the configured
 * `context.injectMaxBytes` when it is a FINITE, POSITIVE number, else the 8 KB
 * default. A non-positive / non-numeric override is ignored (never produces a 0-byte
 * or negative cap that would silently suppress the whole brain). Pure + deterministic.
 */
export function resolveInjectMaxBytes(config?: { context?: ContextConfig } | null): number {
  const v = config?.context?.injectMaxBytes
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_INJECT_MAX_BYTES
}

/**
 * CAPP-113 — resolve the config `models.default` override for the spawn-default model
 * of NEW structured terminals. Returns the trimmed value when it's a non-empty string,
 * else undefined (the caller then falls back to the ambient seed / {@link DEFAULT_MODEL}).
 * Pure + deterministic; a malformed/absent block is ignored.
 */
export function resolveModelsDefault(config?: { models?: ModelsConfig } | null): string | undefined {
  const d = config?.models?.default
  return typeof d === "string" && d.trim() ? d.trim() : undefined
}

/**
 * CAPP-113 — resolve the ADDITIVE config `models.xhigh` list threaded into the
 * {@link modelSupportsXhigh} matcher (the ultracode toggle's visibility gate + the
 * model-switch keepUltra logic). Returns a cleaned string[] (blank/non-string members
 * dropped), or [] when absent/malformed — so the matcher's built-in behavior is
 * byte-unchanged unless the user opts in. Pure + deterministic.
 */
export function resolveXhighModels(config?: { models?: ModelsConfig } | null): string[] {
  const x = config?.models?.xhigh
  return Array.isArray(x)
    ? x.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())
    : []
}

/**
 * Best-effort: read the user's Claude Code `~/.claude/settings.json` `model`
 * field, so an unset `rendering.model` defaults to whatever model the user
 * already runs Claude Code with. Never throws and never hard-depends on CC's
 * config format — any read/parse/shape miss returns undefined (the caller then
 * falls back to the `opus` alias).
 */
export function claudeDefaultModel(): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"))
    const m = raw?.model
    return typeof m === "string" && m.trim() ? m.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * CAPP-46 — best-effort: read the user's Claude Code `~/.claude/settings.json`
 * `effortLevel` field, so an unset `rendering.effort` can default to whatever
 * effort the user already runs Claude Code with. Mirrors {@link claudeDefaultModel}:
 * never throws and never hard-depends on CC's config format — any read/parse/shape
 * miss returns undefined (the caller then leaves `--effort` OMITTED).
 */
export function claudeDefaultEffort(): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"))
    const e = raw?.effortLevel
    return typeof e === "string" && e.trim() ? e.trim() : undefined
  } catch {
    return undefined
  }
}

const CONFIG_FILE = join(homedir(), ".claude-tui", "config.json")

const DEFAULT_CONFIG: TuiConfig = {
  workspaceScanPaths: [
    join(homedir(), "workspaces", "ws-*"),
  ],
}

/** Persistence schema version. v1 = today's free-form config shape verbatim. */
const SCHEMA_VERSION = 1
const MIGRATIONS: Migration[] = []

/** The on-disk config is a free-form object; the typed views below derive from it. */
type RawConfig = Record<string, any>

/**
 * The single read path for config.json — every reader (loadConfig,
 * getThemeMode) routes through here instead of its own readFileSync. Returns an
 * empty object when the file is missing/corrupt (loadVersioned warns on corrupt
 * and returns undefined). A legacy envelope-less file is read-repaired to v1.
 */
function readRawConfig(): RawConfig {
  return loadVersioned<RawConfig>(CONFIG_FILE, SCHEMA_VERSION, MIGRATIONS) ?? {}
}

export type ThemeMode = "light" | "dark" | "cold-dark"

const VALID_THEMES: ThemeMode[] = ["light", "dark", "cold-dark"]

export function getThemeMode(): ThemeMode {
  const mode = readRawConfig()?.theme?.mode
  return VALID_THEMES.includes(mode) ? mode : "light"
}

export function setThemeMode(mode: ThemeMode): void {
  const data = readRawConfig()
  if (!data.theme) data.theme = {}
  data.theme.mode = mode
  saveVersioned(CONFIG_FILE, SCHEMA_VERSION, data)
}

/**
 * CAPP-39 gate ④ — persist the DEFAULT rendering engine new terminals spawn with
 * (the rollback write-path for the command palette). Mirrors {@link setThemeMode}:
 * read-modify-save through the versioned envelope, creating `rendering` if absent
 * and preserving its other fields (model/effort). Only affects NEXT-spawned
 * terminals — currently-open terminals are unaffected (the per-terminal raw-view
 * escape hatch handles the current one).
 */
export function setRenderingEngine(engine: RenderingEngine): void {
  const data = readRawConfig()
  if (!data.rendering) data.rendering = {}
  data.rendering.engine = engine
  saveVersioned(CONFIG_FILE, SCHEMA_VERSION, data)
}

/**
 * Agent Rail (v1) — persist the rail's open/collapsed preference. Mirrors
 * {@link setRenderingEngine}/{@link setThemeMode}: read-modify-save through the
 * versioned envelope, creating `agentRail` if absent and preserving any other fields.
 * Only the EXPLICIT user collapse is persisted; the responsive sub-1400px
 * auto-collapse is renderer-only and never calls this.
 */
export function setAgentRailOpen(open: boolean): void {
  const data = readRawConfig()
  if (!data.agentRail) data.agentRail = {}
  data.agentRail.open = open
  saveVersioned(CONFIG_FILE, SCHEMA_VERSION, data)
}

/**
 * CAPP-113 — persist a user-entered CUSTOM model into config `models.extra` so it
 * appears in the picker from then on. Called (via `config:add-model-extra` IPC) only
 * after a SUCCESSFUL model switch to the custom value, so the list only grows with
 * models the user actually ran. Mirrors {@link setRenderingEngine}: read-modify-save
 * through the versioned envelope, creating `models` if absent and preserving its other
 * fields. IDEMPOTENT + de-duping: a blank value, a built-in alias, or an
 * already-present extra is a no-op (no write) so it never churns the file / local-history.
 * Returns TRUE only when it actually persisted — the IPC handler gates the
 * `config:models-changed` renderer push (and the in-memory snapshot mirror) on this,
 * so a no-op call never fires a spurious event.
 */
export function addModelExtra(value: string): boolean {
  const v = typeof value === "string" ? value.trim() : ""
  if (!v || MODEL_ALIASES.includes(v)) return false
  const data = readRawConfig()
  const models = data.models && typeof data.models === "object" ? data.models : {}
  const extra: string[] = Array.isArray(models.extra)
    ? models.extra.filter((x: unknown) => typeof x === "string")
    : []
  if (extra.includes(v)) return false
  extra.push(v)
  models.extra = extra
  data.models = models
  saveVersioned(CONFIG_FILE, SCHEMA_VERSION, data)
  return true
}

export function loadConfig(): TuiConfig {
  const data = readRawConfig()
  return {
    workspaceScanPaths: data.workspaceScanPaths ?? DEFAULT_CONFIG.workspaceScanPaths,
    defaultCommand: data.defaultCommand,
    defaultArgs: data.defaultArgs,
    theme: data.theme,
    attention: data.attention,
    // BO-4a — surface `rendering` in the projected keys too (NOT interface-only):
    // get_config / preload.getConfig return this projection, so an interface-only
    // add would never reach the renderer (the BO-5 review caught exactly this).
    rendering: data.rendering,
    // DEV-skip-permissions — same projection rule: surface `permissions` so the
    // wiring layer (ipc.ts) and any reader see the on-disk override, not just the
    // type. Absent → resolveSkipApproval defaults to skip (true).
    permissions: data.permissions,
    // Agent Rail (v1) — surface `agentRail` so getConfig() carries the persisted
    // open/collapsed pref to the renderer (which seeds the rail on mount). Absent →
    // resolveAgentRailOpen defaults to open (true).
    agentRail: data.agentRail,
    // CAPP-86 — surface `context` so the wiring layer (ipc.ts) sees the on-disk
    // primer-recall override, not just the type. Absent → resolvePrimerRecall
    // defaults to OFF (the default primer stays byte-identical).
    context: data.context,
    // CAPP-113 — surface `models` so the config-extensible model list reaches the
    // renderer picker (config:get → resolveModelOptions) + the wiring layer (default
    // override, xhigh matcher). Absent → the resolvers degrade to the built-in aliases.
    models: data.models,
  }
}
