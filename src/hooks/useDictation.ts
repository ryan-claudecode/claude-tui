import { useCallback, useEffect, useRef, useState } from "react"
import { downsampleTo16kMono, mergeFloat32 } from "../lib/audioCapture"
import { recordingTick, MAX_RECORDING_MS } from "../lib/micInteraction"
import type { SttProgress, SttStatus } from "../../electron/stt/protocol"

/**
 * CAPP-120 (STT-1) — the push-to-talk dictation capture engine (renderer side).
 *
 * Owns the mic lifecycle: getUserMedia -> a Web Audio ScriptProcessor tap that accumulates
 * raw Float32 PCM -> on stop, merge + downsample to 16 kHz (pure helpers) -> transcribe over
 * IPC -> hand the text back via `onInsert`. Also tracks the model-acquisition status/progress
 * so the composer can surface a first-enable download flow. Every window/api touch is inside
 * an effect or callback (never at render), so the composer stays SSR-safe.
 *
 * Review hardening: the recording clock is `recordingTick` (pure, tested) and AUTO-STOPS
 * at MAX_RECORDING_MS (finding 4 — unbounded Float32 accumulation); a stream acquired
 * AFTER unmount is immediately stopped (finding 9's mid-start race).
 */

export type MicState = "idle" | "recording" | "transcribing"

interface UseDictationOpts {
  /** Called with the (trimmed, non-empty) transcription so the composer splices it in. */
  onInsert: (text: string) => void
  /** Called with a human-readable message on mic/transcribe/acquire failure. */
  onError: (message: string) => void
  /** Called with a non-error notice (e.g. the finding-4 recording cap). */
  onNotice?: (message: string) => void
}

export function useDictation({ onInsert, onError, onNotice }: UseDictationOpts) {
  const [status, setStatus] = useState<SttStatus>("not-downloaded")
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [attribution, setAttribution] = useState("")
  /** CAPP-121 (STT-2) — count of active workspace-vocabulary hotwords, for the mic tooltip. */
  const [hotwordCount, setHotwordCount] = useState(0)
  const [progress, setProgress] = useState<SttProgress | null>(null)
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [elapsedSec, setElapsedSec] = useState(0)

  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const procRef = useRef<ScriptProcessorNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const chunksRef = useRef<Float32Array[]>([])
  const timerRef = useRef<number | null>(null)
  const recordingRef = useRef(false)
  /** Finding 9 — set on unmount so a getUserMedia that resolves AFTER unmount is
   *  immediately released instead of starting capture on a dead hook. */
  const unmountedRef = useRef(false)
  /** The cap's auto-stop needs `stop` from inside `start`'s interval; a ref avoids the
   *  define-order/stale-closure knot (stop is declared after start would capture it). */
  const stopRef = useRef<() => Promise<void>>(async () => {})

  const refreshStatus = useCallback(async () => {
    try {
      const s = await window.api.sttStatus()
      setStatus(s.status)
      setStatusMessage(s.message ?? null)
      setEnabled(s.enabled)
      setAttribution(s.attribution)
      setHotwordCount(s.hotwordCount ?? 0)
    } catch {
      /* leave prior state; the mic just won't be actionable */
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  // Live acquisition progress -> refresh coarse status on every terminal phase.
  useEffect(() => {
    const off = window.api.onSttProgress((p) => {
      setProgress(p)
      if (p.phase === "ready" || p.phase === "error" || p.phase === "cancelled") {
        void refreshStatus()
      }
    })
    return off
  }, [refreshStatus])

  /** Tear down the capture graph; returns the AudioContext so the caller can close it. */
  const teardownCapture = useCallback((): AudioContext | null => {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    try {
      if (procRef.current) procRef.current.onaudioprocess = null
      procRef.current?.disconnect()
    } catch {
      /* ignore */
    }
    try {
      sourceRef.current?.disconnect()
    } catch {
      /* ignore */
    }
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop())
    } catch {
      /* ignore */
    }
    const ctx = ctxRef.current
    procRef.current = null
    sourceRef.current = null
    streamRef.current = null
    ctxRef.current = null
    recordingRef.current = false
    return ctx
  }, [])

  const stop = useCallback(async () => {
    if (!recordingRef.current) return
    const chunks = chunksRef.current
    chunksRef.current = []
    const ctx = teardownCapture()
    setRecording(false)
    const inRate = ctx?.sampleRate ?? 48000
    try {
      await ctx?.close()
    } catch {
      /* ignore */
    }
    const samples = downsampleTo16kMono(mergeFloat32(chunks), inRate)
    if (samples.length === 0) return
    setTranscribing(true)
    try {
      const res = await window.api.sttTranscribe(samples, 16000)
      // CAPP-121 (STT-2) — refresh the tooltip's term count from the freshest decode.
      if (typeof res?.hotwordCount === "number") setHotwordCount(res.hotwordCount)
      const text = (res?.text ?? "").trim()
      if (text) onInsert(text)
    } catch (err) {
      onError(err instanceof Error ? err.message : "Transcription failed")
    } finally {
      setTranscribing(false)
    }
  }, [onInsert, onError, teardownCapture])

  // Keep the ref pointing at the freshest stop (the interval closure calls through it).
  useEffect(() => {
    stopRef.current = stop
  }, [stop])

  const start = useCallback(async () => {
    if (recordingRef.current) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      // Finding 9 — the mid-start race: if the composer unmounted while getUserMedia's
      // permission/device dance was in flight, release the tracks immediately — never
      // start capture on a dead hook (the mic indicator would be gone but the mic hot).
      if (unmountedRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      const Ctx: typeof AudioContext =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctx()
      const source = ctx.createMediaStreamSource(stream)
      const proc = ctx.createScriptProcessor(4096, 1, 1)
      chunksRef.current = []
      proc.onaudioprocess = (e) => {
        chunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)))
      }
      source.connect(proc)
      proc.connect(ctx.destination)
      streamRef.current = stream
      ctxRef.current = ctx
      sourceRef.current = source
      procRef.current = proc
      recordingRef.current = true
      setRecording(true)
      setElapsedSec(0)
      const startedAt = Date.now()
      timerRef.current = window.setInterval(() => {
        // Finding 4 — the recording cap. recordingTick is the pure, tested clock: at
        // MAX_RECORDING_MS auto-STOP exactly like a manual stop (transcribe what was
        // captured) + surface a notice. Unbounded capture is ~11.5 MB/min of Float32.
        const t = recordingTick(startedAt, Date.now(), MAX_RECORDING_MS)
        setElapsedSec(t.elapsedSec)
        if (t.capped && recordingRef.current) {
          onNotice?.(
            `Recording capped at ${Math.round(MAX_RECORDING_MS / 60_000)} minutes — transcribing what was captured.`,
          )
          void stopRef.current()
        }
      }, 250)
    } catch (err) {
      teardownCapture()
      setRecording(false)
      onError(err instanceof Error ? err.message : "Microphone access was denied")
    }
  }, [onError, onNotice, teardownCapture])

  /** Quick-click semantics: toggle recording on/off. */
  const toggleRecord = useCallback(() => {
    if (recordingRef.current) void stop()
    else void start()
  }, [start, stop])

  /** Discard an in-flight recording without transcribing (Escape). */
  const cancelRecording = useCallback(() => {
    if (!recordingRef.current) return
    chunksRef.current = []
    const ctx = teardownCapture()
    void ctx?.close()
    setRecording(false)
  }, [teardownCapture])

  /** Kick off model acquisition. `force` (review finding 6c) = the corrupt-model
   *  recovery: delete the model dir + re-download ("Re-download model"). */
  const acquire = useCallback(
    async (force?: boolean) => {
      try {
        const s = await window.api.sttAcquire(force === true)
        setStatus(s)
      } catch (err) {
        onError(err instanceof Error ? err.message : "Could not start the model download")
      }
    },
    [onError],
  )

  const cancelAcquire = useCallback(() => {
    void window.api.sttCancelAcquire()
  }, [])

  // Unmount safety: never leave the mic hot / a context open if the composer tears down.
  // unmountedRef also arms the finding-9 mid-start guard above.
  useEffect(
    () => () => {
      unmountedRef.current = true
      if (recordingRef.current) {
        const ctx = teardownCapture()
        void ctx?.close()
      }
    },
    [teardownCapture],
  )

  return {
    status,
    statusMessage,
    enabled,
    attribution,
    hotwordCount,
    progress,
    recording,
    transcribing,
    elapsedSec,
    micState: (recording ? "recording" : transcribing ? "transcribing" : "idle") as MicState,
    toggleRecord,
    start,
    stop,
    cancelRecording,
    acquire,
    cancelAcquire,
    refreshStatus,
  }
}
