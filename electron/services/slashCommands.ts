/**
 * BO-7 (CAPP-41) — the PURE routing table for `/`-commands typed into the
 * structured composer, consumed by the `agent:send-input` intercept in
 * electron/ipc/terminal-handlers.ts BEFORE the message is folded for stdin.
 *
 * Two outcomes:
 *  - "native": the command maps to an EXISTING app affordance (e.g. a theme/config
 *    switch, the retire-&-continue handoff). The intercept fires that affordance
 *    and does NOT forward literal text to Claude.
 *  - "send": forward unchanged to the headless stdin so Claude expands it itself.
 *    This is the path for Claude-owned built-ins (`/clear`, `/compact`,
 *    `/context`), every user/plugin skill (`/skill-name`, `/plugin:skill`), every
 *    custom command, and ordinary prose. The slash is DELIBERATELY preserved.
 *
 * Zero runtime deps so the unit test (and the renderer, if ever needed) can import
 * it freely.
 */

/** The native commands we intercept into an app affordance instead of forwarding. */
export type NativeSlashCommand = "config" | "resume"

/**
 * The interception map: command name (lowercase, no slash) → app affordance id.
 *
 * Deliberately small and conservative. NOTE `/model` is intentionally absent —
 * it is owned by BO-6 (CAPP-40: model picker + per-terminal --model). BO-6 plugs
 * its own `model` route in here (and a matching branch in the renderer's
 * ui:slash-command handler); until then `/model` falls through to "send".
 */
export const NATIVE_SLASH_COMMANDS: Record<string, NativeSlashCommand> = {
  config: "config",
  resume: "resume",
}

export type SlashRoute =
  | { kind: "native"; command: NativeSlashCommand }
  | { kind: "send" }

/**
 * The leading command token of a `/`-message, lowercased and without its slash,
 * or null when the text is not a slash command. Stops at the first whitespace so
 * trailing args don't bleed into the name. Allows the punctuation Claude Code uses
 * for plugin/skill ids (`:`, `.`, `-`) plus word chars.
 */
export function parseSlashCommand(text: string): string | null {
  const t = (text ?? "").replace(/^\s+/, "")
  if (!t.startsWith("/")) return null
  const m = /^\/([A-Za-z0-9_:.-]+)/.exec(t)
  return m ? m[1].toLowerCase() : null
}

/**
 * Classify one composer input into a route. Native-mapped built-ins fire an app
 * affordance; everything else (Claude built-ins, skills, custom commands, prose)
 * is forwarded to Claude unchanged.
 */
export function classifySlashInput(text: string): SlashRoute {
  const cmd = parseSlashCommand(text)
  if (cmd && Object.prototype.hasOwnProperty.call(NATIVE_SLASH_COMMANDS, cmd)) {
    return { kind: "native", command: NATIVE_SLASH_COMMANDS[cmd] }
  }
  return { kind: "send" }
}

/** Renderer push channel: a native-mapped slash command fired an app affordance. */
export const UI_SLASH_COMMAND_CHANNEL = "ui:slash-command" as const

/** Payload on {@link UI_SLASH_COMMAND_CHANNEL}: which affordance + the originating terminal. */
export interface UiSlashCommandPayload {
  command: NativeSlashCommand
  terminalId: string
}
