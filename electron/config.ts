import { join } from "node:path"
import { homedir } from "node:os"
import { readFileSync } from "node:fs"
import { loadVersioned, saveVersioned, type Migration } from "./persist"
import { DEFAULT_MODEL } from "./services/streamProtocol"

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
 * spawned terminal uses; absent/unrecognized resolves to "xterm" via
 * {@link resolveRenderingEngine}, so the default live behavior is unchanged.
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

export interface TuiConfig {
  workspaceScanPaths: string[]
  defaultCommand?: string
  defaultArgs?: string[]
  theme?: ThemeConfig
  attention?: AttentionConfig
  rendering?: RenderingConfig
  permissions?: PermissionsConfig
}

/**
 * Resolve the rendering engine from a (possibly partial/legacy) config, defaulting
 * to "xterm" when the field is absent or not a recognized value. The single place
 * the default lives, shared by the main process (engine switch) and any consumer
 * that reads `config.rendering`.
 */
export function resolveRenderingEngine(config?: { rendering?: RenderingConfig } | null): RenderingEngine {
  return config?.rendering?.engine === "structured" ? "structured" : "xterm"
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
  }
}
