/**
 * CAPP-120 (STT-1) — pure audio helpers for push-to-talk dictation.
 *
 * Mic capture (getUserMedia + Web Audio) is inherently browser-only, but the two math
 * steps between raw capture and the recognizer — merging the streamed chunks and
 * downsampling to the 16 kHz mono the Parakeet model expects — are pure and live here
 * so they're unit-tested in vitest's node environment (no DOM, no AudioContext).
 */

/** The rate the Parakeet recognizer expects (featConfig.sampleRate). */
export const TARGET_SAMPLE_RATE = 16000

/** Concatenate the streamed capture chunks into one contiguous Float32Array. */
export function mergeFloat32(chunks: Float32Array[]): Float32Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Float32Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/**
 * Downsample mono Float32 PCM to {@link TARGET_SAMPLE_RATE} via block averaging (the
 * standard box-filter downsampler — cheap, no ringing, good enough for ASR features).
 *
 *  - `inputSampleRate === targetRate` → a copy of the input (no resample).
 *  - `inputSampleRate < targetRate` (upsampling — shouldn't happen; capture ctx is
 *    typically 44.1/48 kHz) → returns a copy unchanged rather than fabricating samples.
 *  - empty input → empty output.
 */
export function downsampleTo16kMono(
  input: Float32Array,
  inputSampleRate: number,
  targetRate: number = TARGET_SAMPLE_RATE,
): Float32Array {
  if (input.length === 0) return new Float32Array(0)
  if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0) return input.slice()
  if (inputSampleRate <= targetRate) return input.slice()
  const ratio = inputSampleRate / targetRate
  const newLength = Math.floor(input.length / ratio)
  const result = new Float32Array(newLength)
  let offsetResult = 0
  let offsetInput = 0
  while (offsetResult < newLength) {
    const nextOffsetInput = Math.floor((offsetResult + 1) * ratio)
    let accum = 0
    let count = 0
    for (let i = offsetInput; i < nextOffsetInput && i < input.length; i++) {
      accum += input[i]
      count++
    }
    result[offsetResult] = count > 0 ? accum / count : 0
    offsetResult++
    offsetInput = nextOffsetInput
  }
  return result
}

/** Format an elapsed-seconds counter as `M:SS` for the recording indicator. */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}:${rem.toString().padStart(2, "0")}`
}
