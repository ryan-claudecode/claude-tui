import { describe, it, expect, vi } from "vitest"
import { join, sep } from "node:path"
import { SttService, type SttDeps } from "./stt"
import {
  MODEL_FILES,
  MODEL_EXTRACTED_DIRNAME,
  MODEL_DIRNAME,
  type SttFromWorker,
  type SttToWorker,
  type SttWorkerLike,
  type SttProgress,
} from "../stt/protocol"

/**
 * CAPP-120 (STT-1) — the SttService is PURE (every effect injected), so this exercises
 * the worker protocol (init/transcribe/error/respawn) with a FAKE worker and the
 * acquisition state machine (download/extract/verify/cancel) with a FAKE fetch/fs — no
 * real utility process, no native addon, no network, no disk.
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeWorker implements SttWorkerLike {
  msgCb?: (m: SttFromWorker) => void
  exitCb?: (code: number) => void
  sent: SttToWorker[] = []
  killed = false
  /** How to respond to an `init` message: "ready" (default) | "init-error" | "silent". */
  initMode: "ready" | "init-error" | "silent" = "ready"
  /** How to respond to a `transcribe`: "result" (default) | "error" | "silent". */
  transcribeMode: "result" | "error" | "silent" = "result"
  cannedText = "hello world"

  postMessage(msg: SttToWorker): void {
    this.sent.push(msg)
    if (msg.type === "init") {
      if (this.initMode === "ready") this.msgCb?.({ type: "ready", loadMs: 1 })
      else if (this.initMode === "init-error") this.msgCb?.({ type: "error", message: "recognizer boom" })
    } else if (msg.type === "transcribe") {
      if (this.transcribeMode === "result")
        this.msgCb?.({ type: "result", id: msg.id, text: this.cannedText, ms: 7 })
      else if (this.transcribeMode === "error")
        this.msgCb?.({ type: "error", id: msg.id, message: "decode boom" })
    }
  }
  onMessage(cb: (m: SttFromWorker) => void): void {
    this.msgCb = cb
  }
  onExit(cb: (code: number) => void): void {
    this.exitCb = cb
  }
  kill(): void {
    this.killed = true
  }
  crash(code = 1): void {
    this.exitCb?.(code)
  }
}

/** A virtual filesystem backing the acquisition deps. */
function makeVfs(initial: string[] = []) {
  const set = new Set(initial)
  return {
    set,
    exists: (p: string) => set.has(p),
    ensureDir: (p: string) => {
      set.add(p)
    },
    remove: (p: string) => {
      for (const f of [...set]) if (f === p || f.startsWith(p + sep)) set.delete(f)
    },
    rename: (from: string, to: string) => {
      for (const f of [...set]) {
        if (f === from || f.startsWith(from + sep)) {
          set.delete(f)
          set.add(to + f.slice(from.length))
        }
      }
    },
  }
}

const ROOT = join("C:", "home", ".claude-tui", "stt")
const MODEL_DIR = join(ROOT, MODEL_DIRNAME)
const EXTRACTED_DIR = join(ROOT, MODEL_EXTRACTED_DIRNAME)
const modelFilePaths = MODEL_FILES.map((f) => join(MODEL_DIR, f))
const extractedFilePaths = MODEL_FILES.map((f) => join(EXTRACTED_DIR, f))

function baseDeps(overrides: Partial<SttDeps> = {}): SttDeps {
  const vfs = makeVfs()
  return {
    modelDir: MODEL_DIR,
    sttRoot: ROOT,
    spawnWorker: () => new FakeWorker(),
    exists: vfs.exists,
    ensureDir: vfs.ensureDir,
    remove: vfs.remove,
    rename: vfs.rename,
    download: async () => {},
    extract: async () => {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Worker protocol
// ---------------------------------------------------------------------------

describe("SttService — worker protocol", () => {
  it("transcribes: warms the worker once, returns { text, engine, ms }", async () => {
    const worker = new FakeWorker()
    const spawn = vi.fn(() => worker)
    const svc = new SttService(baseDeps({ exists: (p) => modelFilePaths.includes(p), spawnWorker: spawn }))

    const res = await svc.transcribe(new Float32Array([0.1, 0.2, 0.3]), 16000)
    expect(res).toEqual({ text: "hello world", engine: MODEL_DIRNAME, ms: 7 })
    // Warm: init posted once, then transcribe.
    expect(worker.sent[0]).toMatchObject({ type: "init", modelDir: MODEL_DIR })
    expect(worker.sent.find((m) => m.type === "transcribe")).toBeTruthy()

    // A second transcribe reuses the SAME worker (no re-init, no re-spawn).
    await svc.transcribe(new Float32Array([0.4]), 16000)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(worker.sent.filter((m) => m.type === "init")).toHaveLength(1)
  })

  it("rejects when the model isn't downloaded (routes to the acquire flow)", async () => {
    const svc = new SttService(baseDeps({ exists: () => false }))
    await expect(svc.transcribe(new Float32Array([0.1]), 16000)).rejects.toThrow(/not downloaded/i)
  })

  it("propagates a per-utterance decode error to the awaiting promise", async () => {
    const worker = new FakeWorker()
    worker.transcribeMode = "error"
    const svc = new SttService(
      baseDeps({ exists: (p) => modelFilePaths.includes(p), spawnWorker: () => worker }),
    )
    await expect(svc.transcribe(new Float32Array([0.1]), 16000)).rejects.toThrow(/decode boom/)
  })

  it("an init-time error rejects, and the NEXT transcribe respawns a fresh worker", async () => {
    const w1 = new FakeWorker()
    w1.initMode = "init-error"
    const w2 = new FakeWorker() // healthy
    const spawn = vi.fn().mockReturnValueOnce(w1).mockReturnValueOnce(w2)
    const svc = new SttService(
      baseDeps({ exists: (p) => modelFilePaths.includes(p), spawnWorker: spawn }),
    )

    await expect(svc.transcribe(new Float32Array([0.1]), 16000)).rejects.toThrow(/recognizer boom/)
    // Respawn on the next call.
    const res = await svc.transcribe(new Float32Array([0.2]), 16000)
    expect(res.text).toBe("hello world")
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it("respawns after the worker process crashes mid-life", async () => {
    const w1 = new FakeWorker()
    const w2 = new FakeWorker()
    const spawn = vi.fn().mockReturnValueOnce(w1).mockReturnValueOnce(w2)
    const svc = new SttService(
      baseDeps({ exists: (p) => modelFilePaths.includes(p), spawnWorker: spawn }),
    )

    await svc.transcribe(new Float32Array([0.1]), 16000)
    w1.crash(1) // worker exits unexpectedly
    const res = await svc.transcribe(new Float32Array([0.2]), 16000)
    expect(res.text).toBe("hello world")
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it("dispose kills the worker and rejects further transcriptions", async () => {
    const worker = new FakeWorker()
    const svc = new SttService(
      baseDeps({ exists: (p) => modelFilePaths.includes(p), spawnWorker: () => worker }),
    )
    await svc.transcribe(new Float32Array([0.1]), 16000)
    svc.dispose()
    expect(worker.killed).toBe(true)
    await expect(svc.transcribe(new Float32Array([0.1]), 16000)).rejects.toThrow(/disposed/)
  })
})

// ---------------------------------------------------------------------------
// Acquisition state machine
// ---------------------------------------------------------------------------

describe("SttService — acquisition state machine", () => {
  it("status is not-downloaded when the model files are absent", () => {
    const svc = new SttService(baseDeps({ exists: () => false }))
    expect(svc.status()).toBe("not-downloaded")
    expect(svc.modelPresent()).toBe(false)
  })

  it("downloads + extracts + verifies + renames, ending ready", async () => {
    const vfs = makeVfs()
    const progress: SttProgress[] = []
    const download = vi.fn(async (opts: Parameters<SttDeps["download"]>[0]) => {
      opts.onProgress(340_000_000, 680_000_000)
      opts.onProgress(680_000_000, 680_000_000)
      vfs.set.add(join(ROOT, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2"))
    })
    const extract = vi.fn(async () => {
      // The archive expands to MODEL_EXTRACTED_DIRNAME/<files>.
      for (const p of extractedFilePaths) vfs.set.add(p)
    })
    const svc = new SttService(
      baseDeps({ exists: vfs.exists, ensureDir: vfs.ensureDir, remove: vfs.remove, rename: vfs.rename, download, extract }),
    )
    svc.onProgress((p) => progress.push(p))

    expect(svc.status()).toBe("not-downloaded")
    await svc.acquire()

    expect(download).toHaveBeenCalledOnce()
    expect(extract).toHaveBeenCalledOnce()
    expect(svc.modelPresent()).toBe(true)
    expect(svc.status()).toBe("ready")
    // The extracted dir was renamed to the canonical model dir.
    expect(vfs.exists(join(MODEL_DIR, "encoder.int8.onnx"))).toBe(true)
    // Progress covered downloading -> extracting -> verifying -> ready.
    const phases = progress.map((p) => p.phase)
    expect(phases).toContain("downloading")
    expect(phases).toContain("extracting")
    expect(phases).toContain("verifying")
    expect(phases.at(-1)).toBe("ready")
    // Byte progress surfaced.
    const dl = progress.find((p) => p.phase === "downloading" && p.totalBytes)
    expect(dl?.totalBytes).toBe(680_000_000)
  })

  it("is idempotent: present model → emits ready, never downloads", async () => {
    const download = vi.fn(async () => {})
    const svc = new SttService(baseDeps({ exists: (p) => modelFilePaths.includes(p), download }))
    const progress: SttProgress[] = []
    svc.onProgress((p) => progress.push(p))
    await svc.acquire()
    expect(download).not.toHaveBeenCalled()
    expect(progress).toEqual([{ phase: "ready" }])
    expect(svc.status()).toBe("ready")
  })

  it("cancel: an aborted download ends cancelled, status back to not-downloaded", async () => {
    const download = vi.fn(
      (opts: Parameters<SttDeps["download"]>[0]) =>
        new Promise<void>((_res, rej) => {
          opts.onProgress(0, 680_000_000)
          opts.signal.addEventListener("abort", () => {
            const e = new Error("aborted")
            e.name = "AbortError"
            rej(e)
          })
        }),
    )
    const svc = new SttService(baseDeps({ exists: () => false, download }))
    const progress: SttProgress[] = []
    svc.onProgress((p) => progress.push(p))

    const p = svc.acquire()
    expect(svc.status()).toBe("downloading")
    svc.cancelAcquire()
    await p
    expect(progress.at(-1)?.phase).toBe("cancelled")
    expect(svc.status()).toBe("not-downloaded")
  })

  it("error: a failed download sets status error with the message", async () => {
    const download = vi.fn(async () => {
      throw new Error("HTTP 500")
    })
    const svc = new SttService(baseDeps({ exists: () => false, download }))
    const progress: SttProgress[] = []
    svc.onProgress((p) => progress.push(p))
    await svc.acquire()
    expect(svc.status()).toBe("error")
    expect(progress.at(-1)).toMatchObject({ phase: "error", message: "HTTP 500" })
  })

  it("verify failure: extract that produces no files throws → error", async () => {
    const svc = new SttService(
      baseDeps({ exists: () => false, download: async () => {}, extract: async () => {} }),
    )
    await svc.acquire()
    expect(svc.status()).toBe("error")
  })

  it("concurrent acquire is a no-op while one is in flight", async () => {
    let started = 0
    const download = vi.fn(
      (opts: Parameters<SttDeps["download"]>[0]) =>
        new Promise<void>((res) => {
          started++
          opts.onProgress(0, 100)
          setTimeout(res, 5)
        }),
    )
    const svc = new SttService(baseDeps({ exists: () => false, download, extract: async () => {} }))
    const a = svc.acquire()
    const b = svc.acquire() // no-op: already acquiring
    await Promise.all([a, b])
    expect(started).toBe(1)
  })
})
