import { spawnSync } from "child_process"

export interface TestResult {
  command: string
  cwd: string
  success: boolean
  exitCode: number
  passed: number | null
  failed: number | null
  skipped: number | null
  total: number | null
  durationMs: number
  output: string
}

/**
 * TestRunnerService — runs a project's test command and returns a structured,
 * parsed result (pass/fail/skip counts, exit code, duration, raw output).
 *
 * Gives Claude a machine-readable test summary instead of forcing it to scrape
 * the terminal, and feeds the renderer's test panel. Framework-agnostic: the
 * count parsing is heuristic and covers the common reporters (jest, vitest,
 * mocha, pytest). When a count can't be parsed it stays null and callers fall
 * back to the raw output + exit code.
 */
export class TestRunnerService {
  /** Run a test command in `cwd`. Defaults to `npm test`. */
  run(cwd: string, command = "npm test"): TestResult {
    const start = Date.now()
    const res = spawnSync(command, {
      cwd,
      encoding: "utf8",
      timeout: 120000,
      windowsHide: true,
      shell: true,
      maxBuffer: 10 * 1024 * 1024,
    })
    const durationMs = Date.now() - start

    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trimEnd()
    const exitCode = res.status ?? (res.error ? 1 : 0)
    const counts = this.parseCounts(output)

    return {
      command,
      cwd,
      success: exitCode === 0,
      exitCode,
      ...counts,
      durationMs,
      output: output || (res.error ? String(res.error.message) : ""),
    }
  }

  /**
   * Heuristic count extraction. Returns the LAST match for each pattern so the
   * final summary line wins over per-file/intermediate lines. Covers:
   *   jest/vitest: "1 failed, 2 passed", "3 passed", "1 skipped", "N total"
   *   mocha:       "2 passing", "1 failing", "1 pending"
   *   pytest:      "2 passed", "1 failed", "1 skipped"
   */
  private parseCounts(output: string): {
    passed: number | null
    failed: number | null
    skipped: number | null
    total: number | null
  } {
    const last = (re: RegExp): number | null => {
      let value: number | null = null
      for (const m of output.matchAll(re)) value = parseInt(m[1], 10)
      return value
    }

    const passed = last(/(\d+)\s+(?:passed|passing)\b/gi)
    const failed = last(/(\d+)\s+(?:failed|failing)\b/gi)
    const skipped = last(/(\d+)\s+(?:skipped|pending)\b/gi)
    let total = last(/(\d+)\s+total\b/gi)

    if (total === null && (passed !== null || failed !== null || skipped !== null)) {
      total = (passed ?? 0) + (failed ?? 0) + (skipped ?? 0)
    }

    return { passed, failed, skipped, total }
  }
}
