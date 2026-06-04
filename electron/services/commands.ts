import { spawnSync } from "child_process"

export interface CommandResult {
  command: string
  cwd: string
  success: boolean
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

/**
 * CommandService — run an arbitrary shell command in a working directory and
 * return a structured result (exit code, stdout, stderr, duration).
 *
 * This is the general-purpose sibling of TestRunnerService/AppService.runBuild:
 * instead of scraping a session's terminal, Claude can run a one-off command
 * (lint, typecheck, a build step, `ls`, a git porcelain command) and get a
 * machine-readable result back. Output is captured, not streamed — for
 * long-running interactive processes, use a real session instead.
 */
export class CommandService {
  /** Run `command` in `cwd`. `timeoutMs` defaults to 60s. */
  run(command: string, cwd: string, timeoutMs = 60000): CommandResult {
    const start = Date.now()
    const res = spawnSync(command, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      shell: true,
      maxBuffer: 10 * 1024 * 1024,
    })
    const durationMs = Date.now() - start

    const timedOut = res.error != null && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
    const exitCode = res.status ?? (res.error ? 1 : 0)

    return {
      command,
      cwd,
      success: exitCode === 0 && !res.error,
      exitCode,
      stdout: (res.stdout ?? "").trimEnd(),
      stderr: (res.stderr ?? (res.error ? String(res.error.message) : "")).trimEnd(),
      durationMs,
      timedOut,
    }
  }
}
