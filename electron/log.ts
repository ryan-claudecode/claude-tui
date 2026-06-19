import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

// Crash-visibility logger for the main process. Appends timestamped lines to
// ~/.claude-tui/logs/main.log and mirrors them to the console, so a failure
// leaves a trace even when the app is launched from the shell (no terminal to
// catch console output). Deliberately dependency-free (plain node:fs) and
// fail-safe: every fs operation is wrapped so the logger can NEVER throw — a
// logging failure must never become the failure being logged.

// 1 MB cap. No rotation — when the file grows past this we simply truncate it
// (the most recent failures are what matter for diagnosing live issues).
const MAX_LOG_BYTES = 1024 * 1024

let logDir = join(homedir(), ".claude-tui", "logs")

// Injectable for tests so they never write to the real ~/.claude-tui.
export function setLogDir(dir: string): void {
  logDir = dir
}

function logFile(): string {
  return join(logDir, "main.log")
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`
  }
  if (typeof err === "string") return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function write(level: "ERROR" | "WARN", scope: string, message: string): void {
  const line = `${new Date().toISOString()} [${level}] ${scope}: ${message}\n`

  // Console mirror first — even if disk writes fail, the line is visible when
  // a terminal is attached.
  if (level === "ERROR") console.error(line.trimEnd())
  else console.warn(line.trimEnd())

  try {
    mkdirSync(logDir, { recursive: true })
    // Cap the file: if it already exceeds the limit, truncate before appending.
    try {
      if (statSync(logFile()).size > MAX_LOG_BYTES) {
        writeFileSync(logFile(), "")
      }
    } catch {
      // statSync throws if the file doesn't exist yet — that's fine, nothing
      // to truncate.
    }
    appendFileSync(logFile(), line)
  } catch {
    // The logger must never throw. Swallow any fs failure (unwritable dir,
    // permissions, full disk); the console mirror above already ran.
  }
}

export function logError(scope: string, err: unknown): void {
  write("ERROR", scope, formatError(err))
}

export function logWarn(scope: string, message: string): void {
  write("WARN", scope, message)
}
