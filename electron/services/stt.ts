import { join } from "node:path"
import {
  MODEL_FILES,
  MODEL_ARCHIVE_URL,
  MODEL_ARCHIVE_FILENAME,
  MODEL_EXTRACTED_DIRNAME,
  MODEL_ATTRIBUTION,
  STT_ENGINE,
  DEFAULT_HOTWORDS_SCORE,
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
 *    watchdog-kill it when wedged (review finding 3), and dispose on app quit.
 *  - **model acquisition** — a cancel/retry-able download + extract + verify state machine
 *    for the ~460 MB Parakeet archive (NOT bundled), with progress pushed to the renderer,
 *    integrity-pinned (finding 6) and force-re-downloadable (the corrupt-model recovery).
 *  - **status** — a single coarse {@link SttStatus} the composer keys its mic affordance on,
 *    including the present-but-unloadable-model case (finding 5).
 */

/** Review finding 3 — the init watchdog: a worker that never posts `ready`. */
export const INIT_TIMEOUT_MS = 60_000
/** Review finding 3 — the per-utterance watchdog: a wedged (non-crashed) decode. */
export const TRANSCRIBE_TIMEOUT_MS = 30_000
/** Review finding 5 — consecutive init failures before status() reports "error". */
export const WORKER_FAIL_LIMIT = 3

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
  /** Download `url` -> `dest`, reporting byte progress, abortable via `signal`.
   *  The real impl (runtime.ts → download.ts) also enforces the finding-6 integrity
   *  pins (Content-Length + exact bytes + SHA-256) and deletes the partial on failure. */
  download: (opts: {
    url: string
    dest: string
    signal: AbortSignal
    onProgress: (receivedBytes: number, totalBytes?: number) => void
  }) => Promise<void>
  /** Extract a `.tar.bz2` archive into `destDir`. Review finding 7 — MUST honor the
   *  signal (reject with an AbortError + destroy its streams) so cancel stays responsive
   *  during the extract phase, not just the download. */
  extract: (archivePath: string, destDir: string, signal: AbortSignal) => Promise<void>
  /** Review finding 3 — watchdog overrides (tests use tiny values); default the constants. */
  initTimeoutMs?: number
  transcribeTimeoutMs?: number
  now?: () => number
  logWarn?: (message: string) => void
  /**
   * CAPP-121 (STT-2) — materialize the workspace-vocabulary hotwords file. The real impl
   * (runtime.ts) char-level-tokenizes the words against `tokens.txt` and atomically writes
   * `<sttRoot>/hotwords.txt`, returning its path + the count of ENCODABLE terms. Absent (or
   * a `count: 0` return) => NO biasing: the recognizer stays on the greedy default path
   * (the fallback when hotwords aren't supported). Kept behind the dep so SttService is pure.
   */
  writeHotwords?: (words: readonly string[]) => { path: string; count: number }
  /** CAPP-121 — the hotword boost passed to the recognizer; defaults DEFAULT_HOTWORDS_SCORE. */
  hotwordsScore?: number
}

type Pending = {
  resolve: (t: SttTranscription) => void
  reject: (e: Error) => void
  /** Finding 3 — the per-utterance watchdog timer, cleared on result/error/teardown. */
  timer: ReturnType<typeof setTimeout>
}

export class SttService {
  private worker: SttWorkerLike | null = null
  /** Resolves when the current worker has posted `ready`; null when no worker. */
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((e: Error) => void) | null = null
  /** Finding 3 — the init watchdog timer for the CURRENT worker. */
  private initTimer: ReturnType<typeof setTimeout> | null = null
  /** True once the current worker posted `ready` (gates init-failure accounting). */
  private workerReady = false
  private seq = 0
  private readonly pending = new Map<number, Pending>()

  /** Finding 5 — the worker-failure ledger: consecutive init failures + the last reason.
   *  At WORKER_FAIL_LIMIT, status() stops reporting a broken-model dir as "ready" (which
   *  would otherwise re-fork a doomed process on every mic press, invisibly). */
  private workerFailCount = 0
  private lastWorkerError: string | null = null

  /** True while an acquisition (download+extract) is in flight. */
  private acquiring = false
  private abort: AbortController | null = null
  private lastError: string | null = null
  private disposed = false

  /** CAPP-121 (STT-2) — the current workspace-vocabulary hotword state.
   *  `hotwords` is the last vocabulary that reached a TERMINAL SUCCESSFUL state (file written,
   *  or a deliberate empty/no-writer plain-decode) — it is the baseline for the sameWords
   *  no-op guard. Review MAJOR 1: it is set to NULL after a FAILED write, so a later regen
   *  with the IDENTICAL word list is NEVER swallowed by the guard — it retries the write.
   *  (A sticky failure would leave biasing silently inert forever.) `hotwordsPath`/
   *  `appliedHotwordCount` reflect the MATERIALIZED file (null path => no biasing). `dirty`
   *  means a live warm worker was built with the OLD config and must be rebuilt LAZILY on the
   *  next quiet transcribe — so a workspace switch mid-recording never churns the recognizer. */
  private hotwords: string[] | null = []
  private hotwordsPath: string | null = null
  private appliedHotwordCount = 0
  private hotwordsDirty = false

  private readonly listeners = new Set<(p: SttProgress) => void>()

  constructor(private readonly deps: SttDeps) {}

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
    if (this.modelPresent()) {
      // Finding 5 — a present-but-unloadable model (corrupt files, a broken addon) is an
      // ERROR, not "ready": otherwise every mic press forks a fresh doomed process forever.
      return this.workerFailCount >= WORKER_FAIL_LIMIT ? "error" : "ready"
    }
    if (this.lastError) return "error"
    return "not-downloaded"
  }

  /** The human-readable reason behind an "error" status (null otherwise). */
  statusMessage(): string | null {
    if (this.acquiring) return null
    if (this.modelPresent()) {
      return this.workerFailCount >= WORKER_FAIL_LIMIT ? this.lastWorkerError : null
    }
    return this.lastError
  }

  get attribution(): string {
    return MODEL_ATTRIBUTION
  }

  get modelDir(): string {
    return this.deps.modelDir
  }

  /** CAPP-121 (STT-2) — the count of active workspace-vocabulary hotwords (0 when none),
   *  surfaced in the status snapshot for the mic tooltip. */
  get hotwordCount(): number {
    return this.appliedHotwordCount
  }

  /**
   * CAPP-121 (STT-2) — set the workspace-vocabulary hotwords. Called from the wiring layer
   * on workspace activation + (debounced) workspace-memory changes, resolving from the ACTIVE
   * workspace (dictation is a user-facing input affordance — active selection is correct here).
   *
   * Materializes the hotwords FILE eagerly (cheap: char-level tokenization + an only-if-changed
   * atomic write) so the count is known immediately, but keeps the recognizer rebuild LAZY:
   * it only marks the warm worker dirty so the NEXT transcribe respawns it with the new config.
   * That way a workspace switch never kills a warm/in-use recognizer mid-recording. An identical
   * vocabulary is a no-op (no file write, no dirty flip) so repeated calls don't churn.
   */
  setHotwords(words: readonly string[]): void {
    if (this.disposed) return
    const next = words.filter((w) => typeof w === "string" && w.trim().length > 0)
    // The no-op guard compares against the last KNOWN-GOOD vocabulary only — after a failed
    // write `this.hotwords` is null, so an identical retry always falls through (MAJOR 1).
    if (this.hotwords !== null && sameWords(this.hotwords, next)) return
    if (this.deps.writeHotwords && next.length > 0) {
      try {
        const { path, count } = this.deps.writeHotwords(next)
        // count 0 => nothing encodable => no biasing (fallback to greedy).
        this.hotwordsPath = count > 0 ? path : null
        this.appliedHotwordCount = count
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.deps.logWarn?.(`stt setHotwords failed: ${message}`)
        this.hotwordsPath = null
        this.appliedHotwordCount = 0
        // Review MAJOR 1 — do NOT commit the vocabulary baseline: null means "no known-good
        // state", so the NEXT regen (even byte-identical) bypasses the guard and RETRIES.
        // The first-run case (a regen before the model download → tokens.txt ENOENT) would
        // otherwise leave biasing permanently inert. A stale live worker may still be biased
        // by the OLD file, so mark dirty to rebuild it plain.
        this.hotwords = null
        this.hotwordsDirty = true
        return
      }
    } else {
      // No writer wired (tests / unsupported) or an empty vocabulary => plain decoding.
      // This IS a terminal successful state — commit it below.
      this.hotwordsPath = null
      this.appliedHotwordCount = 0
    }
    this.hotwords = [...next]
    // A live worker was built with the previous config — rebuild it lazily on next transcribe.
    this.hotwordsDirty = true
  }

  // -------------------------------------------------------------------------
  // Acquisition state machine (download -> extract -> verify), cancel/retry
  // -------------------------------------------------------------------------

  /**
   * Ensure the model is present, downloading + extracting it if not. Idempotent:
   * a second call while one is in flight is a no-op; a call once present emits a
   * terminal `ready` and returns. Cancellable via {@link cancelAcquire} — responsive
   * during BOTH the download and the extract phase (finding 7); a failed or cancelled
   * run leaves NO half-written model dir (verification gates the rename, and partial
   * artifacts are wiped).
   *
   * Finding 6c — `force: true` is the corrupt-model recovery path (the overlay's
   * "Re-download model"): kill any live worker over the (possibly bad) files, delete
   * the model dir, reset the worker-failure ledger, and re-download from scratch.
   */
  async acquire(opts?: { force?: boolean }): Promise<void> {
    if (opts?.force && !this.acquiring) {
      if (this.worker) this.failWorker(new Error("model re-download requested"))
      this.deps.remove(this.deps.modelDir)
      this.workerFailCount = 0
      this.lastWorkerError = null
    }
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
      // Finding 7 — the signal is threaded INTO extract so a cancel mid-extract rejects
      // promptly (the impl destroys its streams) instead of running to completion.
      await this.deps.extract(archivePath, sttRoot, ac.signal)
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
      // Fresh, verified files deserve a fresh worker ledger (finding 5/6 recovery).
      this.workerFailCount = 0
      this.lastWorkerError = null
      this.emit({ phase: "ready" })
    } catch (err) {
      if (this.isAbort(err) || ac.signal.aborted) {
        // Cancelled: wipe partial artifacts so a retry starts clean.
        this.deps.remove(archivePath)
        this.deps.remove(extractedDir)
        this.lastError = null
        this.emit({ phase: "cancelled" })
      } else {
        // Finding 7 — a failed run also cleans the temp extraction dir (a half-extracted
        // tree would otherwise sit there and poison nothing but waste ~1.5 GB).
        this.deps.remove(extractedDir)
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
    this.workerReady = false
    // Capture the promise locally: a worker that rejects init SYNCHRONOUSLY (a test fake,
    // or an addon that throws on load) triggers teardownWorker mid-`postMessage`, which nulls
    // `this.readyPromise` — so returning the field would return null and orphan the rejection.
    const readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.readyPromise = readyPromise

    // Finding 5 — per-worker, at-most-once init-failure accounting. Counts an init-error
    // message, an init watchdog expiry, or an exit-before-ready — whichever lands first —
    // and never a mid-life crash (workerReady gates it).
    let failureCounted = false
    const countInitFailure = (message: string) => {
      if (failureCounted || this.workerReady) return
      failureCounted = true
      this.workerFailCount++
      this.lastWorkerError = message
    }

    // Finding 3 — the init watchdog: a worker that never posts `ready` (a wedged ORT
    // load) would otherwise hang the readyPromise forever. On expiry: count the failure,
    // reject + KILL so the next call respawns.
    const initMs = this.deps.initTimeoutMs ?? INIT_TIMEOUT_MS
    this.initTimer = setTimeout(() => {
      if (this.worker !== worker) return
      const message = `recognizer init timed out after ${initMs}ms`
      countInitFailure(message)
      this.failWorker(new Error(message))
    }, initMs)

    worker.onMessage((msg) => {
      // A stale worker (already torn down / replaced) must never touch current state.
      if (this.worker !== worker) return
      if (msg.type === "ready") {
        this.clearInitTimer()
        this.workerReady = true
        // Finding 5 — a successful init resets the consecutive-failure ledger.
        this.workerFailCount = 0
        this.lastWorkerError = null
        this.readyResolve?.()
      } else if (msg.type === "result") {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          clearTimeout(p.timer)
          const result: SttTranscription = { text: msg.text ?? "", engine: STT_ENGINE, ms: msg.ms ?? 0 }
          // CAPP-121 (STT-2) — attribute the biasing that shaped THIS decode (this worker was
          // init'd with the current hotwords config). Omitted when none, so a no-hotwords
          // result stays `{ text, engine, ms }` (byte-unchanged).
          if (this.appliedHotwordCount > 0) result.hotwordCount = this.appliedHotwordCount
          p.resolve(result)
        }
      } else if (msg.type === "error") {
        if (typeof msg.id === "number") {
          const p = this.pending.get(msg.id)
          if (p) {
            this.pending.delete(msg.id)
            clearTimeout(p.timer)
            p.reject(new Error(msg.message || "transcription failed"))
          }
        } else {
          // An init-time failure: count it (finding 5), reject the ready gate + fail the
          // worker (teardown + kill) so the next transcribe respawns.
          const message = msg.message || "recognizer init failed"
          countInitFailure(message)
          this.failWorker(new Error(message))
        }
      }
    })
    worker.onExit(() => {
      if (this.worker !== worker) return
      countInitFailure(this.lastWorkerError ?? "stt worker exited during startup")
      this.teardownWorker(new Error("stt worker exited"))
    })
    // CAPP-121 (STT-2) — carry the active hotwords config into the recognizer build. A null
    // path => the init omits both fields => the byte-unchanged greedy default (CAPP-120).
    worker.postMessage({
      type: "init",
      modelDir: this.deps.modelDir,
      hotwordsFile: this.hotwordsPath ?? undefined,
      hotwordsScore: this.hotwordsPath ? (this.deps.hotwordsScore ?? DEFAULT_HOTWORDS_SCORE) : undefined,
    })
    return readyPromise
  }

  private clearInitTimer(): void {
    if (this.initTimer) {
      clearTimeout(this.initTimer)
      this.initTimer = null
    }
  }

  /** Drop the current worker + fail every in-flight promise so the next call respawns. */
  private teardownWorker(err: Error): void {
    this.clearInitTimer()
    this.readyReject?.(err)
    this.readyResolve = null
    this.readyReject = null
    this.readyPromise = null
    this.worker = null
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  /** Teardown AND kill: for a worker that's alive-but-broken (wedged, init-failed). */
  private failWorker(err: Error): void {
    const worker = this.worker
    this.teardownWorker(err)
    try {
      worker?.kill()
    } catch {
      /* best-effort */
    }
  }

  /**
   * Transcribe 16 kHz mono Float32 audio. Lazily spawns + warms the worker on first
   * use; respawns transparently if the worker crashed. Watchdogged (finding 3): a
   * wedged worker rejects after TRANSCRIBE_TIMEOUT_MS and is killed, so the composer
   * spinner can never hang until an app restart. Throws if the model isn't downloaded
   * (the composer routes that to the acquire flow before ever calling this).
   */
  async transcribe(samples: Float32Array, sampleRate: number): Promise<SttTranscription> {
    if (this.disposed) throw new Error("stt service disposed")
    if (!this.modelPresent()) throw new Error("STT model is not downloaded")
    if (!samples || samples.length === 0) throw new Error("no audio captured")
    // CAPP-121 (STT-2) — the LAZY hotword rebuild: if the vocabulary changed since this warm
    // worker was built, drop it here (between utterances, never mid-recording) so ensureWorker
    // respawns with the new config. No live worker => nothing to drop; ensureWorker just builds
    // fresh with the current config. Review NIT 4 — if another decode is IN FLIGHT (split-view
    // composers share this one service; the IPC handler has no single-flight), DEFER the
    // rebuild: keep the dirty flag set and never failWorker over a live decode — the next
    // quiet transcribe performs it.
    if (this.hotwordsDirty && this.pending.size === 0) {
      this.hotwordsDirty = false
      if (this.worker) this.failWorker(new Error("hotwords changed — rebuilding recognizer"))
    }
    await this.ensureWorker()
    const worker = this.worker
    if (!worker) throw new Error("stt worker unavailable")
    const id = ++this.seq
    const transcribeMs = this.deps.transcribeTimeoutMs ?? TRANSCRIBE_TIMEOUT_MS
    return new Promise<SttTranscription>((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id)
        if (!p) return
        this.pending.delete(id)
        p.reject(new Error(`transcription timed out after ${transcribeMs}ms — restarting the engine`))
        // The worker is wedged, not crashed — kill it so the NEXT call respawns fresh.
        this.failWorker(new Error("stt worker unresponsive"))
      }, transcribeMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        worker.postMessage({ type: "transcribe", id, sampleRate, samples })
      } catch (err) {
        const p = this.pending.get(id)
        if (p) {
          this.pending.delete(id)
          clearTimeout(p.timer)
        }
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** Kill the worker + release resources on app quit. Best-effort. */
  dispose(): void {
    this.disposed = true
    this.cancelAcquire()
    this.failWorker(new Error("stt service disposed"))
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

/** CAPP-121 — cheap order-sensitive equality so an unchanged vocabulary is a true no-op. */
function sameWords(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
