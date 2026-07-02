import { join } from "node:path"
import {
  MODEL_FILES,
  MODEL_ARCHIVE_URL,
  MODEL_ARCHIVE_FILENAME,
  MODEL_EXTRACTED_DIRNAME,
  MODEL_ATTRIBUTION,
  STT_ENGINE,
  type SttWorkerLike,
  type SttStatus,
  type SttProgress,
  type SttTranscription,
} from "../stt/protocol"

/**
 * CAPP-120 (STT-1) — the push-to-talk dictation engine seam.
 *
 * Mirrors the SchedulerService posture: the service itself is PURE (no `electron`,
 * no `node:fs`, no `node:https`, no `sherpa-onnx-node` import) — EVERY external effect
 * is behind the injected {@link SttDeps} so the test suite drives it with fakes (a fake
 * worker for the init/transcribe/error/respawn protocol; a fake fetch/fs for the
 * acquisition state machine). The real implementations live in `electron/stt/runtime.ts`
 * and are injected once in `ipc.ts`.
 *
 * Responsibilities:
 *  - **worker lifecycle** — lazily fork the utility-process recognizer on the first
 *    transcribe (so a cold app never pays the ORT load), keep it WARM, respawn on crash,
 *    and dispose on app quit.
 *  - **model acquisition** — a cancel/retry-able download + extract + verify state machine
 *    for the 680 MB Parakeet model (NOT bundled), with progress pushed to the renderer.
 *  - **status** — a single coarse {@link SttStatus} the composer keys its mic affordance on.
 */

/** All external effects, injected. Real impls in `electron/stt/runtime.ts`. */
export interface SttDeps {
  /** `~/.claude-tui/stt/parakeet-tdt-0.6b-v2-int8/` — the verified model directory. */
  modelDir: string
  /** `~/.claude-tui/stt/` — the acquisition working root. */
  sttRoot: string
  /** Fork (or fake) the utility-process recognizer worker. */
  spawnWorker: () => SttWorkerLike
  /** True iff `path` exists on disk. */
  exists: (path: string) => boolean
  /** Recursively ensure a directory exists. */
  ensureDir: (path: string) => void
  /** Best-effort remove a file OR directory (recursive); never throws. */
  remove: (path: string) => void
  /** Rename/move `from` -> `to` (same volume). */
  rename: (from: string, to: string) => void
  /** Download `url` -> `dest`, reporting byte progress, abortable via `signal`. */
  download: (opts: {
    url: string
    dest: string
    signal: AbortSignal
    onProgress: (receivedBytes: number, totalBytes?: number) => void
  }) => Promise<void>
  /** Extract a `.tar.bz2` archive into `destDir`. */
  extract: (archivePath: string, destDir: string) => Promise<void>
  now?: () => number
  logWarn?: (message: string) => void
}

type Pending = {
  resolve: (t: SttTranscription) => void
  reject: (e: Error) => void
}

export class SttService {
  private worker: SttWorkerLike | null = null
  /** Resolves when the current worker has posted `ready`; null when no worker. */
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((e: Error) => void) | null = null
  private seq = 0
  private readonly pending = new Map<number, Pending>()

  /** True while an acquisition (download+extract) is in flight. */
  private acquiring = false
  private abort: AbortController | null = null
  private lastError: string | null = null
  private disposed = false

  private readonly listeners = new Set<(p: SttProgress) => void>()

  constructor(private readonly deps: SttDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /** Subscribe to acquisition progress. Returns an unsubscribe fn. */
  onProgress(cb: (p: SttProgress) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(p: SttProgress): void {
    for (const cb of this.listeners) {
      try {
        cb(p)
      } catch {
        /* a listener throw must never break the state machine */
      }
    }
  }

  /** True iff all 4 model files are present on disk. */
  modelPresent(): boolean {
    return MODEL_FILES.every((f) => this.deps.exists(join(this.deps.modelDir, f)))
  }

  /** The coarse state the composer keys its mic affordance on. */
  status(): SttStatus {
    if (this.acquiring) return "downloading"
    if (this.modelPresent()) return "ready"
    if (this.lastError) return "error"
    return "not-downloaded"
  }

  get attribution(): string {
    return MODEL_ATTRIBUTION
  }

  get modelDir(): string {
    return this.deps.modelDir
  }

  // -------------------------------------------------------------------------
  // Acquisition state machine (download -> extract -> verify), cancel/retry
  // -------------------------------------------------------------------------

  /**
   * Ensure the model is present, downloading + extracting it if not. Idempotent:
   * a second call while one is in flight is a no-op; a call once present emits a
   * terminal `ready` and returns. Cancellable via {@link cancelAcquire}; a failed or
   * cancelled run leaves NO half-written model dir (verification gates the rename).
   */
  async acquire(): Promise<void> {
    if (this.modelPresent()) {
      this.lastError = null
      this.emit({ phase: "ready" })
      return
    }
    if (this.acquiring) return
    this.acquiring = true
    this.lastError = null
    const ac = new AbortController()
    this.abort = ac
    const { sttRoot, modelDir } = this.deps
    const archivePath = join(sttRoot, MODEL_ARCHIVE_FILENAME)
    const extractedDir = join(sttRoot, MODEL_EXTRACTED_DIRNAME)
    try {
      this.deps.ensureDir(sttRoot)
      // A stale extracted dir from a previous failed run would poison verify; clear it.
      this.deps.remove(extractedDir)
      this.emit({ phase: "downloading", receivedBytes: 0 })
      await this.deps.download({
        url: MODEL_ARCHIVE_URL,
        dest: archivePath,
        signal: ac.signal,
        onProgress: (receivedBytes, totalBytes) =>
          this.emit({ phase: "downloading", receivedBytes, totalBytes }),
      })
      if (ac.signal.aborted) throw new DOMExceptionLike("aborted")
      this.emit({ phase: "extracting" })
      await this.deps.extract(archivePath, sttRoot)
      if (ac.signal.aborted) throw new DOMExceptionLike("aborted")
      this.emit({ phase: "verifying" })
      // The archive expands to MODEL_EXTRACTED_DIRNAME; adopt it as the canonical dir.
      if (extractedDir !== modelDir) {
        this.deps.remove(modelDir)
        this.deps.rename(extractedDir, modelDir)
      }
      if (!this.modelPresent()) {
        throw new Error("post-extract verification failed — expected model files are missing")
      }
      // Reclaim the archive; keep it non-fatal.
      this.deps.remove(archivePath)
      this.lastError = null
      this.emit({ phase: "ready" })
    } catch (err) {
      if (this.isAbort(err) || ac.signal.aborted) {
        // Cancelled: wipe partial artifacts so a retry starts clean.
        this.deps.remove(archivePath)
        this.deps.remove(extractedDir)
        this.lastError = null
        this.emit({ phase: "cancelled" })
      } else {
        const message = err instanceof Error ? err.message : String(err)
        this.lastError = message
        this.deps.logWarn?.(`stt acquire failed: ${message}`)
        this.emit({ phase: "error", message })
      }
    } finally {
      this.acquiring = false
      this.abort = null
    }
  }

  /** Cancel an in-flight acquisition (no-op when idle). */
  cancelAcquire(): void {
    this.abort?.abort()
  }

  private isAbort(err: unknown): boolean {
    return (
      !!err &&
      typeof err === "object" &&
      (err as { name?: string }).name === "AbortError"
    )
  }

  // -------------------------------------------------------------------------
  // Worker lifecycle + transcription
  // -------------------------------------------------------------------------

  private ensureWorker(): Promise<void> {
    if (this.worker && this.readyPromise) return this.readyPromise
    const worker = this.deps.spawnWorker()
    this.worker = worker
    // Capture the promise locally: a worker that rejects init SYNCHRONOUSLY (a test fake,
    // or an addon that throws on load) triggers teardownWorker mid-`postMessage`, which nulls
    // `this.readyPromise` — so returning the field would return null and orphan the rejection.
    const readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.readyPromise = readyPromise
    worker.onMessage((msg) => {
      if (msg.type === "ready") {
        this.readyResolve?.()
      } else if (msg.type === "result") {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          p.resolve({ text: msg.text ?? "", engine: STT_ENGINE, ms: msg.ms ?? 0 })
        }
      } else if (msg.type === "error") {
        if (typeof msg.id === "number") {
          const p = this.pending.get(msg.id)
          if (p) {
            this.pending.delete(msg.id)
            p.reject(new Error(msg.message || "transcription failed"))
          }
        } else {
          // An init-time failure: reject the ready gate + fail the worker so the next
          // transcribe respawns.
          this.readyReject?.(new Error(msg.message || "recognizer init failed"))
          this.teardownWorker(new Error(msg.message || "recognizer init failed"))
        }
      }
    })
    worker.onExit(() => {
      this.teardownWorker(new Error("stt worker exited"))
    })
    worker.postMessage({ type: "init", modelDir: this.deps.modelDir })
    return readyPromise
  }

  /** Drop the current worker + fail every in-flight promise so the next call respawns. */
  private teardownWorker(err: Error): void {
    this.readyReject?.(err)
    this.readyResolve = null
    this.readyReject = null
    this.readyPromise = null
    this.worker = null
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
  }

  /**
   * Transcribe 16 kHz mono Float32 audio. Lazily spawns + warms the worker on first
   * use; respawns transparently if the worker crashed. Throws if the model isn't
   * downloaded (the composer routes that to the acquire flow before ever calling this).
   */
  async transcribe(samples: Float32Array, sampleRate: number): Promise<SttTranscription> {
    if (this.disposed) throw new Error("stt service disposed")
    if (!this.modelPresent()) throw new Error("STT model is not downloaded")
    if (!samples || samples.length === 0) throw new Error("no audio captured")
    await this.ensureWorker()
    const worker = this.worker
    if (!worker) throw new Error("stt worker unavailable")
    const id = ++this.seq
    return new Promise<SttTranscription>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        worker.postMessage({ type: "transcribe", id, sampleRate, samples })
      } catch (err) {
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** Kill the worker + release resources on app quit. Best-effort. */
  dispose(): void {
    this.disposed = true
    this.cancelAcquire()
    const worker = this.worker
    this.teardownWorker(new Error("stt service disposed"))
    try {
      worker?.kill()
    } catch {
      /* best-effort */
    }
    this.listeners.clear()
  }
}

/**
 * A minimal AbortError-shaped throwable so the service can normalize its OWN
 * post-download abort check without importing DOM lib types. `download`'s real
 * `fetch` abort already throws a proper AbortError; this covers our manual re-check.
 */
class DOMExceptionLike extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AbortError"
  }
}
