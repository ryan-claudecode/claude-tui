export interface HttpRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  maxBodyBytes?: number
}

export interface HttpResponseResult {
  ok: boolean
  status: number
  statusText: string
  url: string
  redirected: boolean
  headers: Record<string, string>
  contentType: string | null
  body: string
  bodyBytes: number
  truncated: boolean
  durationMs: number
}

const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024 // 1MB

/**
 * HttpService — let a Claude session make an HTTP request and get a structured
 * response back, instead of spawning `curl`/`Invoke-WebRequest` in a terminal
 * and scraping its output. The natural companion to `open_external` (which
 * pops a URL in the browser) and `run_command`: use this to programmatically
 * poke a localhost dev server it just started, hit a JSON API, or check that an
 * endpoint is healthy.
 *
 * Thin by design: a single bounded `fetch` with a timeout and a body cap. Only
 * http/https URLs are allowed. No state, no persistence, no session/renderer
 * changes.
 */
export class HttpService {
  async request(url: string, opts: HttpRequestOptions = {}): Promise<HttpResponseResult> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`Invalid URL: ${url}`)
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Unsupported protocol "${parsed.protocol}" — only http and https are allowed`)
    }

    const method = (opts.method ?? "GET").toUpperCase()
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const started = Date.now()

    try {
      const res = await fetch(parsed.toString(), {
        method,
        headers: opts.headers,
        body: opts.body,
        signal: controller.signal,
        redirect: "follow",
      })

      // Read the body as bytes so we can enforce a hard cap and report size,
      // then decode the (possibly truncated) slice as UTF-8 text.
      const buf = Buffer.from(await res.arrayBuffer())
      const truncated = buf.length > maxBodyBytes
      const slice = truncated ? buf.subarray(0, maxBodyBytes) : buf

      const headers: Record<string, string> = {}
      res.headers.forEach((value, key) => {
        headers[key] = value
      })

      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        url: res.url,
        redirected: res.redirected,
        headers,
        contentType: res.headers.get("content-type"),
        body: slice.toString("utf-8"),
        bodyBytes: buf.length,
        truncated,
        durationMs: Date.now() - started,
      }
    } catch (e: any) {
      if (e?.name === "AbortError") {
        throw new Error(`Request timed out after ${timeoutMs}ms`)
      }
      throw new Error(e?.message ?? String(e))
    } finally {
      clearTimeout(timer)
    }
  }
}
