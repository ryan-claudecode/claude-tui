/**
 * CAPP-120 (STT-1) — the CANONICAL, shared contract for the push-to-talk dictation
 * engine (Parakeet TDT via sherpa-onnx, hosted in an Electron utility process).
 *
 * Like `streamProtocol.ts`, this module is TYPES + CONSTANTS ONLY — zero runtime deps
 * — so it can be imported from any layer (the utility-process worker, the pure
 * SttService, the ipc wiring, tests) without pulling in `sherpa-onnx-node` (a native
 * addon that must never load in the main process or a unit test).
 *
 * The recognizer config + timings were pinned against a REAL sherpa-onnx-node run on
 * this machine (win-x64, model load 1557 ms one-time, a 7.4 s wav transcribed in
 * 270 ms CPU-only with perfect punctuation) — not invented.
 */

// ---------------------------------------------------------------------------
// Worker message protocol (parent process <-> utility process)
// ---------------------------------------------------------------------------

/** Parent -> worker: build the (warm) recognizer once from a model directory. */
export interface SttInitMsg {
  type: "init"
  modelDir: string
}

/** Parent -> worker: transcribe one utterance. `samples` are 16 kHz mono Float32. */
export interface SttTranscribeMsg {
  type: "transcribe"
  /** Correlates the result back to the awaiting transcribe() promise. */
  id: number
  sampleRate: number
  samples: Float32Array
}

export type SttToWorker = SttInitMsg | SttTranscribeMsg

/** Worker -> parent: the recognizer was created successfully (warm, ready to decode). */
export interface SttReadyMsg {
  type: "ready"
  /** One-time model-load cost in ms (diagnostic). */
  loadMs?: number
}

/** Worker -> parent: a transcription completed. */
export interface SttResultMsg {
  type: "result"
  id: number
  text: string
  /** Pure decode time in ms (the number the latency budget cares about). */
  ms: number
}

/** Worker -> parent: init or a transcribe failed. `id` present => a transcribe failed. */
export interface SttErrorMsg {
  type: "error"
  id?: number
  message: string
}

export type SttFromWorker = SttReadyMsg | SttResultMsg | SttErrorMsg

/**
 * The minimal surface the SttService drives, so the real Electron `utilityProcess`
 * (wrapped in `electron/stt/runtime.ts`) and a test fake are interchangeable.
 */
export interface SttWorkerLike {
  postMessage(msg: SttToWorker): void
  onMessage(cb: (msg: SttFromWorker) => void): void
  onExit(cb: (code: number) => void): void
  kill(): void
}

// ---------------------------------------------------------------------------
// Engine + model identity
// ---------------------------------------------------------------------------

/** The `engine` tag returned from every transcription (for logging / telemetry). */
export const STT_ENGINE = "parakeet-tdt-0.6b-v2-int8" as const

/** The 4 files the recognizer needs — the post-extract verification set. */
export const MODEL_FILES = [
  "encoder.int8.onnx",
  "decoder.int8.onnx",
  "joiner.int8.onnx",
  "tokens.txt",
] as const

/** The sherpa-onnx release asset (NOT bundled — 680 MB, acquired on first enable). */
export const MODEL_ARCHIVE_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2"

/** The downloaded archive's on-disk filename. */
export const MODEL_ARCHIVE_FILENAME = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2"

/** The folder the archive expands to (renamed to {@link MODEL_DIRNAME} post-extract). */
export const MODEL_EXTRACTED_DIRNAME = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"

/** The canonical model directory name under `~/.claude-tui/stt/`. */
export const MODEL_DIRNAME = "parakeet-tdt-0.6b-v2-int8"

/**
 * CC-BY-4.0 attribution, surfaced verbatim in the download-flow UI. The Parakeet
 * TDT 0.6B v2 model is licensed CC-BY-4.0 by NVIDIA.
 */
export const MODEL_ATTRIBUTION =
  "Speech model: NVIDIA Parakeet TDT 0.6B v2 (English), licensed CC-BY-4.0."

// ---------------------------------------------------------------------------
// Service-level status + acquisition progress (also the renderer contract)
// ---------------------------------------------------------------------------

/** The coarse dictation state the composer keys its mic affordance on. */
export type SttStatus = "ready" | "not-downloaded" | "downloading" | "error"

/** A single acquisition progress event, pushed to the renderer over `stt:progress`. */
export interface SttProgress {
  phase: "downloading" | "extracting" | "verifying" | "ready" | "error" | "cancelled"
  /** Present during `downloading`. */
  receivedBytes?: number
  /** Present during `downloading` when the server sent Content-Length. */
  totalBytes?: number
  /** Present on `error`. */
  message?: string
}

/** The status snapshot the `stt:status` IPC returns (status + config off-switch + dir). */
export interface SttStatusSnapshot {
  status: SttStatus
  /** config `stt.enabled` (default true) — false hides the mic affordance entirely. */
  enabled: boolean
  modelDir: string
  attribution: string
}

/** The transcription result shape (also the `stt:transcribe` IPC return). */
export interface SttTranscription {
  text: string
  engine: string
  ms: number
}
