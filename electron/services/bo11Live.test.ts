/**
 * BO-11 (CAPP-50) — LIVE end-to-end verification that STOP TRULY STOPS, against a
 * REAL `claude -p`. This is the canonical assertion the BO-10 test was MISSING.
 *
 * The hazard: a turn parked on a tool permission, when killed, leaves a HALF-OPEN
 * tool_use in the on-disk transcript. A bare kill+`--resume` then lets Claude
 * RE-ATTEMPT that tool the next time the resumed proc is booted by a user message —
 * an unwanted file write with no instruction. STEP-1 experimentation
 * (docs/spikes/bo11-stop-abort.md) proved two things that shape this test:
 *
 *   1. Headless `claude -p` (stream-json input) is DORMANT until it receives stdin,
 *      so the "no-input quiescent" state is trivially quiet — the re-attempt can only
 *      surface when the NEXT message boots the resumed proc. A test that asserts only
 *      the dormant window (as BO-10's did) MASKS the bug.
 *   2. The fix — interruptAgent settling the parked permission as an abort DENY
 *      THROUGH the live proc and draining to `result` BEFORE killing — closes the
 *      turn on disk, so the resume is clean.
 *
 * So this test STOPs a permission-parked turn, then sends a NEUTRAL (non-redirecting)
 * follow-up that DOES boot the resumed proc, and asserts the aborted Write is STILL
 * absent — i.e. it was dropped, not replayed — while the conversation survives.
 *
 * HERMETIC by default: gated behind `describe.runIf(BO11_LIVE)`. `npm test` (no env
 * var) SKIPS it — no real claude, no MCP server, no spawns. Run deliberately with:
 *
 *   $env:BO11_LIVE=1; npx vitest run electron/services/bo11Live.test.ts
 *
 * It manages only the claude processes it spawns (killAll in afterAll), closes its
 * own MCP http server, and persists to a TEMP dir — never the user's own sessions.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { Server } from "http"
import { TerminalService, type TerminalEvent } from "./terminals"
import { SessionService } from "./sessions"
import { AttentionService, type AttentionDeps } from "./attention"
import { startMcpServer } from "../mcp/server"
import { agentMessageFromInput, type StreamEvent } from "./streamProtocol"

const LIVE = process.env.BO11_LIVE === "1"

const stub = () => new Proxy({}, { get: () => () => undefined }) as never
const noopWin = { isDestroyed: () => false, webContents: { send: () => {} } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(predicate: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const v = predicate()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${label}`)
    await sleep(150)
  }
}

describe.runIf(LIVE)("BO-11 LIVE — Stop truly stops (real claude -p), gated by BO11_LIVE=1", () => {
  let svc: TerminalService
  let work: SessionService
  let attention: AttentionService
  let http: Server | undefined
  const streamByTerminal = new Map<string, StreamEvent[]>()
  const permissionPushes: Array<{ id: string; toolName: string; terminalId?: string }> = []
  const events = (id: string) => streamByTerminal.get(id) ?? []
  const deltas = (id: string) =>
    events(id)
      .filter((e) => e.kind === "assistant_delta")
      .map((e) => (e as Extract<StreamEvent, { kind: "assistant_delta" }>).text)
      .join("")

  beforeAll(async () => {
    svc = new TerminalService()
    work = new SessionService({ dir: mkdtempSync(join(tmpdir(), "bo11-sessions-")) })
    work.attachTerminals(svc)
    work.setMainWindow(noopWin as never)
    ;(svc as unknown as { mainWin: unknown }).mainWin = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, ...args: unknown[]) => {
          if (channel === "permission:request") {
            permissionPushes.push(args[0] as { id: string; toolName: string; terminalId?: string })
          }
        },
      },
    }
    svc.onEvent((e: TerminalEvent) => {
      if (e.type === "stream") {
        const arr = streamByTerminal.get(e.id) ?? []
        arr.push(e.event)
        streamByTerminal.set(e.id, arr)
      }
    })
    const deps: AttentionDeps = {
      sendToRenderer: () => {},
      sessionOf: (id) => work.sessionIdOf(id) ?? "live-sess",
      isWindowFocused: () => false,
      osNotificationsEnabled: () => false,
      notify: () => {},
    }
    attention = new AttentionService(stub(), svc, stub(), stub(), deps)
    const started = await startMcpServer(
      svc,
      stub(), stub(), stub(), stub(), stub(), stub(), stub(), stub(),
      stub(), stub(), stub(), stub(), stub(), stub(), stub(), stub(),
      attention,
    )
    svc.setMcpConfigPath(started.configPath)
    svc.setMcpServerUrl(`http://127.0.0.1:${started.port}/sse`)
    http = (started as unknown as { httpServer?: Server }).httpServer
    svc.setEngine("structured")
  }, 60_000)

  afterAll(async () => {
    try { svc?.killAll() } catch { /* ignore */ }
    try { http?.close() } catch { /* ignore */ }
  })

  it("STOP on a permission-parked turn does NOT re-attempt the Write on the next neutral turn", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bo11-live-"))
    const marker = join(cwd, "should-not-exist.txt")
    const markerArg = marker.replace(/\\/g, "/")
    const { session, terminalId } = work.openSession(cwd)
    expect(svc.isHeadless(terminalId)).toBe(true)

    // turn 1 — establish a memory anchor + let the convo id capture.
    svc.sendAgentMessage(
      terminalId,
      agentMessageFromInput({ text: "Please remember this number for the rest of our conversation: 42. Reply with just: noted." }),
    )
    await waitFor(() => events(terminalId).find((e) => e.kind === "result"), 180_000, "turn 1 result")
    const cc = await waitFor(
      () => work.get(session.id)?.terminals.find((t) => t.id === terminalId)?.ccConversationId,
      60_000,
      "ccConversationId captured",
    )
    expect(cc).toBeTruthy()

    // turn 2 — trigger a Write permission → the agent PARKS on the gate.
    permissionPushes.length = 0
    svc.sendAgentMessage(
      terminalId,
      agentMessageFromInput({ text: `Use the Write tool to create a file at ${markerArg} whose entire content is the word READY. Then stop.` }),
    )
    await waitFor(() => permissionPushes.find((p) => p.terminalId === terminalId), 150_000, "parked Write permission")
    expect(attention.list().some((e) => e.kind === "asked" && e.terminalId === terminalId)).toBe(true)

    // THE STOP — interruptAgent closes the parked turn THROUGH the live proc
    // (abort-drain) before killing + resuming. A fresh terminal id is minted.
    const r = await work.interruptAgent(terminalId)
    expect(r?.terminalId).toBeTruthy()
    expect(r!.terminalId).not.toBe(terminalId)
    const newId = r!.terminalId
    expect(svc.isHeadless(terminalId)).toBe(false)

    // MECHANISM assertion (race-independent): the abort-drain denied the parked Write
    // THROUGH the live proc and let the turn wind down, so the OLD terminal's captured
    // stream must carry a `tool_result` (the deny landed as the Write's result — turn 1
    // had no tool, so this can only be the denied Write) AND a 2nd `result` (turn 2
    // closed). The bare kill+resume path (the bug) kills before the proc emits either,
    // so this goes RED if the abort-drain is reverted — unlike the file check, which the
    // kill-time-deny race can mask. See docs/spikes/bo11-stop-abort.md EXP-A.
    const oldEvents = events(terminalId)
    expect(oldEvents.filter((e) => e.kind === "tool_result").length).toBeGreaterThanOrEqual(1)
    expect(oldEvents.filter((e) => e.kind === "result").length).toBeGreaterThanOrEqual(2)

    // dormant window: nothing has booted the resumed proc yet, so the file is absent…
    await sleep(2000)
    expect(existsSync(marker)).toBe(false)

    // …now the DECISIVE step: a NEUTRAL (non-redirecting) follow-up that BOOTS the
    // resumed proc on the (now-closed) transcript. With the bug this is where the
    // half-open Write would replay; with the fix it must NOT. Plain "what is 2+2?" with
    // NO "don't use tools" rider — that rider could suppress a replay for the wrong
    // reason (the model refusing tools), masking a real regression.
    permissionPushes.length = 0
    svc.sendAgentMessage(
      newId,
      agentMessageFromInput({ text: "What is 2 plus 2? Reply with just the number." }),
    )
    await waitFor(() => events(newId).find((e) => e.kind === "result"), 180_000, "neutral turn result")
    await sleep(2000)

    const reGatedWrite = permissionPushes.some((p) => p.terminalId === newId && p.toolName === "Write")
    const answer = deltas(newId).trim()
    // eslint-disable-next-line no-console
    console.log(`[BO-11 LIVE] after Stop + neutral turn — file: ${existsSync(marker)} | Write re-gated: ${reGatedWrite} | answer: ${answer.slice(0, 80)}`)

    // THE CORE ACCEPTANCE ASSERTION: the aborted Write was DROPPED, not replayed.
    expect(existsSync(marker)).toBe(false)
    // It also wasn't merely re-gated (parked on a new Write permission) — truly gone.
    expect(reGatedWrite).toBe(false)
    // The resumed conversation is healthy: it answered the neutral question.
    expect(answer).toContain("4")

    // And the conversation survived the Stop end-to-end: recall the anchor. No
    // "don't use tools" rider here either — the final file-absent guard below must not
    // be masked by a tool-refusal.
    svc.sendAgentMessage(
      newId,
      agentMessageFromInput({ text: "What number did I ask you to remember earlier? Reply with just the number." }),
    )
    const beforeRecall = events(newId).filter((e) => e.kind === "result").length
    await waitFor(() => events(newId).filter((e) => e.kind === "result").length > beforeRecall, 180_000, "recall result")
    expect(deltas(newId)).toContain("42")
    // Final guard: still no file after the whole exchange.
    expect(existsSync(marker)).toBe(false)
  }, 600_000)
})
