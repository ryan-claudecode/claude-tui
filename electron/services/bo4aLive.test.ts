/**
 * BO-4a — LIVE end-to-end verification against a REAL `claude -p`.
 *
 * This is the acceptance harness: it wires the REAL TerminalService + the REAL
 * MCP server exactly like ipc.ts, flips the structured engine ON, spawns a
 * from-scratch headless session, and drives the whole BO-1→BO-2→BO-3 chain that
 * has never run together live: spawn → stream → composer input → the approve_tool
 * permission round-trip (allow + deny) → idle/attention.
 *
 * HERMETICITY: gated behind `describe.runIf(BO4A_LIVE)`. Under the normal
 * `npm test` (no env var) the whole suite is SKIPPED — no real claude, no MCP
 * server, no spawns. Run it deliberately with:
 *
 *   BO4A_LIVE=1 npx vitest run electron/services/bo4aLive.test.ts
 *
 * (PowerShell: `$env:BO4A_LIVE=1; npx vitest run electron/services/bo4aLive.test.ts`)
 *
 * It manages ONLY the claude processes it spawns (svc.killAll in afterAll) and
 * closes its own MCP http server — it never touches the user's own sessions.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, existsSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { Server } from "http"
import { TerminalService, type TerminalEvent } from "./terminals"
import { AttentionService, type AttentionDeps } from "./attention"
import { startMcpServer } from "../mcp/server"
import { agentMessageFromInput, type StreamEvent } from "./streamProtocol"

const LIVE = process.env.BO4A_LIVE === "1"

/** A throwaway service with a no-op `onEvent` — enough to satisfy startMcpServer
 *  and AttentionService wiring for tool groups this harness never exercises. */
const stub = () => new Proxy({}, { get: () => () => undefined }) as never

/** Poll until `predicate()` is truthy or `timeoutMs` elapses. */
async function waitFor<T>(predicate: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const v = predicate()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${label}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe.runIf(LIVE)("BO-4a LIVE end-to-end (real claude -p) — gated by BO4A_LIVE=1", () => {
  let svc: TerminalService
  let attention: AttentionService
  let http: Server | undefined
  let cwd: string
  const streamEvents: StreamEvent[] = []
  const stateEvents: Extract<TerminalEvent, { type: "state" }>[] = []
  const permissionPushes: Array<{ id: string; toolName: string; terminalId?: string }> = []

  beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), "bo4a-live-"))
    svc = new TerminalService()

    // Capture renderer pushes (permission:request) without a real BrowserWindow.
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

    // Observe the structured stream + idle/active transitions on the onEvent seam.
    svc.onEvent((e) => {
      if (e.type === "stream") streamEvents.push(e.event)
      else if (e.type === "state") stateEvents.push(e)
    })

    // A REAL AttentionService over the real TerminalService (the rest stubbed).
    const deps: AttentionDeps = {
      sendToRenderer: () => {},
      sessionOf: () => "live-sess-1",
      isWindowFocused: () => false,
      osNotificationsEnabled: () => false,
      notify: () => {},
    }
    attention = new AttentionService(stub(), svc, stub(), stub(), deps)

    // The REAL MCP server — its approve_tool gate is what makes the permission
    // round-trip live. Only sessionService (svc, position 1) + attentionService
    // (position 19) are real; positions 2-18 + 20 are stubs never invoked by this
    // harness's prompts. (20 args total — CAPP-86 added recallService before
    // attention; CAPP-87 added workspaceMemoryService after; see startMcpServer.)
    const started = await startMcpServer(
      svc,
      stub(), stub(), stub(), stub(), stub(), stub(), stub(), stub(), // 2-9
      stub(), stub(), stub(), stub(), stub(), stub(), stub(), stub(), // 10-17
      stub(), // 18 recallService
      attention, // 19
      stub(), // 20 workspaceMemoryService (CAPP-87)
      stub(), // 21 contextInspectorService (CAPP-98)
      stub(), // 22 exportService (CAPP-99)
      stub(), // 23 schedulerService (CAPP-114)
      stub(), // 24 actionButtonService (CAPP-104)
    )
    svc.setMcpConfigPath(started.configPath)
    svc.setMcpServerUrl(`http://127.0.0.1:${started.port}/sse`)
    http = (started as unknown as { httpServer?: Server }).httpServer

    // FLIP THE ENGINE ON.
    svc.setEngine("structured")
  }, 60_000)

  afterAll(async () => {
    try { svc?.killAll() } catch { /* ignore */ }
    try { http?.close() } catch { /* ignore */ }
  })

  it("(a) spawns a headless claude -p and (b) streams init + assistant text + result", async () => {
    const info = svc.create(undefined, cwd, "live-sess-1")
    expect(svc.isHeadless(info.id)).toBe(true)

    // (c) composer input reaches the agent via the structured stdin sink. NOTE:
    // `claude -p --input-format stream-json` begins its turn (and emits the
    // `init`/system event) only once it receives the FIRST stdin message — so we
    // send input first, then observe the boot + stream that the turn produces.
    svc.sendAgentMessage(
      info.id,
      agentMessageFromInput({ text: "Reply with exactly the single word: READY. Do not use any tools." }),
    )

    // (a) headless boot → an init event once the turn starts. The first cold
    // `claude -p` boot (binary load + MCP SSE handshake) can take a while.
    await waitFor(() => streamEvents.find((e) => e.kind === "init"), 150_000, "init event")

    // (b) live assistant streaming + a turn result with cost.
    const result = await waitFor(
      () => streamEvents.find((e) => e.kind === "result"),
      120_000,
      "result event",
    ) as Extract<StreamEvent, { kind: "result" }>
    expect(result.isError).toBe(false)
    const text = streamEvents
      .filter((e) => e.kind === "assistant_delta")
      .map((e) => (e as Extract<StreamEvent, { kind: "assistant_delta" }>).text)
      .join("")
    expect(text.toUpperCase()).toContain("READY")

    // (e) idle/attention: the turn parked idle on the structured seam.
    expect(stateEvents.some((e) => e.state === "idle")).toBe(true)

    console.log("[BO-4a LIVE] stream kinds:", streamEvents.map((e) => e.kind).join(","))
    console.log("[BO-4a LIVE] turn cost:", JSON.stringify((result as { raw?: unknown }).raw))
  }, 360_000)

  it("(d) a REAL permission prompt: ALLOW runs the tool, DENY blocks it", async () => {
    const info = svc.create(undefined, cwd, "live-sess-1")
    expect(svc.isHeadless(info.id)).toBe(true)

    // --- ALLOW: ask the agent to Write a file; approve the gate; the file lands.
    const allowFile = join(cwd, "allowed.txt")
    permissionPushes.length = 0
    svc.sendAgentMessage(
      info.id,
      agentMessageFromInput({
        text: `Use the Write tool to create a file at ${allowFile.replace(/\\/g, "/")} whose entire content is the word READY. Then stop.`,
      }),
    )
    const allowReq = await waitFor(
      () => permissionPushes.find((p) => p.terminalId === info.id && /write/i.test(p.toolName)),
      120_000,
      "Write permission request (allow)",
    )
    // A tier-2 "asked" surfaced while the gate is pending (idle path or active path).
    expect(attention.list().some((e) => e.kind === "asked" && e.terminalId === info.id)).toBe(true)
    svc.resolvePermission(allowReq.id, { id: allowReq.id, behavior: "allow", alwaysAllow: true })
    await waitFor(() => (existsSync(allowFile) ? true : undefined), 60_000, "allowed.txt written")
    expect(readFileSync(allowFile, "utf8").toUpperCase()).toContain("READY")

    // Always-allow persisted + the gitignore was dropped (punch-list b).
    const settings = join(cwd, ".claude", "settings.local.json")
    expect(existsSync(settings)).toBe(true)
    expect(JSON.parse(readFileSync(settings, "utf8")).permissions.allow).toContain("Write")
    expect(existsSync(join(cwd, ".claude", ".gitignore"))).toBe(true)

    console.log("[BO-4a LIVE] allow round-trip OK; settings:", readFileSync(settings, "utf8"))

    // --- DENY: a fresh terminal (so the always-allow rule from above doesn't apply
    // to a different tool). Deny a Bash command; it must NOT run.
    const info2 = svc.create(undefined, cwd, "live-sess-1")
    const denyMarker = join(cwd, "denied-ran.txt")
    permissionPushes.length = 0
    svc.sendAgentMessage(
      info2.id,
      agentMessageFromInput({
        text: `Use the Bash tool to run: echo NO > "${denyMarker.replace(/\\/g, "/")}". Then stop.`,
      }),
    )
    const denyReq = await waitFor(
      () => permissionPushes.find((p) => p.terminalId === info2.id),
      120_000,
      "Bash permission request (deny)",
    )
    svc.resolvePermission(denyReq.id, { id: denyReq.id, behavior: "deny", message: "blocked by live test" })
    // Give the agent a moment to receive the deny and wind down.
    await new Promise((r) => setTimeout(r, 4000))
    expect(existsSync(denyMarker)).toBe(false)

    console.log("[BO-4a LIVE] deny round-trip OK; denied command did not run")
  }, 300_000)
})
