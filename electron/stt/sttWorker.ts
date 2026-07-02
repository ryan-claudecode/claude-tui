/**
 * CAPP-120 (STT-1) — the Parakeet recognizer host, run in an Electron UTILITY PROCESS
 * (`utilityProcess.fork`), NOT the main process. ORT (onnxruntime) is a heavy, blocking
 * native library; hosting it here keeps `numThreads: 4` inference off the main thread so
 * the UI never janks. This module is the fork entry — it is spawned as `out/main/sttWorker.js`.
 *
 * Protocol (see `protocol.ts`): the parent posts `init(modelDir)` ONCE (recognizer built
 * warm) then `transcribe(id, samples, sampleRate)` per utterance; we reply `ready` / `result`
 * / `error`. `sherpa-onnx-node` is a native addon — externalized from the bundle and
 * asar-unpacked — required LAZILY inside a try/catch so a load/build issue is reported as a
 * clean `error` message instead of an opaque process crash.
 *
 * The recognizer config is EXACTLY the live-validated probe config: nemo_transducer, int8
 * encoder/decoder/joiner, featureDim 80 @ 16 kHz, numThreads 4.
 */
import { join } from "node:path"
import type { SttToWorker, SttFromWorker } from "./protocol"

// `process.parentPort` is the utility-process side of the parent<->child channel
// (typed by electron.d.ts's augmentation of NodeJS.Process).
const parentPort = process.parentPort

function post(msg: SttFromWorker): void {
  parentPort.postMessage(msg)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sherpa: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let recognizer: any = null

function init(modelDir: string): void {
  const t0 = Date.now()
  // Lazy require so a missing/failed native addon surfaces as a reported error rather
  // than a module-eval crash before any handler is wired.
  if (!sherpa) sherpa = require("sherpa-onnx-node")
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(modelDir, "encoder.int8.onnx"),
        decoder: join(modelDir, "decoder.int8.onnx"),
        joiner: join(modelDir, "joiner.int8.onnx"),
      },
      tokens: join(modelDir, "tokens.txt"),
      numThreads: 4,
      modelType: "nemo_transducer",
    },
  })
  post({ type: "ready", loadMs: Date.now() - t0 })
}

function transcribe(id: number, samples: Float32Array, sampleRate: number): void {
  if (!recognizer) throw new Error("recognizer not initialized")
  const t0 = Date.now()
  const stream = recognizer.createStream()
  // sherpa resamples internally if sampleRate !== featConfig.sampleRate, but we already
  // downsample to 16 kHz in the renderer so this is a straight decode.
  stream.acceptWaveform({ sampleRate, samples })
  recognizer.decode(stream)
  const text: string = recognizer.getResult(stream).text ?? ""
  post({ type: "result", id, text, ms: Date.now() - t0 })
}

parentPort.on("message", (e: { data: unknown }) => {
  const msg = e.data as SttToWorker
  try {
    if (msg.type === "init") {
      init(msg.modelDir)
    } else if (msg.type === "transcribe") {
      // Coerce in case structured clone handed us a plain array/ArrayBuffer view.
      const samples =
        msg.samples instanceof Float32Array ? msg.samples : new Float32Array(msg.samples as ArrayLike<number>)
      transcribe(msg.id, samples, msg.sampleRate)
    }
  } catch (err) {
    post({
      type: "error",
      id: msg && msg.type === "transcribe" ? msg.id : undefined,
      message: err instanceof Error ? err.message : String(err),
    })
  }
})
