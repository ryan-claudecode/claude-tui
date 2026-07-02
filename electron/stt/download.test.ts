import { describe, it, expect, vi } from "vitest"
import { createHash } from "node:crypto"
import {
  downloadToFile,
  type ByteSink,
  type BodyReader,
  type FetchLike,
} from "./download"

/**
 * CAPP-120 (review MAJOR 1 + finding 6) — the hardened download's failure paths, driven
 * hermetically with fake fetch/sink implementations (no network, no fs).
 */

function readerOf(chunks: Uint8Array[]): BodyReader {
  let i = 0
  return {
    read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true as const }),
  }
}

function fetchOk(chunks: Uint8Array[], contentLength?: number): FetchLike {
  return async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      get: (n: string) =>
        n.toLowerCase() === "content-length" && contentLength != null ? String(contentLength) : null,
    },
    body: { getReader: () => readerOf(chunks) },
  })
}

/**
 * A minimal writable fake. `failOnWrite` (1-based write index) makes that write return
 * false (backpressure) and then emit 'error' asynchronously — EXACTLY the ENOSPC shape
 * of MAJOR 1: pre-fix, the pump's `once("drain")` promise never settled (a wedged
 * download) and the 'error' event was unhandled (a main-process crash).
 */
class FakeSink implements ByteSink {
  written: Uint8Array[] = []
  destroyed = false
  ended = false
  failOnWrite?: number
  private errCb?: (e: Error) => void

  write(chunk: Uint8Array): boolean {
    this.written.push(chunk)
    if (this.failOnWrite === this.written.length) {
      queueMicrotask(() => this.errCb?.(new Error("ENOSPC: no space left on device, write")))
      return false // backpressure signaled; the drain never comes — only 'error'
    }
    return true
  }
  once(_event: "drain", _cb: () => void): void {
    /* drain never fires in this fake — the failure gate must win the race */
  }
  on(event: "error", cb: (err: Error) => void): void {
    if (event === "error") this.errCb = cb
  }
  end(cb: () => void): void {
    this.ended = true
    cb()
  }
  destroy(): void {
    this.destroyed = true
  }
}

const bytes = (...ns: number[]) => new Uint8Array(ns)
const sha256 = (parts: Uint8Array[]): string => {
  const h = createHash("sha256")
  for (const p of parts) h.update(p)
  return h.digest("hex")
}

const DEST = "C:\\fake\\model.tar.bz2"

function opts(over: Partial<Parameters<typeof downloadToFile>[0]> = {}) {
  return {
    url: "https://example.invalid/model.tar.bz2",
    dest: DEST,
    signal: new AbortController().signal,
    onProgress: () => {},
    ...over,
  }
}

describe("downloadToFile — success + integrity (finding 6)", () => {
  it("streams to the sink, reports progress, and passes a matching sha256 + byte pin", async () => {
    const chunks = [bytes(1, 2, 3), bytes(4, 5)]
    const sink = new FakeSink()
    const removeFile = vi.fn()
    const progress: Array<[number, number | undefined]> = []
    await downloadToFile(
      opts({
        fetchImpl: fetchOk(chunks, 5),
        openSink: () => sink,
        removeFile,
        onProgress: (r, t) => progress.push([r, t]),
        expectedSha256: sha256(chunks),
        expectedBytes: 5,
      }),
    )
    expect(sink.ended).toBe(true)
    expect(sink.destroyed).toBe(false)
    expect(removeFile).not.toHaveBeenCalled()
    expect(progress.at(-1)).toEqual([5, 5])
  })

  it("REJECTS on a sha256 mismatch and deletes the corrupt file", async () => {
    const sink = new FakeSink()
    const removeFile = vi.fn()
    await expect(
      downloadToFile(
        opts({
          fetchImpl: fetchOk([bytes(1, 2, 3)]),
          openSink: () => sink,
          removeFile,
          expectedSha256: "deadbeef".repeat(8),
        }),
      ),
    ).rejects.toThrow(/integrity/i)
    expect(removeFile).toHaveBeenCalledWith(DEST)
    expect(sink.destroyed).toBe(true)
  })

  it("REJECTS when received bytes != the pinned byte count", async () => {
    const removeFile = vi.fn()
    await expect(
      downloadToFile(
        opts({
          fetchImpl: fetchOk([bytes(1, 2, 3)]),
          openSink: () => new FakeSink(),
          removeFile,
          expectedBytes: 999,
        }),
      ),
    ).rejects.toThrow(/size mismatch/i)
    expect(removeFile).toHaveBeenCalledWith(DEST)
  })

  it("REJECTS when received bytes != the server's Content-Length (truncation)", async () => {
    const removeFile = vi.fn()
    await expect(
      downloadToFile(
        opts({
          fetchImpl: fetchOk([bytes(1, 2, 3)], 100), // header says 100, stream gives 3
          openSink: () => new FakeSink(),
          removeFile,
        }),
      ),
    ).rejects.toThrow(/truncated/i)
    expect(removeFile).toHaveBeenCalledWith(DEST)
  })

  it("rejects an HTTP error before ever opening a sink", async () => {
    const openSink = vi.fn()
    const failFetch: FetchLike = async () => ({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      headers: { get: () => null },
      body: null,
    })
    await expect(
      downloadToFile(opts({ fetchImpl: failFetch, openSink: openSink as never })),
    ).rejects.toThrow(/HTTP 503/)
    expect(openSink).not.toHaveBeenCalled()
  })
})

describe("downloadToFile — MAJOR 1: mid-loop stream errors", () => {
  it("an ENOSPC during the write loop REJECTS (never hangs the drain wait), destroys the sink, deletes the partial", async () => {
    const sink = new FakeSink()
    sink.failOnWrite = 2 // second write: returns false (backpressure) then errors — no drain ever
    const removeFile = vi.fn()
    await expect(
      downloadToFile(
        opts({
          fetchImpl: fetchOk([bytes(1), bytes(2), bytes(3)]),
          openSink: () => sink,
          removeFile,
        }),
      ),
    ).rejects.toThrow(/ENOSPC/)
    expect(sink.destroyed).toBe(true)
    expect(removeFile).toHaveBeenCalledWith(DEST)
  })

  it("a stream error racing the reader (not just the drain) also rejects cleanly", async () => {
    // A sink that errors on the FIRST write but returns true — the failure must be
    // caught by the race on the NEXT reader.read() await, not by a drain wait.
    const sink = new FakeSink()
    const origWrite = sink.write.bind(sink)
    sink.write = (chunk) => {
      origWrite(chunk)
      queueMicrotask(() => (sink as unknown as { errCb?: (e: Error) => void }).errCb?.(new Error("EIO: i/o error")))
      return true
    }
    // A slow reader so the microtask error lands while awaiting read().
    const slowReader: BodyReader = {
      read: () => new Promise((r) => setTimeout(() => r({ done: false, value: bytes(9) }), 20)),
    }
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      body: { getReader: () => slowReader },
    })
    const removeFile = vi.fn()
    await expect(
      downloadToFile(opts({ fetchImpl, openSink: () => sink, removeFile })),
    ).rejects.toThrow(/EIO/)
    expect(sink.destroyed).toBe(true)
    expect(removeFile).toHaveBeenCalledWith(DEST)
  })

  it("abort mid-stream rejects with AbortError and deletes the partial", async () => {
    const ac = new AbortController()
    const chunks = [bytes(1), bytes(2), bytes(3)]
    let reads = 0
    const reader: BodyReader = {
      read: async () => {
        if (reads === 1) ac.abort() // abort lands between chunks
        return reads < chunks.length ? { done: false, value: chunks[reads++] } : { done: true }
      },
    }
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      body: { getReader: () => reader },
    })
    const sink = new FakeSink()
    const removeFile = vi.fn()
    await expect(
      downloadToFile(opts({ fetchImpl, openSink: () => sink, removeFile, signal: ac.signal })),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(sink.destroyed).toBe(true)
    expect(removeFile).toHaveBeenCalledWith(DEST)
  })
})
