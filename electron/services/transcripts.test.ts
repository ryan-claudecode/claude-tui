import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { TranscriptAssigner } from "./transcripts"
import { encodeProjectDir } from "./terminals"

/** Make a fresh fake ~/.claude/projects root and the encoded dir for `cwd`. */
function fakeRoot(cwd: string): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "cc-assign-"))
  const dir = join(root, encodeProjectDir(cwd))
  mkdirSync(dir, { recursive: true })
  return { root, dir }
}

/** Write a transcript `.jsonl` with an explicit mtime (epoch ms). */
function writeTranscript(dir: string, id: string, mtimeMs: number): void {
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, "{}")
  const secs = mtimeMs / 1000
  utimesSync(file, secs, secs)
}

describe("TranscriptAssigner", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("assigns two same-cwd transcripts to two terminals in spawn order", () => {
    const cwd = "C:\\fake\\parallel"
    const { root, dir } = fakeRoot(cwd)
    const claimed = new Set<string>()
    const assigned: Array<{ tid: string; cid: string }> = []
    const assigner = new TranscriptAssigner(root, claimed, (tid, cid) =>
      assigned.push({ tid, cid }),
    )

    const t0 = Date.now()
    // Terminal A spawns first, then B — both in the same cwd.
    assigner.expect({ terminalId: "A", cwd, spawnedAt: t0 })
    assigner.expect({ terminalId: "B", cwd, spawnedAt: t0 + 10 })

    // Two transcripts appear in order: the older mtime is A's, newer is B's.
    writeTranscript(dir, "convo-A", t0 + 1000)
    writeTranscript(dir, "convo-B", t0 + 2000)

    vi.advanceTimersByTime(1000) // one poll tick

    expect(assigned).toEqual([
      { tid: "A", cid: "convo-A" },
      { tid: "B", cid: "convo-B" },
    ])
    expect(claimed.has("convo-A")).toBe(true)
    expect(claimed.has("convo-B")).toBe(true)
    // Both bound → loop idles, nothing pending.
    expect(assigner.pendingCount()).toBe(0)
    expect(assigner.isRunning()).toBe(false)
  })

  it("assigns a transcript that appears 45s after spawn (no give-up)", () => {
    const cwd = "C:\\fake\\slowboot"
    const { root, dir } = fakeRoot(cwd)
    const claimed = new Set<string>()
    const assigned: Array<{ tid: string; cid: string }> = []
    const assigner = new TranscriptAssigner(root, claimed, (tid, cid) =>
      assigned.push({ tid, cid }),
    )

    const t0 = Date.now()
    assigner.expect({ terminalId: "slow", cwd, spawnedAt: t0 })

    // Nothing for 45s — the old design would have given up at 30s.
    vi.advanceTimersByTime(45_000)
    expect(assigned).toEqual([])
    expect(assigner.pendingCount()).toBe(1)
    expect(assigner.isRunning()).toBe(true)

    // Transcript finally lands at t0+45s.
    writeTranscript(dir, "late-convo", t0 + 45_000)
    vi.advanceTimersByTime(1000)

    expect(assigned).toEqual([{ tid: "slow", cid: "late-convo" }])
    expect(assigner.isRunning()).toBe(false)
  })

  it("never assigns a baseline transcript or one already claimed", () => {
    const cwd = "C:\\fake\\baseline"
    const { root, dir } = fakeRoot(cwd)

    const t0 = Date.now()
    // A sibling's transcript already exists when our terminal registers.
    writeTranscript(dir, "sibling-baseline", t0 - 5000)
    // A second transcript exists too, but it's been claimed process-wide.
    writeTranscript(dir, "already-claimed", t0 + 500)
    const claimed = new Set<string>(["already-claimed"])

    const assigned: Array<{ tid: string; cid: string }> = []
    const assigner = new TranscriptAssigner(root, claimed, (tid, cid) =>
      assigned.push({ tid, cid }),
    )

    // Registering snapshots the dir's baseline (includes sibling AND claimed file).
    assigner.expect({ terminalId: "X", cwd, spawnedAt: t0 })

    // Even if the sibling transcript keeps getting written (newest mtime), it's
    // in the baseline; the claimed one is excluded too — nothing is assigned.
    writeTranscript(dir, "sibling-baseline", t0 + 9000)
    vi.advanceTimersByTime(5000)
    expect(assigned).toEqual([])
    expect(assigner.pendingCount()).toBe(1)

    // OUR transcript appears (not baseline, not claimed) — now we bind.
    writeTranscript(dir, "our-convo", t0 + 6000)
    vi.advanceTimersByTime(1000)
    expect(assigned).toEqual([{ tid: "X", cid: "our-convo" }])
  })

  it("cancelling an expectation stops assignment and idles the loop", () => {
    const cwd = "C:\\fake\\cancel"
    const { root, dir } = fakeRoot(cwd)
    const claimed = new Set<string>()
    const assigned: Array<{ tid: string; cid: string }> = []
    const assigner = new TranscriptAssigner(root, claimed, (tid, cid) =>
      assigned.push({ tid, cid }),
    )

    const t0 = Date.now()
    assigner.expect({ terminalId: "doomed", cwd, spawnedAt: t0 })
    expect(assigner.isRunning()).toBe(true)

    // Terminal is killed before its transcript appears.
    assigner.cancel("doomed")
    expect(assigner.pendingCount()).toBe(0)
    expect(assigner.isRunning()).toBe(false)

    // A transcript shows up afterward — nobody is waiting, so nothing binds.
    writeTranscript(dir, "orphan-convo", t0 + 2000)
    vi.advanceTimersByTime(5000)
    expect(assigned).toEqual([])
    expect(claimed.has("orphan-convo")).toBe(false)
  })

  it("does not assign a transcript older than the expectation's spawnedAt", () => {
    const cwd = "C:\\fake\\skew"
    const { root, dir } = fakeRoot(cwd)
    const claimed = new Set<string>()
    const assigned: Array<{ tid: string; cid: string }> = []
    const assigner = new TranscriptAssigner(root, claimed, (tid, cid) =>
      assigned.push({ tid, cid }),
    )

    const t0 = Date.now()
    // A NEW (non-baseline) transcript whose mtime predates the spawn by more than
    // the skew tolerance — belongs to an earlier boot, must not be assigned.
    assigner.expect({ terminalId: "Y", cwd, spawnedAt: t0 })
    writeTranscript(dir, "too-old", t0 - 10_000)
    vi.advanceTimersByTime(3000)
    expect(assigned).toEqual([])
    expect(assigner.pendingCount()).toBe(1)
  })

  it("idles when no expectations are pending (no timer on construction)", () => {
    const { root } = fakeRoot("C:\\fake\\empty")
    const assigner = new TranscriptAssigner(root, new Set(), () => {})
    expect(assigner.isRunning()).toBe(false)
    expect(assigner.pendingCount()).toBe(0)
  })
})
