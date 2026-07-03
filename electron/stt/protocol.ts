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
  /**
   * CAPP-121 (STT-2) — optional workspace-vocabulary biasing. When present, the worker
   * builds the recognizer with `decodingMethod: HOTWORDS_DECODING` + these fields (a
   * char-level-tokenized hotwords file, materialized by `SttService.setHotwords`). Absent
   * => the byte-unchanged greedy default. See `electron/stt/hotwords.ts` for the encoding.
   */
  hotwordsFile?: string
  hotwordsScore?: number
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

/**
 * CAPP-121 (STT-2) — the decoding method that enables contextual biasing. sherpa-onnx only
 * honors a hotwords file under `modified_beam_search` (live-verified against this offline
 * int8 nemo_transducer). The worker uses it ONLY when a hotwords file is supplied; otherwise
 * it stays on the default greedy path (byte-unchanged from CAPP-120).
 */
export const HOTWORDS_DECODING = "modified_beam_search" as const

/**
 * CAPP-121 — the default hotword boost. Deliberately MODEST: the live spike showed a
 * realistic domain vocabulary at ~1.5 biased listed terms WITHOUT corrupting clean
 * non-vocabulary speech (higher scores over-trigger / hallucinate). Overridable via
 * `SttDeps.hotwordsScore`.
 */
export const DEFAULT_HOTWORDS_SCORE = 1.5

/** The 4 files the recognizer needs — the post-extract verification set. */
export const MODEL_FILES = [
  "encoder.int8.onnx",
  "decoder.int8.onnx",
  "joiner.int8.onnx",
  "tokens.txt",
] as const

/**
 * The sherpa-onnx release asset (NOT bundled — acquired on first enable).
 *
 * NOTE (review NIT 12): `asr-models` is a MUTABLE release tag, so this URL alone would
 * be a silent-drift hazard. It is acceptable ONLY because the download is PINNED below
 * ({@link MODEL_ARCHIVE_SHA256} + {@link MODEL_ARCHIVE_BYTES}): a re-uploaded/replaced
 * asset now FAILS the integrity check loudly instead of silently shipping different bytes.
 */
export const MODEL_ARCHIVE_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2"

/**
 * Review finding 6 — the integrity pin: SHA-256 (hex) of the archive, computed from the
 * VERIFIED live download of this exact asset on this machine. The downloader hashes the
 * stream during the download (no second read) and fails acquisition on any mismatch.
 */
export const MODEL_ARCHIVE_SHA256 =
  "157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad"

/** Exact byte count of the archive (same provenance) — the cheap pre-hash gate: a
 *  truncated/padded download fails before the digest is even compared. */
export const MODEL_ARCHIVE_BYTES = 482468385

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
  /** Review finding 5 — present when status === "error": the acquisition failure OR the
   *  recognizer's repeated-init-failure detail, so the overlay can show WHY + offer the
   *  "Re-download model" recovery. */
  message?: string | null
  /** CAPP-121 (STT-2) — the count of active workspace-vocabulary hotwords, surfaced in the
   *  mic tooltip ("Parakeet · 214 workspace terms"). 0 when no vocabulary is active. */
  hotwordCount?: number
}

/** The transcription result shape (also the `stt:transcribe` IPC return). */
export interface SttTranscription {
  text: string
  engine: string
  ms: number
  /**
   * CAPP-121 (STT-2) — how many workspace-vocabulary hotwords biased THIS decode (the count
   * of successfully-encoded terms). Omitted when biasing wasn't applied (no vocabulary, or
   * the fallback plain-decode path), so a no-hotwords result stays `{ text, engine, ms }`.
   */
  hotwordCount?: number
}
