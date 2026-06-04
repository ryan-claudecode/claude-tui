import net from "net"

export interface PortCheckResult {
  host: string
  port: number
  open: boolean
  durationMs: number
}

export interface PortWaitResult {
  host: string
  port: number
  open: boolean
  waitedMs: number
  attempts: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 2000
const DEFAULT_WAIT_TIMEOUT_MS = 30000
const DEFAULT_POLL_INTERVAL_MS = 500

/**
 * PortService — answer "is something listening on this TCP port?" without
 * spawning `lsof`/`netstat`/`Test-NetConnection` and parsing it. The natural
 * companion to http_request and run_command: start a dev server, wait for its
 * port to come up, then hit it.
 *
 * Thin by design: a single bounded TCP connect attempt (and a polling loop on
 * top of it for waiting). No state, no persistence, no session/renderer changes.
 */
export class PortService {
  /** Attempt a single TCP connection; resolve open=true if it succeeds. */
  check(port: number, host = "127.0.0.1", timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<PortCheckResult> {
    const started = Date.now()
    return new Promise<PortCheckResult>((resolve) => {
      const socket = new net.Socket()
      let settled = false
      const finish = (open: boolean) => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve({ host, port, open, durationMs: Date.now() - started })
      }
      socket.setTimeout(timeoutMs)
      socket.once("connect", () => finish(true))
      socket.once("timeout", () => finish(false))
      socket.once("error", () => finish(false))
      socket.connect(port, host)
    })
  }

  /** Poll `check` until the port opens or the overall timeout elapses. */
  async waitForOpen(
    port: number,
    host = "127.0.0.1",
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
  ): Promise<PortWaitResult> {
    const started = Date.now()
    let attempts = 0
    while (Date.now() - started < timeoutMs) {
      attempts++
      const remaining = timeoutMs - (Date.now() - started)
      const connectTimeout = Math.max(250, Math.min(DEFAULT_CONNECT_TIMEOUT_MS, remaining))
      const res = await this.check(port, host, connectTimeout)
      if (res.open) {
        return { host, port, open: true, waitedMs: Date.now() - started, attempts }
      }
      if (Date.now() - started + intervalMs >= timeoutMs) break
      await new Promise((r) => setTimeout(r, intervalMs))
    }
    return { host, port, open: false, waitedMs: Date.now() - started, attempts }
  }
}
