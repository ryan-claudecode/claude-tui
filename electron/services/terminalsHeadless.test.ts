import { describe, it, expect, vi } from "vitest"
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  TerminalService,
  encodeProjectDir,
  parseActivityLine,
  projectStreamEvent,
  addAllowRule,
  type ProcLike,
  type SpawnProc,
  type SpawnProcOptions,
  type PtyLike,
  type SpawnPty,
  type SpawnPtyOptions,
  type TerminalEvent,
} from "./terminals"
import { AttentionService, type AttentionDeps } from "./attention"
import type { PanelService } from "./panels"
import type { NotificationService } from "./notifications"
import type { MissionService } from "./mission"
import { HEADLESS_FLAGS, DEFAULT_MODEL, EFFORT_LEVELS, ULTRACODE_SETTINGS, modelSupportsXhigh, PERMISSION_PROMPT_TOOL, userMessage, type StreamEvent } from "./streamProtocol"
import * as fx from "./streamEvents.fixtures"

// Keep the headless stderr warning out of the real log dir.
vi.mock("../log", () => ({ logWarn: vi.fn(), logError: vi.fn() }))

/**
 * A fake headless child process: conforms to `ProcLike` but has NO real process
 * behind it. Records its spawn args + everything written to stdin, and exposes
 * emit* helpers so a test can drive stdout/stderr/exit by hand — the headless
 * analogue of `FakePty`. Guarantees `npm test` never launches a real `claude` on
 * the headless path (P1-6 hermeticity).
 */
class FakeStreamProc implements ProcLike {
  pid = Math.floor(Math.random() * 1_000_000)
  killed = false
  written: string[] = []
  private outCbs: Array<(d: string) => void> = []
  private errCbs: Array<(d: string) => void> = []
  private exitCbs: Array<(e: { code: number | null }) => void> = []
  private spawnErrCbs: Array<(err: Error) => void> = []

  constructor(
    readonly file: string,
    readonly args: string[],
    readonly options: SpawnProcOptions,
  ) {}

  onStdout(cb: (d: string) => void): void {
    this.outCbs.push(cb)
  }
  onStderr(cb: (d: string) => void): void {
    this.errCbs.push(cb)
  }
  onExit(cb: (e: { code: number | null }) => void): void {
    this.exitCbs.push(cb)
  }
  onError(cb: (err: Error) => void): void {
    this.spawnErrCbs.push(cb)
  }
  write(data: string): void {
    this.written.push(data)
  }
  kill(): void {
    this.killed = true
    // NOTE: real child_process.kill() does NOT synchronously emit `exit` — the
    // OS delivers the signal and `exit` fires on a later tick. A test that wants
    // to simulate that follow-up exit calls emitExit() explicitly.
  }

  emitStdout(data: string): void {
    for (const cb of this.outCbs) cb(data)
  }
  emitStderr(data: string): void {
    for (const cb of this.errCbs) cb(data)
  }
  emitExit(code: number | null = 0): void {
    for (const cb of this.exitCbs) cb({ code })
  }
  /** Drive an async spawn failure (e.g. ENOENT for a bad cwd) — fires INSTEAD of
   *  exit, exactly as child_process.spawn does for a process that never started. */
  emitError(err: Error): void {
    for (const cb of this.spawnErrCbs) cb(err)
  }
}

function makeHeadlessService(): { svc: TerminalService; spawned: FakeStreamProc[] } {
  const spawned: FakeStreamProc[] = []
  const spawnProc: SpawnProc = (file, args, options) => {
    const fake = new FakeStreamProc(file, args, options)
    spawned.push(fake)
    return fake
  }
  return { svc: new TerminalService({ spawnProc }), spawned }
}

const collect = (svc: TerminalService): TerminalEvent[] => {
  const events: TerminalEvent[] = []
  svc.onEvent((e) => events.push(e))
  return events
}

describe("createHeadless — spawn args (acceptance: EXACTLY the headless flag set)", () => {
  it("spawns via the injected seam (a FakeStreamProc, never a real process)", () => {
    const { svc, spawned } = makeHeadlessService()
    svc.createHeadless("t", process.cwd())
    expect(spawned).toHaveLength(1)
    // shell-wrapped for PATH resolution on every platform.
    expect(spawned[0].file).toMatch(/powershell\.exe|bash/)
  })

  it("includes EXACTLY the pinned headless flags, in order", () => {
    const { svc, spawned } = makeHeadlessService()
    svc.createHeadless("t", process.cwd())
    const joined = spawned[0].args.join(" ")
    // The whole flag set appears as one contiguous run, in the pinned order.
    expect(joined).toContain(HEADLESS_FLAGS.join(" "))
    // Spot-check each required flag is present.
    for (const flag of ["-p", "--output-format", "stream-json", "--input-format", "--include-partial-messages", "--verbose"]) {
      expect(joined).toContain(flag)
    }
  })

  it("appends identity-bound --mcp-config when a server URL + session id are set", () => {
    const { svc, spawned } = makeHeadlessService()
    svc.setMcpServerUrl("http://127.0.0.1:9999/sse")
    svc.createHeadless("t", process.cwd(), "sess-1")
    expect(spawned[0].args.join(" ")).toContain("--mcp-config")
  })

  it("does NOT add --resume when not resuming", () => {
    const { svc, spawned } = makeHeadlessService()
    svc.createHeadless("t", process.cwd())
    expect(spawned[0].args.join(" ")).not.toContain("--resume")
  })

  // DEV-skip-permissions (RELEASE BLOCKER): the structured permission posture is
  // gated by setSkipApproval, which DEFAULTS to true (skip). The BO-3
  // --permission-prompt-tool gate is PRESERVED but only emitted when skip=false.
  it("DEV-skip default (skip=true): includes --dangerously-skip-permissions, NOT --permission-prompt-tool", () => {
    const { svc, spawned } = makeHeadlessService()
    // Default posture — no setSkipApproval call.
    expect(svc.getSkipApproval()).toBe(true)
    svc.createHeadless("t", process.cwd())
    const joined = spawned[0].args.join(" ")
    expect(joined).toContain("--dangerously-skip-permissions")
    expect(joined).not.toContain("--permission-prompt-tool")
  })

  it("BO-3 posture (skip=false): includes --permission-prompt-tool mcp__claudetui__approve_tool, NOT --dangerously-skip-permissions", () => {
    const { svc, spawned } = makeHeadlessService()
    svc.setSkipApproval(false)
    svc.createHeadless("t", process.cwd())
    // Args are shell-wrapped into a single `-Command` string, so assert on the join.
    const joined = spawned[0].args.join(" ")
    expect(joined).toContain(`--permission-prompt-tool ${PERMISSION_PROMPT_TOOL}`)
    expect(PERMISSION_PROMPT_TOOL).toBe("mcp__claudetui__approve_tool")
    expect(joined).not.toContain("--dangerously-skip-permissions")
  })

  it("BO-3: appends --allowedTools for pre-approved (gate-skipping) tools, bare names only", () => {
    const { svc, spawned } = makeHeadlessService()
    // "Bash(git *)" is NOT shell-safe through the powershell wrapper → filtered out.
    svc.createHeadless("t", process.cwd(), undefined, undefined, ["Read", "Write", "Bash(git *)"])
    const joined = spawned[0].args.join(" ")
    expect(joined).toContain("--allowedTools Read Write")
    expect(joined).not.toContain("Bash(git *)")
  })

  it("BO-3: omits --allowedTools when none are pre-approved", () => {
    const { svc, spawned } = makeHeadlessService()
    svc.createHeadless("t", process.cwd())
    expect(spawned[0].args.join(" ")).not.toContain("--allowedTools")
  })
})

describe("createHeadless — identity wiring preserved", () => {
  const tokenFromConfig = (terminalId: string): string | null => {
    const path = join(tmpdir(), "claudetui", `mcp-config-${terminalId}.json`)
    const cfg = JSON.parse(readFileSync(path, "utf8"))
    return new URL(cfg.mcpServers.claudetui.url).searchParams.get("token")
  }

  it("the --mcp-config URL carries a token resolving to the terminal's own sid/tid", () => {
    const { svc } = makeHeadlessService()
    svc.setMcpServerUrl("http://127.0.0.1:9999/sse")
    const info = svc.createHeadless("t", process.cwd(), "sess-abc")
    const token = tokenFromConfig(info.id)
    expect(token).toBeTruthy()
    expect(svc.resolveIdentityToken(token!)).toEqual({ sessionId: "sess-abc", terminalId: info.id })
    svc.kill(info.id)
    // Killed → token invalidated so a stale config can't resurrect identity.
    expect(svc.resolveIdentityToken(token!)).toBeUndefined()
  })
})

describe("createHeadless — resume wiring preserved", () => {
  it("passes --resume <id> for an existing transcript and emits convo immediately", () => {
    const root = mkdtempSync(join(tmpdir(), "bo1-resume-"))
    const cwd = process.cwd()
    const dir = join(root, encodeProjectDir(cwd))
    mkdirSync(dir, { recursive: true })
    const convId = "resume-headless-1"
    writeFileSync(join(dir, `${convId}.jsonl`), "{}")

    const { svc, spawned } = makeHeadlessService()
    ;(svc as unknown as { ccProjectsRoot: string }).ccProjectsRoot = root
    const convos: string[] = []
    svc.onEvent((e) => {
      if (e.type === "convo") convos.push(e.ccConversationId)
    })

    svc.createHeadless("t", cwd, undefined, convId)
    expect(spawned[0].args.join(" ")).toContain(`--resume ${convId}`)
    expect(convos).toEqual([convId])
  })
})

describe("createHeadless — parses the stream into typed events on the onEvent seam", () => {
  it("attributes each parsed event to its terminal and emits {type:'stream'}", () => {
    const { svc, spawned } = makeHeadlessService()
    const events = collect(svc)
    const info = svc.createHeadless("t", process.cwd())
    const fake = spawned[0]

    // Feed real captured NDJSON lines (init, a text delta, the result).
    fake.emitStdout(`${fx.INIT}\n${fx.ASSISTANT_TEXT_DELTA}\n${fx.RESULT}\n`)

    const stream = events.filter((e) => e.type === "stream") as Extract<TerminalEvent, { type: "stream" }>[]
    expect(stream.map((e) => e.event.kind)).toEqual(["init", "assistant_delta", "result"])
    // Every event is attributed to THIS terminal.
    expect(stream.every((e) => e.id === info.id)).toBe(true)
  })

  it("reassembles an event split across two stdout chunks (line-buffered)", () => {
    const { svc, spawned } = makeHeadlessService()
    const events = collect(svc)
    svc.createHeadless("t", process.cwd())
    const fake = spawned[0]

    const line = fx.ASSISTANT_TEXT_DELTA
    const mid = Math.floor(line.length / 2)
    fake.emitStdout(line.slice(0, mid)) // partial — nothing emitted yet
    expect(events.filter((e) => e.type === "stream")).toHaveLength(0)
    fake.emitStdout(line.slice(mid) + "\n") // completes
    const stream = events.filter((e) => e.type === "stream") as Extract<TerminalEvent, { type: "stream" }>[]
    expect(stream).toHaveLength(1)
    expect(stream[0].event).toEqual({ kind: "assistant_delta", text: "I'll find the echo MCP tool first." })
  })

  it("a garbage line in the stream does not throw or kill the stream", () => {
    const { svc, spawned } = makeHeadlessService()
    const events = collect(svc)
    svc.createHeadless("t", process.cwd())
    const fake = spawned[0]
    expect(() => fake.emitStdout(`garbage {not json\n${fx.RESULT}\n`)).not.toThrow()
    const stream = events.filter((e) => e.type === "stream") as Extract<TerminalEvent, { type: "stream" }>[]
    // garbage dropped, result still parsed.
    expect(stream.map((e) => e.event.kind)).toEqual(["result"])
  })
})

describe("BO-7 — retains the init catalog (slash commands + skills) per terminal", () => {
  it("captures slash_commands + skills off the init line, exposed via getCatalog (live)", () => {
    const { svc, spawned } = makeHeadlessService()
    const info = svc.createHeadless("t", process.cwd())
    // Before init: nothing captured yet.
    expect(svc.getCatalog(info.id)).toBeNull()
    spawned[0].emitStdout(`${fx.INIT}\n`)
    expect(svc.getCatalog(info.id)).toEqual({
      slashCommands: ["apiref-check", "chrome-live"],
      skills: ["apiref-check", "chrome-live"],
      live: true,
    })
  })

  it("CAPP-126: a seedCatalog'd (restored) catalog reports live:false until a live init lands", () => {
    const { svc, spawned } = makeHeadlessService()
    const info = svc.createHeadless("t", process.cwd())
    svc.seedCatalog(info.id, { slashCommands: ["compact"], skills: [] })
    // Seeded from the persisted ref → available immediately, but NOT live.
    expect(svc.getCatalog(info.id)).toEqual({ slashCommands: ["compact"], skills: [], live: false })
    // The first live init replaces the seed AND flips live.
    spawned[0].emitStdout(`${fx.INIT}\n`)
    expect(svc.getCatalog(info.id)).toEqual({
      slashCommands: ["apiref-check", "chrome-live"],
      skills: ["apiref-check", "chrome-live"],
      live: true,
    })
  })

  it("returns null for an unknown / non-headless terminal id", () => {
    const { svc } = makeHeadlessService()
    expect(svc.getCatalog("nope")).toBeNull()
  })
})

describe("createHeadless — needs-auth signal", () => {
  it("emits a typed needs_auth when the process exits WITHOUT an init event AND the stderr reads like auth", () => {
    const { svc, spawned } = makeHeadlessService()
    const events = collect(svc)
    const info = svc.createHeadless("t", process.cwd())
    const fake = spawned[0]
    fake.emitStderr("Invalid API key · Please run /login")
    fake.emitExit(1)

    const stream = events.filter((e) => e.type === "stream") as Extract<TerminalEvent, { type: "stream" }>[]
    const authEvent = stream.find((e) => e.event.kind === "needs_auth")
    expect(authEvent).toBeDefined()
    expect(authEvent!.id).toBe(info.id)
    // exit is also emitted.
    expect(events.some((e) => e.type === "exit" && e.id === info.id)).toBe(true)
  })

  it("CAPP-117: an exit-before-init with a NON-auth stderr (a bad --settings JSON) does NOT classify as needs_auth — it surfaces the real stderr as a plain errored result", () => {
    const { svc, spawned } = makeHeadlessService()
    const events = collect(svc)
    const info = svc.createHeadless("t", process.cwd())
    const fake = spawned[0]
    // The exact line the inline-JSON bug produced. It must NOT be read as "not signed in".
    fake.emitStderr("Error: Invalid JSON provided to --settings")
    fake.emitExit(1)

    const stream = events.filter((e) => e.type === "stream") as Extract<TerminalEvent, { type: "stream" }>[]
    // NOT misclassified as an auth problem…
    expect(stream.some((e) => e.event.kind === "needs_auth")).toBe(false)
    // …and the real stderr self-describes on a plain errored result block.
    const errResult = stream.find(
      (e) => e.event.kind === "result" && (e.event as Extract<StreamEvent, { kind: "result" }>).isError,
    )
    expect(errResult).toBeDefined()
    const ev = errResult!.event as Extract<StreamEvent, { kind: "result" }>
    expect(ev.result).toContain("Error: Invalid JSON provided to --settings")
    expect(events.some((e) => e.type === "exit" && e.id === info.id)).toBe(true)
  })

  it("does NOT emit needs_auth when init WAS seen before exit", () => {
    const { svc, spawned } = makeHeadlessService()
    const events = collect(svc)
    svc.createHeadless("t", process.cwd())
    const fake = spawned[0]
    fake.emitStdout(`${fx.INIT}\n`)
    fake.emitExit(0)
    const stream = events.filter((e) => e.type === "stream") as Extract<TerminalEvent, { type: "stream" }>[]
    expect(stream.some((e) => e.event.kind === "needs_auth")).toBe(false)
  })

  it("does NOT emit needs_auth on an explicit kill before init (a kill is not an auth failure)", () => {
    const { svc, spawned } = makeHeadlessService()
    const events = collect(svc)
    const info = svc.createHeadless("t", process.cwd())
    svc.kill(info.id)
    // Simulate the OS delivering `exit` on a later tick — teardown must be
    // idempotent: no needs_auth, and exactly one exit total.
    spawned[0].emitExit(null)
    const stream = events.filter((e) => e.type === "stream") as Extract<TerminalEvent, { type: "stream" }>[]
    expect(stream.some((e) => e.event.kind === "needs_auth")).toBe(false)
    expect(events.filter((e) => e.type === "exit" && e.id === info.id)).toHaveLength(1)
  })
})

describe("createHeadless — spawn 'error' (bad cwd) degrades gracefully (no main-process crash)", () => {
  it("tears the terminal down (emits exit) and toasts when the spawn emits 'error' instead of 'exit'", () => {
    const spawned: FakeStreamProc[] = []
    const spawnProc: SpawnProc = (file, args, options) => {
      const fake = new FakeStreamProc(file, args, options)
      spawned.push(fake)
      return fake
    }
    const toasts: Array<{ message: string; level: string }> = []
    const svc = new TerminalService({
      spawnProc,
      notify: (message, level) => toasts.push({ message, level }),
    })
    const events = collect(svc)
    const info = svc.createHeadless("t", process.cwd())
    // A bad cwd makes child_process.spawn emit 'error' (ENOENT) and NEVER 'exit'.
    // The handler must not re-throw (which would crash the main process) — instead
    // it routes through teardownHeadless: marks dead + emits exit, plus a toast.
    expect(() => spawned[0].emitError(new Error("spawn ENOENT"))).not.toThrow()
    expect(events.some((e) => e.type === "exit" && e.id === info.id)).toBe(true)
    expect(toasts.some((t) => t.level === "error" && /spawn ENOENT/.test(t.message))).toBe(true)
    // The terminal is gone from the live registry (degraded, not lingering).
    expect(svc.isHeadless(info.id)).toBe(false)
  })

  it("synthAuth=false on a spawn error — a failed spawn is not reported as a needs_auth/login problem", () => {
    const { svc, spawned } = makeHeadlessService()
    const events = collect(svc)
    svc.createHeadless("t", process.cwd())
    spawned[0].emitError(new Error("spawn ENOENT"))
    const stream = events.filter((e) => e.type === "stream") as Extract<TerminalEvent, { type: "stream" }>[]
    // A spawn failure is NOT an auth failure — no needs_auth event.
    expect(stream.some((e) => e.event.kind === "needs_auth")).toBe(false)
  })
})

describe("sendAgentMessage — stdin sink (BO-1 exposes the sink + contract type)", () => {
  it("writes a newline-delimited structured user message to stdin", () => {
    const { svc, spawned } = makeHeadlessService()
    const info = svc.createHeadless("t", process.cwd())
    const ok = svc.sendAgentMessage(info.id, userMessage("hello-bo1"))
    expect(ok).toBe(true)
    expect(spawned[0].written).toHaveLength(1)
    const raw = spawned[0].written[0]
    expect(raw.endsWith("\n")).toBe(true)
    expect(JSON.parse(raw)).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello-bo1" }] },
    })
  })

  it("returns false for an unknown terminal", () => {
    const { svc } = makeHeadlessService()
    expect(svc.sendAgentMessage("nope", userMessage("x"))).toBe(false)
  })

  it("returns false after the terminal is killed (dead)", () => {
    const { svc } = makeHeadlessService()
    const info = svc.createHeadless("t", process.cwd())
    svc.kill(info.id)
    expect(svc.sendAgentMessage(info.id, userMessage("x"))).toBe(false)
  })
})

describe("createHeadless — hermeticity + lifecycle", () => {
  it("killAll tears down headless terminals and clears identity tokens", () => {
    const { svc, spawned } = makeHeadlessService()
    svc.setMcpServerUrl("http://127.0.0.1:9999/sse")
    const info = svc.createHeadless("t", process.cwd(), "sess-1")
    svc.killAll()
    expect(spawned[0].killed).toBe(true)
    expect(svc.sendAgentMessage(info.id, userMessage("x"))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// BO-5 — re-pointing the ANSI consumers onto the structured engine.
// ---------------------------------------------------------------------------

describe("BO-5 projectStreamEvent — plain-text projection of structured events", () => {
  it("projects assistant text, ● tool lines, tool-result + result; skips internals", () => {
    expect(projectStreamEvent({ kind: "assistant_delta", text: "hello" })).toBe("hello")
    expect(projectStreamEvent({ kind: "tool_use", id: "1", name: "Edit", input: { file_path: "src/App.tsx" } }))
      .toBe("\n● Edit(src/App.tsx)\n")
    expect(projectStreamEvent({ kind: "tool_result", toolUseId: "1", content: "ok done" })).toBe("  ⎿ ok done\n")
    expect(projectStreamEvent({ kind: "result", isError: false, result: "final answer", raw: {} })).toBe("\nfinal answer\n")
    // Internal / non-scrollback events are skipped.
    expect(projectStreamEvent({ kind: "thinking_delta", text: "musing" })).toBeNull()
    expect(projectStreamEvent({ kind: "init", raw: {} })).toBeNull()
  })
})

describe("BO-5 search + export — structured events feed the search/export store", () => {
  it("getOutput returns a non-empty plain-text projection and searchOutput finds matches", () => {
    const { svc, spawned } = makeHeadlessService()
    const info = svc.createHeadless("t", process.cwd())
    // Real captured lines: assistant text, a ToolSearch tool_use, its tool_result, the result.
    spawned[0].emitStdout(
      `${fx.INIT}\n${fx.ASSISTANT_TEXT_DELTA}\n${fx.ASSISTANT_TOOL_USE}\n${fx.USER_TOOL_RESULT}\n${fx.RESULT}\n`,
    )

    const out = svc.getOutput(info.id)
    expect(out).not.toBeNull()
    // Assistant prose, the ● tool line, the tool-result summary, and the result text.
    expect(out).toContain("I'll find the echo MCP tool first.")
    expect(out).toContain("● ToolSearch(echo)")
    expect(out).toContain("Monitor") // tool_result content
    expect(out).toContain("hi") // result text

    // History search (service-layer source) returns matches for a structured terminal.
    expect(svc.searchOutput("ToolSearch", info.id).length).toBeGreaterThan(0)
    expect(svc.searchOutput("Monitor", info.id).length).toBeGreaterThan(0)
    expect(svc.searchOutput("nothing-here", info.id)).toEqual([])
  })

  it("getOutput returns '' (not null) for a known structured terminal with no output yet", () => {
    const { svc } = makeHeadlessService()
    const info = svc.createHeadless("t", process.cwd())
    expect(svc.getOutput(info.id)).toBe("")
    expect(svc.getOutput("ghost")).toBeNull()
  })
})

describe("BO-5 activity line — the sidebar fallback parses the projected ● tool line", () => {
  it("a tool_use event lands a parseActivityLine-compatible line in getOutput", () => {
    const { svc, spawned } = makeHeadlessService()
    const info = svc.createHeadless("t", process.cwd())
    spawned[0].emitStdout(`${fx.ASSISTANT_TOOL_USE}\n`)
    const parsed = parseActivityLine(svc.getOutput(info.id) ?? "")
    expect(parsed).toBe("ToolSearch(echo)")
  })
})

/** Wire a REAL TerminalService into AttentionService with throwaway collaborators,
 *  so a structured event drives the real attention classification. */
function makeAttention(svc: TerminalService) {
  const noop = { onEvent: () => () => {} }
  const notif = { onNotification: () => () => {} }
  const missions = { onEvent: () => () => {} }
  const queue: AttentionEntrySnap[][] = []
  const deps: AttentionDeps = {
    sendToRenderer: (channel, ...args) => {
      if (channel === "attention:updated") queue.push(args[0] as AttentionEntrySnap[])
    },
    sessionOf: (id) => `sess-of-${id}`,
    isWindowFocused: () => true,
    osNotificationsEnabled: () => false,
    notify: () => {},
  }
  const attn = new AttentionService(
    noop as unknown as PanelService,
    svc,
    notif as unknown as NotificationService,
    missions as unknown as MissionService,
    deps,
  )
  return attn
}
type AttentionEntrySnap = { kind: string; tier: number; terminalId?: string }

describe("BO-5 attention — typed events drive finished/asked on the existing seam", () => {
  it("a result event (sustained burst) lands a tier-3 'finished' entry", () => {
    const { svc, spawned } = makeHeadlessService()
    const attn = makeAttention(svc)
    const info = svc.createHeadless("t", process.cwd())
    const fake = spawned[0]

    fake.emitStdout(`${fx.INIT}\n`) // booted → idle (tiny burst, no entry)
    fake.emitStdout(`${fx.ASSISTANT_TOOL_USE}\n`) // → active
    // Backdate the active burst past the 10s finished-guardrail (real-time clock).
    ;(svc as unknown as { headless: Map<string, { activeSince?: number }> })
      .headless.get(info.id)!.activeSince = Date.now() - 11_000
    fake.emitStdout(`${fx.RESULT}\n`) // turn done → idle finished

    const finished = attn.list().find((e) => e.kind === "finished" && e.terminalId === info.id)
    expect(finished).toBeDefined()
    expect(finished!.tier).toBe(3)
  })

  it("the BO-3 permission hook (markAwaitingPermission) lands a tier-2 'asked' entry", () => {
    const { svc, spawned } = makeHeadlessService()
    const attn = makeAttention(svc)
    const info = svc.createHeadless("t", process.cwd())
    spawned[0].emitStdout(`${fx.INIT}\n`)
    spawned[0].emitStdout(`${fx.ASSISTANT_TOOL_USE}\n`) // → active mid-turn
    svc.markAwaitingPermission(info.id) // BO-3 hook → idle + promptDetected

    const asked = attn.list().find((e) => e.kind === "asked" && e.terminalId === info.id)
    expect(asked).toBeDefined()
    expect(asked!.tier).toBe(2)
  })

  it("a plain result is 'finished', NOT 'asked' (no permission pending)", () => {
    const { svc, spawned } = makeHeadlessService()
    const attn = makeAttention(svc)
    const info = svc.createHeadless("t", process.cwd())
    spawned[0].emitStdout(`${fx.ASSISTANT_TOOL_USE}\n`)
    ;(svc as unknown as { headless: Map<string, { activeSince?: number }> })
      .headless.get(info.id)!.activeSince = Date.now() - 11_000
    spawned[0].emitStdout(`${fx.RESULT}\n`)
    expect(attn.list().some((e) => e.kind === "asked")).toBe(false)
  })
})

describe("BO-5 input routing — write()/waitForIdle reach the stdin sink, not a dead PTY", () => {
  it("write() to a structured terminal routes a clean user message to stdin", () => {
    const { svc, spawned } = makeHeadlessService()
    const info = svc.createHeadless("t", process.cwd())
    // broadcast_input/mission/templates pass "text" + a submit CR (and sometimes
    // bracketed-paste). The structured route strips those PTY idioms.
    svc.write(info.id, "\x1b[200~run the tests\x1b[201~\r")
    expect(spawned[0].written).toHaveLength(1)
    expect(JSON.parse(spawned[0].written[0])).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "run the tests" }] },
    })
  })

  it("write() with only control chars sends nothing (no empty user message)", () => {
    const { svc, spawned } = makeHeadlessService()
    const info = svc.createHeadless("t", process.cwd())
    svc.write(info.id, "\r")
    expect(spawned[0].written).toHaveLength(0)
  })

  it("BO-4b: sendAgentMessage echoes a user_message stream event (so AgentView shows the user's turn)", () => {
    const { svc } = makeHeadlessService()
    const events = collect(svc)
    const info = svc.createHeadless("t", process.cwd())
    svc.sendAgentMessage(info.id, userMessage("hello agent"))
    const echoes = events.filter(
      (e): e is Extract<TerminalEvent, { type: "stream" }> =>
        e.type === "stream" && e.event.kind === "user_message",
    )
    expect(echoes).toHaveLength(1)
    expect((echoes[0].event as Extract<StreamEvent, { kind: "user_message" }>).text).toBe(
      "hello agent",
    )
  })

  it("BO-4b: an attachment-only (whitespace) message adds no empty user bubble", () => {
    const { svc } = makeHeadlessService()
    const events = collect(svc)
    const info = svc.createHeadless("t", process.cwd())
    svc.sendAgentMessage(info.id, userMessage("   "))
    expect(events.some((e) => e.type === "stream" && e.event.kind === "user_message")).toBe(false)
  })

  it("waitForIdle input-inject reaches the stdin sink and resolves idle on result", async () => {
    const { svc, spawned } = makeHeadlessService()
    const info = svc.createHeadless("t", process.cwd())
    const p = svc.waitForIdle(info.id, { input: "go", submit: true, timeoutMs: 3000 })
    // Reached the stdin sink (not a PTY — there is none for a structured terminal).
    expect(spawned[0].written.some((w) => w.includes("go"))).toBe(true)
    spawned[0].emitStdout(`${fx.RESULT}\n`) // turn parks → idle
    const res = await p
    expect(res).toEqual({ idle: true, timedOut: false })
  })

  it("a structured terminal has no PTY behind it (isHeadless is authoritative)", () => {
    // A PTY terminal still writes straight to its pty — proven via the PTY suite's
    // FakePty.written; here we just assert a structured terminal isn't PTY-backed.
    // BO-4a NOTE: list() now INCLUDES headless terminals (item #4), so the old
    // "absent from list() => not a PTY" proxy is gone — isHeadless is the signal.
    const { svc } = makeHeadlessService()
    const info = svc.createHeadless("t", process.cwd())
    expect(svc.isHeadless(info.id)).toBe(true)
    expect(svc.list().some((t) => t.id === info.id)).toBe(true) // BO-4a: now listed
  })
})

// ---------------------------------------------------------------------------
// BO-3 — input composer routing + the agent-driven permission gate.
// ---------------------------------------------------------------------------

/** A throwaway main-window stand-in that records every sendToRenderer push, so a
 *  test can assert the permission:request / permission:resolved channel traffic
 *  without an interval-leaking setMainWindow() / real BrowserWindow. */
function attachFakeWin(svc: TerminalService) {
  const sent: Array<{ channel: string; args: unknown[] }> = []
  const win = {
    isDestroyed: () => false,
    webContents: { send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }) },
  }
  ;(svc as unknown as { mainWin: unknown }).mainWin = win
  return sent
}

/** Pull the most recent permission:request payload pushed to the renderer. */
function lastRequest(sent: Array<{ channel: string; args: unknown[] }>) {
  const hit = [...sent].reverse().find((s) => s.channel === "permission:request")
  return hit?.args[0] as { id: string; toolName: string; toolInput: unknown; terminalId?: string } | undefined
}

describe("BO-3 markAwaitingPermission — already-idle leak fix", () => {
  it("arming on an already-idle terminal is a no-op and does NOT mis-arm the next idle", () => {
    const { svc, spawned } = makeHeadlessService()
    const attn = makeAttention(svc)
    const info = svc.createHeadless("t", process.cwd())
    spawned[0].emitStdout(`${fx.INIT}\n`) // booted → idle (already idle now)

    // The leak repro: arm while idle. With the fix this is a no-op; before the
    // fix it left permissionPending=true to poison the next idle.
    svc.markAwaitingPermission(info.id)

    // A normal, sustained turn afterwards must be 'finished', NOT a spurious 'asked'.
    spawned[0].emitStdout(`${fx.ASSISTANT_TOOL_USE}\n`) // → active
    ;(svc as unknown as { headless: Map<string, { activeSince?: number }> })
      .headless.get(info.id)!.activeSince = Date.now() - 11_000
    spawned[0].emitStdout(`${fx.RESULT}\n`) // → idle

    expect(attn.list().some((e) => e.kind === "asked")).toBe(false)
    expect(attn.list().some((e) => e.kind === "finished" && e.terminalId === info.id)).toBe(true)
  })

  it("arming while mid-turn active still raises a tier-2 asked (unchanged)", () => {
    const { svc, spawned } = makeHeadlessService()
    const attn = makeAttention(svc)
    const info = svc.createHeadless("t", process.cwd())
    spawned[0].emitStdout(`${fx.INIT}\n`)
    spawned[0].emitStdout(`${fx.ASSISTANT_TOOL_USE}\n`) // → active mid-turn
    svc.markAwaitingPermission(info.id)
    const asked = attn.list().find((e) => e.kind === "asked" && e.terminalId === info.id)
    expect(asked?.tier).toBe(2)
  })
})

describe("BO-3 requestPermission / resolvePermission — the gate round-trip", () => {
  it("surfaces a tier-2 asked + pushes the request, and resolvePermission(allow) settles it", async () => {
    const { svc, spawned } = makeHeadlessService()
    const attn = makeAttention(svc)
    const sent = attachFakeWin(svc)
    const info = svc.createHeadless("t", process.cwd())
    spawned[0].emitStdout(`${fx.ASSISTANT_TOOL_USE}\n`) // mid-turn active

    const p = svc.requestPermission({
      terminalId: info.id,
      toolName: "Write",
      toolInput: { file_path: "a.txt", content: "x" },
      toolUseId: "tu-1",
    })

    // Attention: tier-2 asked.
    const asked = attn.list().find((e) => e.kind === "asked" && e.terminalId === info.id)
    expect(asked?.tier).toBe(2)

    // Renderer push carries the full request.
    const req = lastRequest(sent)
    expect(req).toBeTruthy()
    expect(req!.toolName).toBe("Write")
    expect(req!.terminalId).toBe(info.id)

    const ok = svc.resolvePermission(req!.id, { id: req!.id, behavior: "allow" })
    expect(ok).toBe(true)
    const decision = await p
    expect(decision.behavior).toBe("allow")
    expect(decision.id).toBe(req!.id)
    // A permission:resolved push cleared the renderer prompt.
    expect(sent.some((s) => s.channel === "permission:resolved")).toBe(true)
  })

  it("resolvePermission(deny) settles with the deny message", async () => {
    const { svc, spawned } = makeHeadlessService()
    const sent = attachFakeWin(svc)
    const info = svc.createHeadless("t", process.cwd())
    spawned[0].emitStdout(`${fx.ASSISTANT_TOOL_USE}\n`)
    const p = svc.requestPermission({ terminalId: info.id, toolName: "Bash", toolInput: { command: "ls" } })
    const req = lastRequest(sent)!
    svc.resolvePermission(req.id, { id: req.id, behavior: "deny", message: "nope" })
    const decision = await p
    expect(decision).toMatchObject({ behavior: "deny", message: "nope" })
  })

  it("double-resolve is a no-op (returns false the second time)", async () => {
    const { svc, spawned } = makeHeadlessService()
    const sent = attachFakeWin(svc)
    const info = svc.createHeadless("t", process.cwd())
    spawned[0].emitStdout(`${fx.ASSISTANT_TOOL_USE}\n`)
    const p = svc.requestPermission({ terminalId: info.id, toolName: "Read", toolInput: {} })
    const req = lastRequest(sent)!
    expect(svc.resolvePermission(req.id, { id: req.id, behavior: "allow" })).toBe(true)
    expect(svc.resolvePermission(req.id, { id: req.id, behavior: "deny", message: "late" })).toBe(false)
    const decision = await p
    expect(decision.behavior).toBe("allow") // the first decision wins
  })

  it("killing the terminal while a permission is pending rejects it as deny('agent-exited')", async () => {
    const { svc, spawned } = makeHeadlessService()
    const sent = attachFakeWin(svc)
    const info = svc.createHeadless("t", process.cwd())
    spawned[0].emitStdout(`${fx.ASSISTANT_TOOL_USE}\n`)
    const p = svc.requestPermission({ terminalId: info.id, toolName: "Bash", toolInput: { command: "rm -rf /" } })
    svc.kill(info.id)
    const decision = await p
    expect(decision).toMatchObject({ behavior: "deny", message: "agent-exited" })
  })

  it("killAll while a permission is pending rejects it as deny('agent-exited')", async () => {
    const { svc, spawned } = makeHeadlessService()
    const sent = attachFakeWin(svc)
    const info = svc.createHeadless("t", process.cwd())
    spawned[0].emitStdout(`${fx.ASSISTANT_TOOL_USE}\n`)
    const p = svc.requestPermission({ terminalId: info.id, toolName: "Write", toolInput: {} })
    svc.killAll()
    const decision = await p
    expect(decision.behavior).toBe("deny")
  })
})

describe("BO-3 always-allow persistence", () => {
  it("alwaysAllow writes the tool into <cwd>/.claude/settings.local.json permissions.allow", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bo3-allow-"))
    const { svc, spawned } = makeHeadlessService()
    const sent = attachFakeWin(svc)
    const info = svc.createHeadless("t", cwd)
    spawned[0].emitStdout(`${fx.ASSISTANT_TOOL_USE}\n`)
    const p = svc.requestPermission({ terminalId: info.id, toolName: "Write", toolInput: {} })
    const req = lastRequest(sent)!
    svc.resolvePermission(req.id, { id: req.id, behavior: "allow", alwaysAllow: true })
    void p

    const file = join(cwd, ".claude", "settings.local.json")
    const settings = JSON.parse(readFileSync(file, "utf8"))
    expect(settings.permissions.allow).toContain("Write")
  })

  it("plain allow (no alwaysAllow) does NOT write a settings file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bo3-noallow-"))
    const { svc, spawned } = makeHeadlessService()
    const sent = attachFakeWin(svc)
    const info = svc.createHeadless("t", cwd)
    spawned[0].emitStdout(`${fx.ASSISTANT_TOOL_USE}\n`)
    const p = svc.requestPermission({ terminalId: info.id, toolName: "Write", toolInput: {} })
    const req = lastRequest(sent)!
    svc.resolvePermission(req.id, { id: req.id, behavior: "allow" })
    void p
    expect(existsSync(join(cwd, ".claude", "settings.local.json"))).toBe(false)
  })
})

describe("BO-10 permission hang hardening — guard timeout + hasPendingPermission", () => {
  /** A service whose guard timeout fires fast, with a notify spy. */
  function makeGuarded(permissionGuardMs: number) {
    const spawned: FakeStreamProc[] = []
    const spawnProc: SpawnProc = (file, args, options) => {
      const f = new FakeStreamProc(file, args, options)
      spawned.push(f)
      return f
    }
    const notify = vi.fn()
    const svc = new TerminalService({ spawnProc, permissionGuardMs, notify })
    return { svc, spawned, notify }
  }

  it("an unanswered permission auto-denies with a user-facing reason + a visible notify", async () => {
    const { svc, spawned, notify } = makeGuarded(15)
    const sent = attachFakeWin(svc)
    const info = svc.createHeadless("t", process.cwd())
    spawned[0].emitStdout(`${fx.ASSISTANT_TOOL_USE}\n`) // mid-turn active

    // No resolvePermission call — let the guard fire. The promise the blocked
    // approve_tool awaits must settle as a deny (Claude has no timeout of its own).
    const decision = await svc.requestPermission({
      terminalId: info.id,
      toolName: "Bash",
      toolInput: { command: "ls" },
    })
    expect(decision.behavior).toBe("deny")
    expect(decision.message).toMatch(/auto-denied|timeout|unanswered/i)
    // A user-visible toast surfaced (warning), so the timeout isn't a silent hang.
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][1]).toBe("warning")
    // The renderer prompt was cleared.
    expect(sent.some((s) => s.channel === "permission:resolved")).toBe(true)
  })

  it("resolving in time disarms the guard — no late deny, no late notify", async () => {
    const { svc, spawned, notify } = makeGuarded(15)
    const sent = attachFakeWin(svc)
    const info = svc.createHeadless("t", process.cwd())
    spawned[0].emitStdout(`${fx.ASSISTANT_TOOL_USE}\n`)
    const p = svc.requestPermission({ terminalId: info.id, toolName: "Write", toolInput: {} })
    const req = lastRequest(sent)!
    svc.resolvePermission(req.id, { id: req.id, behavior: "allow" })
    expect((await p).behavior).toBe("allow")
    // Wait past the guard window: the timer must have been cleared on resolve.
    await new Promise((r) => setTimeout(r, 40))
    expect(notify).not.toHaveBeenCalled()
  })

  it("hasPendingPermission is true only while a prompt is outstanding", async () => {
    const { svc, spawned } = makeHeadlessService()
    const sent = attachFakeWin(svc)
    const info = svc.createHeadless("t", process.cwd())
    spawned[0].emitStdout(`${fx.ASSISTANT_TOOL_USE}\n`)
    expect(svc.hasPendingPermission(info.id)).toBe(false)
    const p = svc.requestPermission({ terminalId: info.id, toolName: "Write", toolInput: {} })
    expect(svc.hasPendingPermission(info.id)).toBe(true) // the composer-send guard reads this
    const req = lastRequest(sent)!
    svc.resolvePermission(req.id, { id: req.id, behavior: "allow" })
    expect(svc.hasPendingPermission(info.id)).toBe(false)
    await p
  })
})

describe("BO-11 abortPendingPermissionAndDrain — close the parked turn via the LIVE proc", () => {
  it("settles the parked permission as a DENY (through the live proc) then resolves once the turn drains to a result", async () => {
    const { svc, spawned } = makeHeadlessService()
    const sent = attachFakeWin(svc)
    const info = svc.createHeadless("t", process.cwd())
    spawned[0].emitStdout(`${fx.ASSISTANT_TOOL_USE}\n`) // mid-turn active
    // The agent parks on a Write permission (the half-open-turn hazard).
    const approve = svc.requestPermission({ terminalId: info.id, toolName: "Write", toolInput: { file_path: "/x" } })
    expect(svc.hasPendingPermission(info.id)).toBe(true)

    // Start the abort-drain (do NOT await yet — it polls for the turn's `result`).
    const drain = svc.abortPendingPermissionAndDrain(info.id, "the user interrupted this action")

    // The blocked approve_tool call returns a DENY carrying the abort message — i.e.
    // the deny was delivered THROUGH the live proc, not as a teardown orphan.
    const decision = await approve
    expect(decision.behavior).toBe("deny")
    expect(decision.message).toMatch(/interrupted/i)
    expect(svc.hasPendingPermission(info.id)).toBe(false)
    // The renderer prompt was cleared (resolved), not left dangling.
    expect(sent.some((s) => s.channel === "permission:resolved")).toBe(true)

    // Claude acknowledges the deny and winds the turn down to a `result` → the drain
    // resolves true (the turn is now CLOSED on disk, safe to kill + --resume).
    spawned[0].emitStdout(`${fx.RESULT}\n`)
    expect(await drain).toBe(true)
  })

  it("is a no-op (false) when nothing is parked — a generating turn has no half-open tool_use to close", async () => {
    const { svc } = makeHeadlessService()
    const info = svc.createHeadless("t", process.cwd())
    expect(svc.hasPendingPermission(info.id)).toBe(false)
    expect(await svc.abortPendingPermissionAndDrain(info.id, "interrupted")).toBe(false)
  })

  it("times out (false) if no result ever drains — the caller then falls back to a bare kill", async () => {
    const { svc, spawned } = makeHeadlessService()
    attachFakeWin(svc)
    const info = svc.createHeadless("t", process.cwd())
    spawned[0].emitStdout(`${fx.ASSISTANT_TOOL_USE}\n`)
    const approve = svc.requestPermission({ terminalId: info.id, toolName: "Write", toolInput: {} })
    // A tiny timeout: deny is delivered, but we never emit a `result`, so it gives up.
    const drained = await svc.abortPendingPermissionAndDrain(info.id, "interrupted", 30)
    expect(drained).toBe(false)
    expect((await approve).behavior).toBe("deny") // the permission was still settled (no hang)
  })
})

describe("BO-3 addAllowRule — pure settings.local.json merge", () => {
  it("adds a tool to an empty/absent settings object", () => {
    const { changed, next } = addAllowRule(null, "Write")
    expect(changed).toBe(true)
    expect(next.permissions.allow).toEqual(["Write"])
  })

  it("merges into an existing allow list, preserving other keys", () => {
    const existing = { permissions: { allow: ["Read"], deny: ["Bash(rm *)"] }, other: 1 }
    const { changed, next } = addAllowRule(existing, "Write")
    expect(changed).toBe(true)
    expect(next.permissions.allow).toEqual(["Read", "Write"])
    expect((next.permissions as Record<string, unknown>).deny).toEqual(["Bash(rm *)"])
    expect((next as Record<string, unknown>).other).toBe(1)
  })

  it("is idempotent — a tool already present is a no-op", () => {
    const { changed } = addAllowRule({ permissions: { allow: ["Write"] } }, "Write")
    expect(changed).toBe(false)
  })

  it("tolerates garbage (non-object) input by replacing it", () => {
    const { changed, next } = addAllowRule("not-json" as unknown, "Write")
    expect(changed).toBe(true)
    expect(next.permissions.allow).toEqual(["Write"])
  })
})

describe("BO-3 agent:send-input routing — composer message reaches the stdin sink", () => {
  it("sendAgentMessage from a composer message writes structured stdin (proxy for the ipc handler)", () => {
    const { svc, spawned } = makeHeadlessService()
    const info = svc.createHeadless("t", process.cwd())
    // The ipc handler folds { text, attachments } via agentMessageFromInput then
    // calls sendAgentMessage; assert the structured write lands on stdin.
    svc.sendAgentMessage(info.id, userMessage("hello from composer"))
    expect(JSON.parse(spawned[0].written[0])).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello from composer" }] },
    })
  })
})

// ---------------------------------------------------------------------------
// BO-4a — the engine switch + the go-live punch-list.
// ---------------------------------------------------------------------------

/** A minimal fake PTY (PtyLike) with no real process behind it — records spawn
 *  args so the engine-switch test can assert the xterm path is byte-unchanged. */
class FakePtyLite implements PtyLike {
  pid = Math.floor(Math.random() * 1_000_000)
  cols: number
  rows: number
  killed = false
  written: string[] = []
  constructor(
    readonly file: string,
    readonly args: string[],
    readonly options: SpawnPtyOptions,
  ) {
    this.cols = options.cols
    this.rows = options.rows
  }
  onData(): void {}
  onExit(): void {}
  write(d: string): void {
    this.written.push(d)
  }
  resize(): void {}
  kill(): void {
    this.killed = true
  }
}

/** A TerminalService wired with BOTH spawn seams (PTY + headless) so a test can
 *  assert which transport create() routes to per the configured engine. */
function makeDualService(): { svc: TerminalService; ptys: FakePtyLite[]; procs: FakeStreamProc[] } {
  const ptys: FakePtyLite[] = []
  const procs: FakeStreamProc[] = []
  const spawnPty: SpawnPty = (file, args, options) => {
    const f = new FakePtyLite(file, args, options)
    ptys.push(f)
    return f
  }
  const spawnProc: SpawnProc = (file, args, options) => {
    const f = new FakeStreamProc(file, args, options)
    procs.push(f)
    return f
  }
  return { svc: new TerminalService({ spawnPty, spawnProc }), ptys, procs }
}

describe("BO-4a engine switch — create() routes by the configured engine", () => {
  // CAPP-39 gate ④ — the DEFAULT engine flipped to "structured".
  it("default engine is structured (CAPP-39 gate ④)", () => {
    const { svc } = makeDualService()
    expect(svc.getEngine()).toBe("structured")
  })

  it("engine=xterm: create() spawns a PTY, NOT the headless transport; args byte-unchanged", () => {
    const { svc, ptys, procs } = makeDualService()
    // CAPP-39 gate ④ — xterm is no longer the default; opt in explicitly to test the
    // legacy PTY branch (still byte-unchanged when selected).
    svc.setEngine("xterm")
    const info = svc.create("t", process.cwd())
    expect(ptys).toHaveLength(1)
    expect(procs).toHaveLength(0)
    expect(svc.isHeadless(info.id)).toBe(false)
    // The xterm branch must NOT carry the headless stream-json flags / gate.
    const joined = ptys[0].args.join(" ")
    expect(joined).not.toContain("--output-format stream-json")
    expect(joined).not.toContain("--permission-prompt-tool")
    // It still carries the default interactive flags (unchanged behavior).
    expect(joined).toContain("--dangerously-skip-permissions")
  })

  it("engine=structured (default): create() routes to createHeadless (stream-json), NOT a PTY", () => {
    // CAPP-39 gate ④ — with no setEngine call the DEFAULT now routes to the headless
    // transport, so the structured path is reachable without opting in.
    const { svc, ptys, procs } = makeDualService()
    const info = svc.create("t", process.cwd())
    expect(procs).toHaveLength(1)
    expect(ptys).toHaveLength(0)
    expect(svc.isHeadless(info.id)).toBe(true)
  })

  it("engine=structured: create() routes to createHeadless (stream-json), NOT a PTY", () => {
    const { svc, ptys, procs } = makeDualService()
    svc.setEngine("structured")
    const info = svc.create("t", process.cwd())
    expect(procs).toHaveLength(1)
    expect(ptys).toHaveLength(0)
    expect(svc.isHeadless(info.id)).toBe(true)
    const joined = procs[0].args.join(" ")
    expect(joined).toContain(HEADLESS_FLAGS.join(" "))
    // DEV-skip-permissions default posture: structured spawns skip the BO-3 gate.
    expect(joined).toContain("--dangerously-skip-permissions")
    expect(joined).not.toContain("--permission-prompt-tool")
  })

  it("engine=structured + skipApproval=false: create() routes to the BO-3 gate (no skip flag)", () => {
    const { svc, procs } = makeDualService()
    svc.setEngine("structured")
    svc.setSkipApproval(false)
    svc.create("t", process.cwd())
    const joined = procs[0].args.join(" ")
    expect(joined).toContain(`--permission-prompt-tool ${PERMISSION_PROMPT_TOOL}`)
    expect(joined).not.toContain("--dangerously-skip-permissions")
  })

  it("setEngine resolves any non-xterm value to structured (CAPP-39 gate ④ safe default)", () => {
    // CAPP-39 gate ④ — the normalization inverted: only an explicit "xterm" pins the
    // legacy PTY; an unrecognized value now degrades to the structured default
    // (mirrors resolveRenderingEngine so the service and resolver agree).
    const { svc } = makeDualService()
    svc.setEngine("bogus" as never)
    expect(svc.getEngine()).toBe("structured")
    svc.setEngine("xterm")
    expect(svc.getEngine()).toBe("xterm")
    svc.setEngine("structured")
    expect(svc.getEngine()).toBe("structured")
  })

  it("structured create() preserves identity + emits created on the same seam", () => {
    const { svc } = makeDualService()
    svc.setMcpServerUrl("http://127.0.0.1:9999/sse")
    svc.setEngine("structured")
    const events = collect(svc)
    const info = svc.create("t", process.cwd(), "sess-x")
    expect(events.some((e) => e.type === "created" && e.info.id === info.id)).toBe(true)
    // identity-bound mcp-config minted (resolves to this terminal's sid/tid).
    expect(svc.isHeadless(info.id)).toBe(true)
  })

  it("BO-4b: the returned info carries the ACTUAL engine (xterm vs structured)", () => {
    const { svc } = makeDualService()
    // CAPP-39 gate ④ — xterm is no longer the default; opt in to exercise the PTY path.
    // An xterm PTY terminal is active on spawn.
    svc.setEngine("xterm")
    const x = svc.create("x", process.cwd())
    expect(x.engine).toBe("xterm")
    expect(x.state).toBe("active")
    // Structured engine → a headless terminal, parked IDLE on spawn (no input yet).
    svc.setEngine("structured")
    const s = svc.create("s", process.cwd())
    expect(s.engine).toBe("structured")
    expect(s.state).toBe("idle")
  })
})

describe("CAPP-39 gate ③ — createXterm spawns a PTY regardless of the global engine; isBusy", () => {
  it("createXterm spawns a PTY even when the global engine is structured (escape hatch)", () => {
    const { svc, ptys, procs } = makeDualService()
    svc.setEngine("structured") // global default is structured…
    const info = svc.createXterm("raw", process.cwd())
    // …but createXterm still lands on the interactive PTY path, not the headless one.
    expect(ptys).toHaveLength(1)
    expect(procs).toHaveLength(0)
    expect(info.engine).toBe("xterm")
    expect(svc.isHeadless(info.id)).toBe(false)
    // Same fully-featured xterm body as a normal create(): default interactive flags,
    // NOT the headless stream-json gate.
    const joined = ptys[0].args.join(" ")
    expect(joined).toContain("--dangerously-skip-permissions")
    expect(joined).not.toContain("--output-format stream-json")
    expect(joined).not.toContain("--permission-prompt-tool")
  })

  it("createXterm and create()'s xterm branch produce byte-equivalent spawn args (same body)", () => {
    const { svc: a, ptys: ptysA } = makeDualService()
    const { svc: b, ptys: ptysB } = makeDualService()
    a.setEngine("xterm") // CAPP-39 gate ④ — opt into the legacy branch (no longer default)
    a.create("t", "/repo") // global engine xterm → create() xterm branch
    b.setEngine("structured")
    b.createXterm("t", "/repo") // escape-hatch xterm spawn under a structured global
    // The id differs (minted per spawn), but the shell + args are identical — proving
    // createXterm reuses the SAME spawnXterm body create() runs, so normal routing is
    // unchanged.
    expect(ptysA[0].file).toBe(ptysB[0].file)
    expect(ptysA[0].args).toEqual(ptysB[0].args)
  })

  it("createXterm threads --resume so the switched terminal keeps the SAME conversation", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctui-xterm-resume-"))
    const cwd = process.cwd()
    // A transcript file must exist for resumeArgs to add --resume (mirrors the real path).
    const projDir = join(dir, encodeProjectDir(cwd))
    mkdirSync(projDir, { recursive: true })
    writeFileSync(join(projDir, "conv-xyz.jsonl"), "{}\n")
    const ptys: PtyLike[] = []
    const spawnPty: SpawnPty = (file, args, options) => {
      const f = new FakePtyLite(file, args, options)
      ptys.push(f)
      return f as unknown as PtyLike
    }
    const svc = new TerminalService({ spawnPty })
    ;(svc as unknown as { ccProjectsRoot: string }).ccProjectsRoot = dir
    svc.createXterm("raw", cwd, undefined, "conv-xyz")
    const joined = (ptys[0] as unknown as FakePtyLite).args.join(" ")
    expect(joined).toContain("--resume conv-xyz")
  })

  it("isBusy is true for a generating structured terminal and false once idle / for xterm", () => {
    const { svc } = makeHeadlessService()
    const info = svc.createHeadless("worker", process.cwd())
    // Parked idle on spawn → not busy.
    expect(svc.isBusy(info.id)).toBe(false)
    // First message flips it active (generating) → busy.
    svc.sendAgentMessage(info.id, userMessage("hi"))
    expect(svc.isBusy(info.id)).toBe(true)
    // An xterm PTY has no turn machine → never busy here. CAPP-39 gate ④ — xterm is
    // no longer the default, so opt in explicitly to spawn the PTY.
    const { svc: dual } = makeDualService()
    dual.setEngine("xterm")
    const x = dual.create("x", process.cwd())
    expect(dual.isBusy(x.id)).toBe(false)
    // Unknown id → not busy.
    expect(svc.isBusy("nope")).toBe(false)
  })

  it("isBusy is true while a permission is pending even when the terminal is idle", () => {
    const { svc } = makeHeadlessService()
    const info = svc.createHeadless("worker", process.cwd())
    // Park a pending permission (the gate). requestPermission registers it; the
    // terminal is idle (between turns) but must read busy so the engine switch refuses.
    void svc.requestPermission({ terminalId: info.id, toolName: "Write", toolInput: {} })
    expect(svc.isBusy(info.id)).toBe(true)
  })
})

describe("BO-4a list()/getActivity() include headless terminals (the big BO-5 review item)", () => {
  it("list() includes a structured terminal with the right shape (idle on spawn)", () => {
    const { svc } = makeHeadlessService()
    const info = svc.createHeadless("worker", process.cwd())
    const row = svc.list().find((t) => t.id === info.id)
    // BO-4b: a freshly spawned structured terminal is parked IDLE (awaiting the
    // first message), not "active" — `claude -p` emits nothing until first stdin.
    expect(row).toMatchObject({ id: info.id, name: "worker", state: "idle" })
  })

  it("getActivity() includes a structured terminal (idle on spawn, fresh idleMs)", () => {
    const { svc } = makeHeadlessService()
    const info = svc.createHeadless("worker", process.cwd())
    const a = svc.getActivity().find((x) => x.id === info.id)
    expect(a).toBeDefined()
    expect(a!.state).toBe("idle")
    expect(a!.idleMs).toBeGreaterThanOrEqual(0)
  })

  it("BO-4b: the FIRST user message flips a freshly-spawned structured terminal active", () => {
    const { svc, spawned } = makeHeadlessService()
    const events = collect(svc)
    const info = svc.createHeadless("worker", process.cwd())
    // Parked idle until the user types — no active burst, no attention noise.
    expect(svc.getActivity().find((x) => x.id === info.id)!.state).toBe("idle")
    // Sending the first message wakes it (idle→active edge emits a state event).
    svc.sendAgentMessage(info.id, userMessage("hi"))
    expect(spawned[0].written).toHaveLength(1)
    expect(svc.getActivity().find((x) => x.id === info.id)!.state).toBe("active")
    expect(
      events.some((e) => e.type === "state" && e.id === info.id && e.state === "active"),
    ).toBe(true)
  })

  it("a structured terminal drops out of list()/getActivity() after kill", () => {
    const { svc } = makeHeadlessService()
    const info = svc.createHeadless("worker", process.cwd())
    svc.kill(info.id)
    expect(svc.list().some((t) => t.id === info.id)).toBe(false)
    expect(svc.getActivity().some((x) => x.id === info.id)).toBe(false)
  })

  it("list()/getActivity() include BOTH transports when mixed", () => {
    const { svc, ptys } = makeDualService()
    svc.setEngine("xterm") // CAPP-39 gate ④ — opt into xterm (no longer default) for the PTY half
    const pty = svc.create("pty", process.cwd()) // xterm
    void ptys
    svc.setEngine("structured")
    const head = svc.create("head", process.cwd()) // headless
    const ids = svc.list().map((t) => t.id)
    expect(ids).toContain(pty.id)
    expect(ids).toContain(head.id)
    const actIds = svc.getActivity().map((a) => a.id)
    expect(actIds).toContain(pty.id)
    expect(actIds).toContain(head.id)
  })
})

describe("BO-4a punch-list a — requestPermission liveness guard (TOCTOU)", () => {
  it("denies immediately for an unknown terminal (never registers a hanging resolver)", async () => {
    const { svc } = makeHeadlessService()
    const decision = await svc.requestPermission({ terminalId: "ghost", toolName: "Bash", toolInput: {} })
    expect(decision.behavior).toBe("deny")
  })

  it("denies immediately when the terminal died between tool_use and the gate call", async () => {
    const { svc, spawned } = makeHeadlessService()
    const info = svc.createHeadless("t", process.cwd())
    spawned[0].emitStdout(`${fx.ASSISTANT_TOOL_USE}\n`)
    svc.kill(info.id) // terminal dies AFTER the assistant's tool_use, BEFORE the gate
    const decision = await svc.requestPermission({ terminalId: info.id, toolName: "Bash", toolInput: { command: "rm -rf /" } })
    expect(decision.behavior).toBe("deny")
  })
})

describe("BO-4a punch-list g — a permission requested while IDLE still surfaces a tier-2 asked", () => {
  it("raises asked even when the terminal is already idle at request time", async () => {
    const { svc, spawned } = makeHeadlessService()
    const attn = makeAttention(svc)
    const sent = attachFakeWin(svc)
    const info = svc.createHeadless("t", process.cwd())
    spawned[0].emitStdout(`${fx.INIT}\n`) // booted → idle (already idle now)

    // The gate fires while idle (between turns). markAwaitingPermission alone
    // no-ops here, so requestPermission must raise the asked itself (punch-list g).
    const p = svc.requestPermission({ terminalId: info.id, toolName: "Write", toolInput: {} })
    const asked = attn.list().find((e) => e.kind === "asked" && e.terminalId === info.id)
    expect(asked?.tier).toBe(2)

    // Settle the pending promise so it doesn't dangle.
    const req = lastRequest(sent)!
    svc.resolvePermission(req.id, { id: req.id, behavior: "deny", message: "done" })
    const decision = await p
    expect(decision.behavior).toBe("deny")
  })
})

describe("BO-4a punch-list b — persistAllowRule gitignores settings.local.json", () => {
  it("writes .claude/.gitignore (containing settings.local.json) when it creates .claude/", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bo4a-gi-"))
    const { svc, spawned } = makeHeadlessService()
    const sent = attachFakeWin(svc)
    const info = svc.createHeadless("t", cwd)
    spawned[0].emitStdout(`${fx.ASSISTANT_TOOL_USE}\n`)
    const p = svc.requestPermission({ terminalId: info.id, toolName: "Write", toolInput: {} })
    const req = lastRequest(sent)!
    svc.resolvePermission(req.id, { id: req.id, behavior: "allow", alwaysAllow: true })
    void p

    const gi = join(cwd, ".claude", ".gitignore")
    expect(existsSync(gi)).toBe(true)
    expect(readFileSync(gi, "utf8")).toContain("settings.local.json")
  })
})

describe("BO-4a punch-list d — boot-race: a slow (>10s) cold boot does NOT enqueue a spurious finished", () => {
  it("resets the active burst at init so a long boot never trips the finished guardrail", () => {
    const { svc, spawned } = makeHeadlessService()
    const attn = makeAttention(svc)
    const info = svc.createHeadless("t", process.cwd())
    // Simulate a >10s cold MCP boot: the burst started at spawn time long ago.
    ;(svc as unknown as { headless: Map<string, { activeSince?: number }> })
      .headless.get(info.id)!.activeSince = Date.now() - 11_000
    spawned[0].emitStdout(`${fx.INIT}\n`) // init resets the burst baseline — must NOT be "finished"
    expect(attn.list().some((e) => e.kind === "finished" && e.terminalId === info.id)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// CAPP-58 RUNTIME-INTEGRATION FIX — `init` must NOT tear `busy` down mid-turn.
// On the stream-json path `init` arrives AFTER the first user message (before the
// assistant deltas), so an unconditional idleHeadless()-on-init produced an
// active→idle→active flap that blanked the dead-air "Thinking" row + the streaming
// caret for the whole cold-start gap. The pure-function suite (workingRowState /
// streamingCaretId) can't see this — the busy signal it consumes was being torn
// down upstream by the SERVICE. This guards that runtime seam.
// ---------------------------------------------------------------------------
describe("CAPP-58 — init does not flap busy mid-turn (the dead-air row/caret guard)", () => {
  it("a user_message → init → result turn emits ONE continuous active→idle (no active→idle→active flap)", () => {
    const { svc, spawned } = makeHeadlessService()
    const events = collect(svc)
    const info = svc.createHeadless("t", process.cwd())
    // Submit: the first user message flips idle→active (this is what sets busy=true).
    svc.sendAgentMessage(info.id, userMessage("do the thing"))
    // On the real stream-json path init arrives mid-turn, AFTER the user message,
    // BEFORE the assistant deltas. It must NOT emit an "idle" while the turn is live.
    spawned[0].emitStdout(`${fx.INIT}\n`)
    // Turn completes → the SINGLE idle of the turn.
    spawned[0].emitStdout(`${fx.RESULT}\n`)

    const states = events
      .filter((e) => e.type === "state" && e.id === info.id)
      .map((e) => (e as { state: string }).state)
    // Exactly one active then one idle — no idle wedged in between by init.
    expect(states).toEqual(["active", "idle"])
    // Stays idle at the end (parked on result, ready for the next message).
    expect(svc.getActivity().find((x) => x.id === info.id)!.state).toBe("idle")
  })

  it("a spawned-but-UNSENT terminal fed init stays idle (BO-4b no-input-idle preserved)", () => {
    const { svc, spawned } = makeHeadlessService()
    const events = collect(svc)
    const info = svc.createHeadless("t", process.cwd())
    // No user message sent — feed only init. The terminal must remain idle and must
    // NOT emit any state event (init alone is not activity).
    spawned[0].emitStdout(`${fx.INIT}\n`)
    expect(svc.getActivity().find((x) => x.id === info.id)!.state).toBe("idle")
    expect(events.some((e) => e.type === "state" && e.id === info.id)).toBe(false)
  })
})

describe("BO-4a punch-list e — post-kill buffer resurrection guard", () => {
  it("a late async stdout flush after kill does NOT re-create the deleted outputBuffer", () => {
    const { svc, spawned } = makeHeadlessService()
    const info = svc.createHeadless("t", process.cwd())
    // A partial (newline-less) line sits buffered — the proc's exit will flush it.
    spawned[0].emitStdout(fx.ASSISTANT_TEXT_DELTA) // no trailing "\n" → buffered
    svc.kill(info.id) // synchronous teardown deletes headless + outputBuffers
    // The OS delivers exit on a later tick; createHeadless's onExit drains the
    // buffered line. The resurrection guard must drop it (no ghost buffer).
    spawned[0].emitExit(0)
    expect(svc.getOutput(info.id)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// BO-6 — model control on the headless spawn (the core fix: ALWAYS pass --model,
// on BOTH the fresh and the resume path, so a resumed transcript's saved-model
// pin can't 404 forever).
// ---------------------------------------------------------------------------

describe("BO-6 createHeadless — --model on the spawn args", () => {
  it("getModel() defaults to the opus alias", () => {
    const { svc } = makeHeadlessService()
    expect(svc.getModel()).toBe(DEFAULT_MODEL)
    expect(DEFAULT_MODEL).toBe("opus")
  })

  it("a fresh spawn includes --model <default> (opus) and returns it on the info", () => {
    const { svc, spawned } = makeHeadlessService()
    const info = svc.createHeadless("t", process.cwd())
    const joined = spawned[0].args.join(" ")
    expect(joined).toContain(`--model ${DEFAULT_MODEL}`)
    expect(info.model).toBe(DEFAULT_MODEL)
    // list() surfaces the model so the renderer picker can show it.
    expect(svc.list().find((t) => t.id === info.id)?.model).toBe(DEFAULT_MODEL)
  })

  it("setModel(...) changes the model new terminals spawn with", () => {
    const { svc, spawned } = makeHeadlessService()
    svc.setModel("sonnet")
    expect(svc.getModel()).toBe("sonnet")
    svc.createHeadless("t", process.cwd())
    expect(spawned[0].args.join(" ")).toContain("--model sonnet")
  })

  it("a blank setModel value is ignored (can only degrade to the existing default, never to no model)", () => {
    const { svc, spawned } = makeHeadlessService()
    svc.setModel("   ")
    expect(svc.getModel()).toBe(DEFAULT_MODEL)
    svc.createHeadless("t", process.cwd())
    expect(spawned[0].args.join(" ")).toContain(`--model ${DEFAULT_MODEL}`)
  })

  it("an explicit per-terminal model arg wins over the default", () => {
    const { svc, spawned } = makeHeadlessService()
    // signature: createHeadless(name, cwd, sessionId, resumeConvId, allowedTools, model)
    const info = svc.createHeadless("t", process.cwd(), undefined, undefined, undefined, "haiku")
    expect(spawned[0].args.join(" ")).toContain("--model haiku")
    expect(info.model).toBe("haiku")
  })

  it("RESUME path: --resume <id> and --model <model> COEXIST on the spawn args", () => {
    const root = mkdtempSync(join(tmpdir(), "bo6-resume-"))
    const cwd = process.cwd()
    const dir = join(root, encodeProjectDir(cwd))
    mkdirSync(dir, { recursive: true })
    const convId = "resume-bo6-1"
    writeFileSync(join(dir, `${convId}.jsonl`), "{}")

    const { svc, spawned } = makeHeadlessService()
    ;(svc as unknown as { ccProjectsRoot: string }).ccProjectsRoot = root
    svc.createHeadless("t", cwd, undefined, convId, undefined, "opus[1m]")

    const joined = spawned[0].args.join(" ")
    expect(joined).toContain(`--resume ${convId}`)
    expect(joined).toContain("--model opus[1m]")
  })

  it("the xterm (legacy PTY) path does NOT pass --model — byte-unchanged", () => {
    const { svc, ptys, procs } = makeDualService()
    svc.setEngine("xterm") // CAPP-39 gate ④ — xterm is no longer the default; opt in
    svc.create("t", process.cwd())
    expect(procs).toHaveLength(0)
    expect(ptys[0].args.join(" ")).not.toContain("--model")
  })

  it("engine=structured create() routes through the model pin (default opus)", () => {
    const { svc, procs } = makeDualService()
    svc.setEngine("structured")
    const info = svc.create("t", process.cwd())
    expect(procs[0].args.join(" ")).toContain(`--model ${DEFAULT_MODEL}`)
    expect(info.model).toBe(DEFAULT_MODEL)
  })
})

// ---------------------------------------------------------------------------
// CAPP-46 — reasoning-effort control on the headless spawn. KEY DIFFERENCE from
// --model: --effort is CONDITIONAL — OMITTED entirely when unset (byte-unchanged
// default) and only PRESENT once a level is configured or passed per-terminal.
// ---------------------------------------------------------------------------

describe("CAPP-46 createHeadless — --effort on the spawn args", () => {
  it("getEffort() defaults to undefined (no level)", () => {
    const { svc } = makeHeadlessService()
    expect(svc.getEffort()).toBeUndefined()
  })

  it("a fresh spawn with NO effort OMITS --effort entirely (default byte-unchanged) and returns undefined", () => {
    const { svc, spawned } = makeHeadlessService()
    const info = svc.createHeadless("t", process.cwd())
    expect(spawned[0].args.join(" ")).not.toContain("--effort")
    expect(info.effort).toBeUndefined()
    // list() surfaces undefined effort so the picker shows "default".
    expect(svc.list().find((t) => t.id === info.id)?.effort).toBeUndefined()
  })

  it("setEffort(level) makes new terminals spawn WITH --effort <level>", () => {
    const { svc, spawned } = makeHeadlessService()
    svc.setEffort("high")
    expect(svc.getEffort()).toBe("high")
    const info = svc.createHeadless("t", process.cwd())
    expect(spawned[0].args.join(" ")).toContain("--effort high")
    expect(info.effort).toBe("high")
  })

  it("setEffort('') CLEARS the level back to undefined (the spawn omits --effort again)", () => {
    const { svc, spawned } = makeHeadlessService()
    svc.setEffort("high")
    svc.setEffort("   ")
    expect(svc.getEffort()).toBeUndefined()
    svc.createHeadless("t", process.cwd())
    expect(spawned[0].args.join(" ")).not.toContain("--effort")
  })

  it("an explicit per-terminal effort arg wins over the default", () => {
    const { svc, spawned } = makeHeadlessService()
    // signature: createHeadless(name, cwd, sessionId, resumeConvId, allowedTools, model, effort)
    const info = svc.createHeadless("t", process.cwd(), undefined, undefined, undefined, undefined, "max")
    expect(spawned[0].args.join(" ")).toContain("--effort max")
    expect(info.effort).toBe("max")
    expect(EFFORT_LEVELS).toContain("max")
  })

  it("--effort coexists with --model (when a level is set) but never appears unset", () => {
    const { svc, spawned } = makeHeadlessService()
    const info = svc.createHeadless("t", process.cwd(), undefined, undefined, undefined, "sonnet", "low")
    const joined = spawned[0].args.join(" ")
    expect(joined).toContain("--model sonnet")
    expect(joined).toContain("--effort low")
    expect(info.model).toBe("sonnet")
    expect(info.effort).toBe("low")
  })

  it("the xterm (legacy PTY) path does NOT pass --effort — byte-unchanged", () => {
    const { svc, ptys, procs } = makeDualService()
    svc.setEngine("xterm") // CAPP-39 gate ④ — xterm is no longer the default; opt in
    svc.setEffort("high") // even with a default set, the xterm path ignores it
    svc.create("t", process.cwd())
    expect(procs).toHaveLength(0)
    expect(ptys[0].args.join(" ")).not.toContain("--effort")
  })

  it("EFFORT_LEVELS are the five probed levels in picker order", () => {
    expect(EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"])
  })
})

// ---------------------------------------------------------------------------
// CAPP-108 — Ultracode control on the headless spawn. A per-session BOOLEAN: ON
// appends `--settings '{"ultracode":true}'` (the inline JSON is single-quoted by
// the argv-safe shellWrap so it round-trips) and OMITS `--effort` (ultracode forces
// xhigh — passing both is undefined). OFF omits `--settings` (byte-unchanged).
// ---------------------------------------------------------------------------

describe("CAPP-108 createHeadless — ultracode --settings on the spawn args", () => {
  it("getUltracode() defaults to false (off)", () => {
    const { svc } = makeHeadlessService()
    expect(svc.getUltracode()).toBe(false)
  })

  it("a fresh spawn with ultracode OFF OMITS --settings entirely (default byte-unchanged) and returns false", () => {
    const { svc, spawned } = makeHeadlessService()
    const info = svc.createHeadless("t", process.cwd())
    expect(spawned[0].args.join(" ")).not.toContain("--settings")
    expect(spawned[0].args.join(" ")).not.toContain("ultracode")
    expect(info.ultracode).toBe(false)
    // list() surfaces the posture so the renderer toggle can show it.
    expect(svc.list().find((t) => t.id === info.id)?.ultracode).toBe(false)
  })

  it("CAPP-117: ultracode ON passes --settings <temp FILE> (NOT the inline JSON, which dies on the powershell argv hop) and returns true", () => {
    const { svc, spawned } = makeHeadlessService()
    // signature: createHeadless(name, cwd, sessionId, resumeConvId, allowedTools, model, effort, ultracode)
    const info = svc.createHeadless("t", process.cwd(), undefined, undefined, undefined, undefined, undefined, true)
    const joined = spawned[0].args.join(" ")
    expect(joined).toContain("--settings")
    // The flag points at a FILE; the raw inline JSON never reaches argv (that's the bug fix).
    expect(joined).toContain("ultracode-settings.json")
    expect(joined).not.toContain(ULTRACODE_SETTINGS)
    // The file exists with EXACTLY the ultracode payload.
    const settingsFile = join(tmpdir(), "claudetui", "ultracode-settings.json")
    expect(existsSync(settingsFile)).toBe(true)
    expect(readFileSync(settingsFile, "utf8")).toBe(`{"ultracode":true}`)
    expect(ULTRACODE_SETTINGS).toBe(`{"ultracode":true}`)
    expect(info.ultracode).toBe(true)
    expect(svc.list().find((t) => t.id === info.id)?.ultracode).toBe(true)
  })

  it("ultracode ON SUPPRESSES --effort even when an effort level is passed (ultracode forces xhigh; both is undefined)", () => {
    const { svc, spawned } = makeHeadlessService()
    const info = svc.createHeadless("t", process.cwd(), undefined, undefined, undefined, "opus", "high", true)
    const joined = spawned[0].args.join(" ")
    expect(joined).toContain("--settings")
    expect(joined).toContain("ultracode-settings.json")
    // --effort is NOT also passed when ultracode is on.
    expect(joined).not.toContain("--effort")
    expect(info.effort).toBeUndefined()
    expect(info.ultracode).toBe(true)
    // --model still coexists.
    expect(joined).toContain("--model opus")
  })

  it("ultracode ON suppresses the CONFIG default effort too (setEffort then ultracode → no --effort)", () => {
    const { svc, spawned } = makeHeadlessService()
    svc.setEffort("max")
    const info = svc.createHeadless("t", process.cwd(), undefined, undefined, undefined, undefined, undefined, true)
    expect(spawned[0].args.join(" ")).not.toContain("--effort")
    expect(spawned[0].args.join(" ")).toContain("ultracode-settings.json")
    expect(info.ultracode).toBe(true)
  })

  it("ultracode OFF with an effort level passes --effort and NOT --settings", () => {
    const { svc, spawned } = makeHeadlessService()
    const info = svc.createHeadless("t", process.cwd(), undefined, undefined, undefined, undefined, "high", false)
    const joined = spawned[0].args.join(" ")
    expect(joined).toContain("--effort high")
    expect(joined).not.toContain("--settings")
    expect(info.ultracode).toBe(false)
    expect(info.effort).toBe("high")
  })

  it("setUltracode(true) makes new terminals spawn WITH ultracode (the default posture)", () => {
    const { svc, spawned } = makeHeadlessService()
    svc.setUltracode(true)
    expect(svc.getUltracode()).toBe(true)
    const info = svc.createHeadless("t", process.cwd())
    expect(spawned[0].args.join(" ")).toContain("ultracode-settings.json")
    expect(info.ultracode).toBe(true)
  })

  it("an explicit per-terminal ultracode=false OVERRIDES the default-on posture", () => {
    const { svc, spawned } = makeHeadlessService()
    svc.setUltracode(true)
    const info = svc.createHeadless("t", process.cwd(), undefined, undefined, undefined, undefined, undefined, false)
    expect(spawned[0].args.join(" ")).not.toContain("--settings")
    expect(info.ultracode).toBe(false)
  })

  it("RESUME path: --resume <id> and --settings ultracode COEXIST (ultracode re-applied on every resume spawn)", () => {
    const root = mkdtempSync(join(tmpdir(), "capp108-resume-"))
    const cwd = process.cwd()
    const dir = join(root, encodeProjectDir(cwd))
    mkdirSync(dir, { recursive: true })
    const convId = "resume-capp108-1"
    writeFileSync(join(dir, `${convId}.jsonl`), "{}")

    const { svc, spawned } = makeHeadlessService()
    ;(svc as unknown as { ccProjectsRoot: string }).ccProjectsRoot = root
    svc.createHeadless("t", cwd, undefined, convId, undefined, undefined, undefined, true)

    const joined = spawned[0].args.join(" ")
    expect(joined).toContain(`--resume ${convId}`)
    expect(joined).toContain("ultracode-settings.json")
  })

  it("the xterm (legacy PTY) path does NOT pass --settings — byte-unchanged", () => {
    const { svc, ptys, procs } = makeDualService()
    svc.setEngine("xterm") // CAPP-39 gate ④ — xterm is no longer the default; opt in
    svc.setUltracode(true) // even with the default on, the xterm path ignores it
    svc.create("t", process.cwd())
    expect(procs).toHaveLength(0)
    expect(ptys[0].args.join(" ")).not.toContain("--settings")
    expect(ptys[0].args.join(" ")).not.toContain("ultracode")
  })

  it("engine=structured create() threads the ultracode arg through to the headless spawn", () => {
    const { svc, procs } = makeDualService()
    svc.setEngine("structured")
    const info = svc.create("t", process.cwd(), undefined, undefined, undefined, undefined, true)
    expect(procs[0].args.join(" ")).toContain("ultracode-settings.json")
    expect(info.ultracode).toBe(true)
  })

  it("CAPP-117: when the ultracode settings file can't be written (helper → null) the spawn OMITS --settings entirely (no dead terminal)", () => {
    const { svc, spawned } = makeHeadlessService()
    // Force the fs helper to fail; a spawn WITHOUT ultracode must beat a dead terminal.
    ;(svc as unknown as { ultracodeSettingsPath: () => string | null }).ultracodeSettingsPath = () => null
    const info = svc.createHeadless("t", process.cwd(), undefined, undefined, undefined, undefined, undefined, true)
    const joined = spawned[0].args.join(" ")
    expect(joined).not.toContain("--settings")
    // The terminal still spawns; the requested posture is recorded (the file write, not intent, failed).
    expect(info.ultracode).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// CAPP-108 — the modelSupportsXhigh helper that gates the ultracode toggle.
// ---------------------------------------------------------------------------

describe("CAPP-108 modelSupportsXhigh", () => {
  it("xhigh-capable models (opus / opus[1m] / fable-5) return true", () => {
    expect(modelSupportsXhigh("opus")).toBe(true)
    expect(modelSupportsXhigh("opus[1m]")).toBe(true)
    expect(modelSupportsXhigh("fable-5")).toBe(true)
    expect(modelSupportsXhigh("fable-5-20260101")).toBe(true)
    // Pinned opus ids pass by prefix.
    expect(modelSupportsXhigh("opus-4-8")).toBe(true)
  })

  it("non-xhigh models (sonnet / haiku) return false", () => {
    expect(modelSupportsXhigh("sonnet")).toBe(false)
    expect(modelSupportsXhigh("haiku")).toBe(false)
  })

  it("an empty/undefined model defaults to opus (DEFAULT_MODEL) → true (fresh terminal shows the toggle)", () => {
    expect(modelSupportsXhigh(undefined)).toBe(true)
    expect(modelSupportsXhigh("")).toBe(true)
    expect(modelSupportsXhigh("   ")).toBe(true)
    expect(DEFAULT_MODEL).toBe("opus")
  })

  it("is case-insensitive", () => {
    expect(modelSupportsXhigh("OPUS")).toBe(true)
    expect(modelSupportsXhigh("Sonnet")).toBe(false)
  })
})
