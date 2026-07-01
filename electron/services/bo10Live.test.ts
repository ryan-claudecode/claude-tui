/**
 * BO-10 — LIVE end-to-end verification of the STOP / INTERRUPT handbrake against a
 * REAL `claude -p`. Wires the real TerminalService + real SessionService (the
 * durable container that owns interruptAgent) + the real MCP server (whose
 * approve_tool gate makes the permission round-trip live), flips the structured
 * engine ON, then proves the dogfooding bug is fixed:
 *
 *   turn 1 (no tools)  → establish a memory anchor + let the convo id get captured
 *   turn 2 (Write)     → the agent PARKS on a real permission prompt (the hang)
 *   interruptAgent()   → kill the proc (denying the parked permission) + RESPAWN
 *                        the SAME conversation via --resume (a NEW terminal id)
 *   turn 3 (recall)    → the resumed agent still remembers turn 1 ⇒ the
 *                        conversation survived, only the aborted turn was dropped
 *
 * HERMETICITY: gated behind `describe.runIf(BO10_LIVE)`. Under the normal
 * `npm test` (no env var) the whole suite is SKIPPED — no real claude, no MCP
 * server, no spawns. Run it deliberately with:
 *
 *   BO10_LIVE=1 npx vitest run electron/services/bo10Live.test.ts
 *
 * (PowerShell: `$env:BO10_LIVE=1; npx vitest run electron/services/bo10Live.test.ts`)
 *
 * It manages ONLY the claude processes it spawns (killAll in afterAll), closes its
 * own MCP http server, and persists session files to a TEMP dir — it never touches
 * the user's own sessions.
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

const LIVE = process.env.BO10_LIVE === "1"

const stub = () => new Proxy({}, { get: () => () => undefined }) as never
const noopWin = { isDestroyed: () => false, webContents: { send: () => {} } }

async function waitFor<T>(predicate: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const v = predicate()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${label}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

describe.runIf(LIVE)("BO-10 LIVE interrupt (real claude -p) — gated by BO10_LIVE=1", () => {
  let svc: TerminalService
  let work: SessionService
  let attention: AttentionService
  let http: Server | undefined
  let cwd: string
  const streamByTerminal = new Map<string, StreamEvent[]>()
  const permissionPushes: Array<{ id: string; toolName: string; terminalId?: string }> = []
  const exits: string[] = []
  const kinds = (id: string) => (streamByTerminal.get(id) ?? []).map((e) => e.kind).join(",")

  beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), "bo10-live-"))
    svc = new TerminalService()
    work = new SessionService({ dir: mkdtempSync(join(tmpdir(), "bo10-sessions-")) })
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
      } else if (e.type === "exit") {
        exits.push(e.id)
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
      stub(), stub(), stub(), stub(), stub(), stub(), stub(), stub(), // 2-9
      stub(), stub(), stub(), stub(), stub(), stub(), stub(), stub(), // 10-17
      stub(), // 18 recallService (CAPP-86)
      attention, // 19
      stub(), // 20 workspaceMemoryService (CAPP-87)
      stub(), // 21 contextInspectorService (CAPP-98)
      stub(), // 22 exportService (CAPP-99)
      stub(), // 23 schedulerService (CAPP-114)
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

  it("kill → respawn → resume: a parked permission is stopped and the conversation survives", async () => {
    const { session, terminalId } = work.openSession(cwd)
    expect(svc.isHeadless(terminalId)).toBe(true)

    // --- turn 1: establish a memory anchor + let the convo id capture. NOTE: no
    // "don't use tools" instruction here — it persists into turn 2's context and
    // makes the agent deliberate instead of calling the Write tool (observed live).
    svc.sendAgentMessage(
      terminalId,
      agentMessageFromInput({
        text: "Please remember this number for the rest of our conversation: 42. Reply with just: noted.",
      }),
    )
    await waitFor(
      () => streamByTerminal.get(terminalId)?.find((e) => e.kind === "result"),
      180_000,
      "turn 1 result",
    )
    console.log("[BO-10 LIVE] turn 1 kinds:", kinds(terminalId), "| exits:", exits.join(","))
    // The transcript assigner should have bound a convo id onto the durable ref —
    // that's what the interrupt respawn --resumes.
    const cc = await waitFor(
      () => work.get(session.id)?.terminals.find((t) => t.id === terminalId)?.ccConversationId,
      60_000,
      "ccConversationId captured",
    )
    expect(cc).toBeTruthy()
    expect(svc.isHeadless(terminalId)).toBe(true) // proc still alive for a 2nd turn

    // --- turn 2: trigger a Write permission → the agent PARKS on the gate (the
    // hang). bo4aLive proved this exact phrasing reliably hits the approve_tool gate.
    const marker = join(cwd, "should-not-exist.txt").replace(/\\/g, "/")
    permissionPushes.length = 0
    const beforeTurn2 = (streamByTerminal.get(terminalId) ?? []).length
    svc.sendAgentMessage(
      terminalId,
      agentMessageFromInput({
        text: `Use the Write tool to create a file at ${marker} whose entire content is the word READY. Then stop.`,
      }),
    )
    let req: { id: string; toolName: string; terminalId?: string }
    try {
      req = await waitFor(
        () => permissionPushes.find((p) => p.terminalId === terminalId),
        150_000,
        "permission request (the parked hang)",
      )
    } catch (err) {
      console.log(
        "[BO-10 LIVE] turn 2 produced NO permission. kinds since send:",
        (streamByTerminal.get(terminalId) ?? []).slice(beforeTurn2).map((e) => e.kind).join(","),
        "| exits:",
        exits.join(","),
        "| pushes:",
        JSON.stringify(permissionPushes),
      )
      throw err
    }
    expect(req).toBeTruthy()
    // A tier-2 asked surfaced while the gate blocks.
    expect(attention.list().some((e) => e.kind === "asked" && e.terminalId === terminalId)).toBe(true)

    // --- THE INTERRUPT: stop the parked turn. BO-11 — interruptAgent now closes the
    // parked turn THROUGH the live proc (abort-drain) before killing + respawning the
    // SAME convo, so the resumed transcript has no half-open tool_use to replay.
    const r = await work.interruptAgent(terminalId)
    expect(r?.terminalId).toBeTruthy()
    expect(r!.terminalId).not.toBe(terminalId) // a fresh terminal id was minted
    const newId = r!.terminalId
    // The old proc is gone; the parked Write never ran.
    expect(svc.isHeadless(terminalId)).toBe(false)
    await new Promise((res) => setTimeout(res, 3000))
    expect(existsSync(join(cwd, "should-not-exist.txt"))).toBe(false)

    // --- turn 3: recall on the RESUMED terminal. If --resume worked, the agent
    // still remembers 42 from turn 1 — the conversation survived the interrupt.
    svc.sendAgentMessage(
      newId,
      agentMessageFromInput({
        text: "What number did I ask you to remember earlier? Reply with just the number. Do not use any tools.",
      }),
    )
    await waitFor(
      () => streamByTerminal.get(newId)?.find((e) => e.kind === "result"),
      180_000,
      "turn 3 result (resumed terminal)",
    )
    const recall = (streamByTerminal.get(newId) ?? [])
      .filter((e) => e.kind === "assistant_delta")
      .map((e) => (e as Extract<StreamEvent, { kind: "assistant_delta" }>).text)
      .join("")
    expect(recall).toContain("42")

    // BO-11 (CAPP-50) — close the masking gap: the original BO-10 test only checked
    // the file in the DORMANT window (before turn 3). But headless `claude -p` is
    // dormant until it gets stdin, so that check is trivially true regardless of the
    // bug. The aborted Write would only be re-attempted when the NEXT message boots
    // the resumed proc on a half-open transcript — i.e. DURING turn 3. So re-assert
    // the file is STILL ABSENT after turn 3 wound down: this is the real proof that
    // the aborted action was dropped, not replayed.
    expect(existsSync(join(cwd, "should-not-exist.txt"))).toBe(false)

    console.log("[BO-10 LIVE] interrupt OK — old:", terminalId, "→ new:", newId, "| recall:", recall.trim())
  }, 600_000)
})
