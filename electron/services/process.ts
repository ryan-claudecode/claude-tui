import { spawnSync } from "child_process"

export interface PortProcess {
  pid: number
  name: string
}

export interface FindProcessResult {
  port: number
  platform: NodeJS.Platform
  processes: PortProcess[]
}

export interface KillProcessResult {
  port: number
  platform: NodeJS.Platform
  killed: PortProcess[]
  failed: { pid: number; name: string; error: string }[]
  found: boolean
}

const run = (cmd: string, args: string[]): string => {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
  })
  return res.stdout ?? ""
}

/**
 * ProcessService — find and kill whatever process is holding a TCP port,
 * cross-platform, without making the caller parse raw netstat/lsof output.
 *
 * The natural follow-up to PortService: `check_port`/`wait_for_port` tell you a
 * port is taken; this tells you *who* has it and lets you reclaim it (the
 * classic "EADDRINUSE on 3000 — kill the zombie dev server" workflow). Returns
 * structured JSON; no state, no session/renderer changes.
 */
export class ProcessService {
  /** Resolve the PID(s) listening on `port` (with process names). */
  findOnPort(port: number): FindProcessResult {
    const platform = process.platform
    const processes =
      platform === "win32" ? this.findWindows(port) : this.findUnix(port)
    return { port, platform, processes }
  }

  /** Kill whatever is listening on `port`. */
  killOnPort(port: number): KillProcessResult {
    const platform = process.platform
    const { processes } = this.findOnPort(port)
    const killed: PortProcess[] = []
    const failed: { pid: number; name: string; error: string }[] = []

    for (const proc of processes) {
      const res =
        platform === "win32"
          ? spawnSync("taskkill", ["/F", "/PID", String(proc.pid)], {
              encoding: "utf8",
              windowsHide: true,
              timeout: 5000,
            })
          : spawnSync("kill", ["-9", String(proc.pid)], {
              encoding: "utf8",
              timeout: 5000,
            })
      if (res.status === 0 && !res.error) {
        killed.push(proc)
      } else {
        failed.push({
          ...proc,
          error: (res.stderr || res.error?.message || "kill failed").trim(),
        })
      }
    }

    return { port, platform, killed, failed, found: processes.length > 0 }
  }

  private findWindows(port: number): PortProcess[] {
    const out = run("netstat", ["-ano", "-p", "tcp"])
    const pids = new Set<number>()
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/)
      // proto local remote state pid
      if (cols.length < 5) continue
      if (cols[3] !== "LISTENING") continue
      const local = cols[1]
      const colon = local.lastIndexOf(":")
      if (colon === -1) continue
      if (local.slice(colon + 1) !== String(port)) continue
      const pid = Number(cols[4])
      if (Number.isInteger(pid) && pid > 0) pids.add(pid)
    }
    return [...pids].map((pid) => ({ pid, name: this.windowsName(pid) }))
  }

  private windowsName(pid: number): string {
    const out = run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"])
    const first = out.split(/\r?\n/).find((l) => l.includes(","))
    if (!first) return "unknown"
    const match = first.match(/^"([^"]*)"/)
    return match ? match[1] : "unknown"
  }

  private findUnix(port: number): PortProcess[] {
    const out = run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])
    const pids = new Set<number>()
    for (const line of out.split(/\r?\n/)) {
      const pid = Number(line.trim())
      if (Number.isInteger(pid) && pid > 0) pids.add(pid)
    }
    return [...pids].map((pid) => ({ pid, name: this.unixName(pid) }))
  }

  private unixName(pid: number): string {
    const out = run("ps", ["-p", String(pid), "-o", "comm="])
    return out.trim() || "unknown"
  }
}
