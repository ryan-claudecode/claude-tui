import { homedir } from "os"
import { join } from "path"

/**
 * CAPP-134 — the INSTANCE ROOT. Every piece of ClaudeTUI's durable state lives
 * under this one directory: config.json, sessions/, workspaces.json, schedules/,
 * logs/, model-catalog.json, stt/, and the MCP config handed to spawned sessions.
 *
 * Defaults to `~/.claude-tui` (byte-identical to the hardcoded literal it
 * replaces). Setting `CLAUDE_TUI_HOME` re-roots the WHOLE instance, which is what
 * makes a dev build runnable ALONGSIDE the packaged app instead of requiring the
 * owner to close their working copy for every rebuild:
 *
 *   $env:CLAUDE_TUI_HOME="$env:USERPROFILE\.claude-tui-dev"; npm run dev:watch
 *
 * Two instances sharing one root is the hazard this exists to prevent — they
 * fight over the same sessions/config files, and (worse, before this) over the
 * single fixed `mcp-config.json` path, so whichever booted last silently
 * captured the OTHER instance's spawned agents. Re-rooting isolates all of it.
 *
 * Read via a FUNCTION, not a module-level const: tests (and any future in-process
 * re-root) can change the env var and see it take effect, and there is no import
 * -order coupling between this and the modules that consume it.
 *
 * A blank/whitespace value is ignored (treated as unset) so `CLAUDE_TUI_HOME=`
 * can't silently redirect state to the process cwd.
 */
export function tuiHome(): string {
  const override = process.env.CLAUDE_TUI_HOME
  if (typeof override === "string" && override.trim()) return override.trim()
  return join(homedir(), ".claude-tui")
}

/** A path inside the instance root — `tuiPath("sessions")`, `tuiPath("stt", "models")`. */
export function tuiPath(...segments: string[]): string {
  return join(tuiHome(), ...segments)
}
