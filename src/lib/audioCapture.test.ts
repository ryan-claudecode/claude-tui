import { describe, it, expect } from "vitest"
import { mergeFloat32, downsampleTo16kMono, formatElapsed } from "./audioCapture"

describe("audioCapture — mergeFloat32", () => {
  it("concatenates chunks in order", () => {
    const out = mergeFloat32([new Float32Array([1, 2]), new Float32Array([3]), new Float32Array([4, 5])])
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5])
  })
  it("empty input → empty output", () => {
    expect(mergeFloat32([]).length).toBe(0)
  })
})

describe("audioCapture — downsampleTo16kMono", () => {
  it("48kHz → 16kHz reduces length ~3x", () => {
    const input = new Float32Array(48000).fill(0.5)
    const out = downsampleTo16kMono(input, 48000)
    expect(out.length).toBe(16000)
    // Box-averaging a constant signal preserves the value.
    expect(out[0]).toBeCloseTo(0.5, 5)
    expect(out[15999]).toBeCloseTo(0.5, 5)
  })

  it("averages within each block (44.1kHz → 16kHz)", () => {
    const input = new Float32Array(44100)
    for (let i = 0; i < input.length; i++) input[i] = i // ramp
    const out = downsampleTo16kMono(input, 44100)
    expect(out.length).toBe(Math.floor(44100 / (44100 / 16000)))
    // Monotonic non-decreasing (a downsampled ramp).
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1])
  })

  it("same rate → a copy (not the same reference)", () => {
    const input = new Float32Array([0.1, 0.2, 0.3])
    const out = downsampleTo16kMono(input, 16000)
    // Compare Float32-rounded to Float32-rounded (both went through the same precision).
    expect(Array.from(out)).toEqual(Array.from(input))
    expect(out).not.toBe(input)
  })

  it("upsampling is refused (returns a copy unchanged)", () => {
    const input = new Float32Array([1, 2, 3])
    const out = downsampleTo16kMono(input, 8000)
    expect(Array.from(out)).toEqual([1, 2, 3])
  })

  it("empty → empty", () => {
    expect(downsampleTo16kMono(new Float32Array(0), 48000).length).toBe(0)
  })
})

describe("audioCapture — formatElapsed", () => {
  it("formats M:SS", () => {
    expect(formatElapsed(0)).toBe("0:00")
    expect(formatElapsed(5)).toBe("0:05")
    expect(formatElapsed(65)).toBe("1:05")
    expect(formatElapsed(600)).toBe("10:00")
  })
  it("clamps negatives", () => {
    expect(formatElapsed(-3)).toBe("0:00")
  })
})
