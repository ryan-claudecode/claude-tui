import { createWriteStream, mkdirSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { createHash } from "node:crypto"

/**
 * CAPP-120 (STT-1, review findings 1 + 6) — the hardened model-archive download.
 *
 * Split out of `runtime.ts` (which imports `electron`) into an electron-free module so
 * the failure paths are HERMETICALLY unit-tested with fake fetch/sink implementations:
 *
 *  - **MAJOR 1 — stream-error safety.** The write-stream 'error' handler is attached AT
 *    CREATION and every await in the pump races against it. Without that, an fs error
 *    mid-loop (ENOSPC on a filling disk) is an unhandled 'error' EVENT — a MAIN-PROCESS
 *    crash — and a pending `once("drain")` promise never settles (a wedged download).
 *    On any failure the sink is destroyed and the partial file deleted, so the caller's
 *    (SttService.acquire) catch just sets the error status over a clean slate.
 *
 *  - **Finding 6 — integrity.** `received === Content-Length` is validated when the
 *    server sent one; the archive is additionally PINNED by exact byte count + SHA-256
 *    (hashed streaming during the download — no second read), so a truncated, corrupted,
 *    or silently re-uploaded release asset fails acquisition LOUDLY.
 */

export interface BodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
}

/** The minimal writable surface the pump drives (createWriteStream or a test fake). */
export interface ByteSink {
  write(chunk: Uint8Array): boolean
  once(event: "drain", cb: () => void): void
  on(event: "error", cb: (err: Error) => void): void
  end(cb: () => void): void
  destroy(): void
}

export interface FetchResponseLike {
  ok: boolean
  status: number
  statusText: string
  headers: { get(name: string): string | null }
  body: { getReader(): BodyReader } | null
}

export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; redirect: "follow" },
) => Promise<FetchResponseLike>

export interface DownloadFileOptions {
  url: string
  dest: string
  signal: AbortSignal
  onProgress: (receivedBytes: number, totalBytes?: number) => void
  /** Pinned SHA-256 (hex) of the complete file; mismatch → reject + partial deleted. */
  expectedSha256?: string
  /** Pinned exact byte count of the complete file; mismatch → reject + partial deleted. */
  expectedBytes?: number
  /** Injectable seams (tests); default to global fetch / fs streams. */
  fetchImpl?: FetchLike
  openSink?: (dest: string) => ByteSink
  removeFile?: (path: string) => void
}

function abortError(): Error {
  const e = new Error("aborted")
  e.name = "AbortError"
  return e
}

function defaultOpenSink(dest: string): ByteSink {
  mkdirSync(dirname(dest), { recursive: true })
  return createWriteStream(dest)
}

function defaultRemoveFile(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    /* best-effort */
  }
}

/** Stream `url` -> `dest` with progress, abort, error-safety, and integrity pinning. */
export async function downloadToFile(opts: DownloadFileOptions): Promise<void> {
  const { url, dest, signal, onProgress } = opts
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const openSink = opts.openSink ?? defaultOpenSink
  const removeFile = opts.removeFile ?? defaultRemoveFile

  const res = await fetchImpl(url, { signal, redirect: "follow" })
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`)
  }
  const lenHeader = res.headers.get("content-length")
  const lenNum = lenHeader ? Number(lenHeader) : NaN
  const contentLength = Number.isFinite(lenNum) && lenNum > 0 ? lenNum : undefined

  const sink = openSink(dest)
  const hash = opts.expectedSha256 ? createHash("sha256") : null

  // MAJOR 1 — the persistent failure gate: attached BEFORE the first write, raced by
  // every await below. The pre-attached .catch keeps it from ever being an unhandled
  // rejection while nothing is racing it.
  let failCb: ((e: Error) => void) | null = null
  const failure = new Promise<never>((_res, rej) => {
    failCb = rej
  })
  failure.catch(() => {})
  sink.on("error", (err) => failCb?.(err instanceof Error ? err : new Error(String(err))))

  let received = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), failure])
      if (done) break
      if (signal.aborted) throw abortError()
      if (!value || value.byteLength === 0) continue
      received += value.byteLength
      hash?.update(value)
      // Backpressure: wait for drain — but NEVER unraceable (a sink that errors instead
      // of draining rejects this wait; pre-fix it hung forever).
      if (!sink.write(value)) {
        await Promise.race([new Promise<void>((r) => sink.once("drain", r)), failure])
      }
      onProgress(received, contentLength)
    }
    await Promise.race([new Promise<void>((r) => sink.end(r)), failure])

    // Finding 6 — integrity gates (cheapest first). Any miss lands in the catch below,
    // which deletes the partial/corrupt file so a retry starts clean.
    if (contentLength !== undefined && received !== contentLength) {
      throw new Error(
        `download truncated: got ${received} of ${contentLength} bytes (Content-Length)`,
      )
    }
    if (opts.expectedBytes !== undefined && received !== opts.expectedBytes) {
      throw new Error(
        `download size mismatch: got ${received} bytes, expected ${opts.expectedBytes} (pinned)`,
      )
    }
    if (hash && opts.expectedSha256) {
      const digest = hash.digest("hex")
      if (digest !== opts.expectedSha256.toLowerCase()) {
        throw new Error(
          `download integrity check failed: SHA-256 ${digest} != pinned ${opts.expectedSha256}`,
        )
      }
    }
  } catch (err) {
    try {
      sink.destroy()
    } catch {
      /* best-effort */
    }
    removeFile(dest)
    throw err
  }
}
