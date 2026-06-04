import os from "os"
import { execFileSync } from "child_process"

export interface SystemInfo {
  platform: NodeJS.Platform
  arch: string
  hostname: string
  cpuModel: string
  cpuCount: number
  totalMemMb: number
  freeMemMb: number
  uptimeSec: number
  homeDir: string
  nodeVersion: string
  electronVersion?: string
  chromeVersion?: string
}

/**
 * SystemService — read-only environment awareness for Claude. Lets a session
 * answer "what machine am I on?" and "is tool X installed?" without spawning a
 * throwaway terminal command and parsing its output. Complements CommandService
 * (which runs arbitrary commands) with two safe, structured lookups.
 *
 * Thin by design: pure reads of `os` plus a single PATH lookup. No state, no
 * persistence, no session/renderer changes.
 */
export class SystemService {
  getInfo(): SystemInfo {
    const cpus = os.cpus()
    return {
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      cpuModel: cpus[0]?.model?.trim() ?? "unknown",
      cpuCount: cpus.length,
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
      freeMemMb: Math.round(os.freemem() / 1024 / 1024),
      uptimeSec: Math.round(os.uptime()),
      homeDir: os.homedir(),
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
    }
  }

  /**
   * Locate an executable on PATH. Returns the resolved path(s), or null if not
   * found. Uses `where` on Windows and `which` elsewhere. The command name is
   * validated to a safe charset before being passed to the OS resolver.
   */
  which(command: string): { found: boolean; paths: string[] } {
    if (!/^[\w.+-]+$/.test(command)) {
      return { found: false, paths: [] }
    }
    const finder = process.platform === "win32" ? "where" : "which"
    try {
      const out = execFileSync(finder, [command], { encoding: "utf-8", timeout: 5000 })
      const paths = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
      return { found: paths.length > 0, paths }
    } catch {
      return { found: false, paths: [] }
    }
  }
}
