import { describe, it, expect, vi } from "vitest"
import {
  TerminalService,
  encodeProjectDir,
  resumeArgs,
  type PtyLike,
  type SpawnPty,
  type SpawnPtyOptions,
  type SpawnProc,
  type TerminalEvent,
} from "./terminals"

/**
 * A fake PTY: conforms to `PtyLike` but has NO real process behind it. Records
 * its spawn args (so tests can assert `--resume` / `--mcp-config` behavior) and
 * exposes `emitData` / `emitExit` to drive the service's listeners by hand.
 */
class FakePty implements PtyLike {
  pid = Math.floor(Math.random() * 1_000_000)
  cols: number
  rows: number
  killed = false
  written: string[] = []
  private dataCbs: Array<(data: string) => void> = []
  private exitCbs: Array<(e: { exitCode: number; signal?: number }) => void> = []

  constructor(
    readonly file: string,
    readonly args: string[],
    readonly options: SpawnPtyOptions,
  ) {
    this.cols = options.cols
    this.rows = options.rows
  }

  onData(cb: (data: string) => void): void {
    this.dataCbs.push(cb)
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitCbs.push(cb)
  }
  write(data: string): void {
    this.written.push(data)
  }
  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
  }
  kill(): void {
    this.killed = true
  }

  /** Test helper: simulate the PTY emitting output. */
  emitData(data: string): void {
    for (const cb of this.dataCbs) cb(data)
  }
  /** Test helper: simulate the PTY's process exiting. */
  emitExit(exitCode = 0): void {
    for (const cb of this.exitCbs) cb({ exitCode })
  }
}

/**
 * The ONE way to construct a TerminalService in tests. Injects a fake spawn seam
 * so no real `powershell → claude` process is ever launched (the P1-6 leak), and
 * returns the recorded `FakePty` instances so a test can inspect spawn args or
 * drive data/exit. Every `new TerminalService()` in tests goes through here.
 */
function makeTestTerminalService(): { svc: TerminalService; spawned: FakePty[] } {
  const spawned: FakePty[] = []
  const spawnPty: SpawnPty = (file, args, options) => {
    const fake = new FakePty(file, args, options)
    spawned.push(fake)
    return fake
  }
  return { svc: new TerminalService({ spawnPty }), spawned }
}

describe("TerminalService emit channels (terminal:* not session:*)", () => {
  it("emits terminal:created on create()", () => {
    const { svc } = makeTestTerminalService()
    const sent: string[] = []
    // Override sendToRenderer before any operation so all emits are captured
    ;(svc as unknown as { sendToRenderer: (c: string, ...a: unknown[]) => void }).sendToRenderer =
      (channel) => { sent.push(channel) }

    svc.create("t", process.cwd())

    expect(sent).toContain("terminal:created")
    expect(sent.some((c) => c.startsWith("session:"))).toBe(false)
  })

  it("emits terminal:state (idle) via the idle monitor when mainWindow is set", () => {
    vi.useFakeTimers()
    const { svc } = makeTestTerminalService()
    const sent: string[] = []
    ;(svc as unknown as { sendToRenderer: (c: string, ...a: unknown[]) => void }).sendToRenderer =
      (channel) => { sent.push(channel) }

    svc.create("t", process.cwd())
    // Start the idle monitor directly (normally started by setMainWindow)
    ;(svc as unknown as { startIdleMonitor: () => void }).startIdleMonitor()
    // Advance past idle threshold (1500ms) + one timer tick (1000ms)
    vi.advanceTimersByTime(3000)

    expect(sent).toContain("terminal:state")
    expect(sent.some((c) => c.startsWith("session:"))).toBe(false)

    vi.useRealTimers()
  })

  it("emits terminal:renamed when rename() is called", () => {
    const { svc } = makeTestTerminalService()
    const sent: string[] = []
    ;(svc as unknown as { sendToRenderer: (c: string, ...a: unknown[]) => void }).sendToRenderer =
      (channel) => { sent.push(channel) }

    const info = svc.create("t", process.cwd())
    // clear earlier channels; we only care about rename here
    sent.length = 0
    svc.rename(info.id, "new-name")
    expect(sent).toContain("terminal:renamed")
    expect(sent.some((c) => c.startsWith("session:"))).toBe(false)
  })
})

describe("TerminalService.rename — headless (CAPP-81 regression)", () => {
  // A headless (structured) terminal lives in `this.headless`, not `this.terminals`.
  // The old rename() only checked the PTY registry and silently returned false for a
  // headless tab — never updating the name, never emitting terminal:renamed — so the
  // tab snapped back. rename() now checks headless FIRST (mirroring kill()/write()).
  function makeHeadless(): { svc: TerminalService; sent: Array<{ channel: string; args: unknown[] }> } {
    const spawnProc: SpawnProc = (file, args, options) => {
      void file; void args; void options
      return {
        pid: 1,
        onStdout() {},
        onStderr() {},
        onExit() {},
        onError() {},
        write() {},
        kill() {},
      }
    }
    const svc = new TerminalService({ spawnProc })
    const sent: Array<{ channel: string; args: unknown[] }> = []
    ;(svc as unknown as { sendToRenderer: (c: string, ...a: unknown[]) => void }).sendToRenderer =
      (channel, ...args) => { sent.push({ channel, args }) }
    return { svc, sent }
  }

  it("renames a HEADLESS terminal: updates the name, emits terminal:renamed, returns true", () => {
    const { svc, sent } = makeHeadless()
    const events: TerminalEvent[] = []
    svc.onEvent((e) => events.push(e))

    const info = svc.createHeadless("orig", process.cwd())
    sent.length = 0
    events.length = 0

    const ok = svc.rename(info.id, "renamed-headless")
    expect(ok).toBe(true)

    // sendToRenderer fired terminal:renamed with the new name
    const renamed = sent.find((s) => s.channel === "terminal:renamed")
    expect(renamed).toBeDefined()
    expect(renamed!.args).toEqual([info.id, "renamed-headless"])

    // emitEvent fired the renamed event too (the seam SessionService folds into the ref)
    expect(events).toContainEqual({ type: "renamed", id: info.id, name: "renamed-headless" })

    // the name is reflected on the live list() entry
    expect(svc.list().find((t) => t.id === info.id)?.name).toBe("renamed-headless")
  })

  it("returns false for an unknown id (neither PTY nor headless)", () => {
    const { svc } = makeHeadless()
    expect(svc.rename("does-not-exist", "x")).toBe(false)
  })
})

describe("TerminalService.onEvent", () => {
  it("notifies listeners on created and exit, and unsubscribes cleanly", () => {
    const { svc } = makeTestTerminalService()
    const events: any[] = []
    const off = svc.onEvent((e) => events.push(e))

    const info = svc.create("t", process.cwd())
    expect(events.some((e) => e.type === "created" && e.info.id === info.id)).toBe(true)

    off()
    const before = events.length
    svc.kill(info.id)
    expect(events.length).toBe(before)
  })

  it("registers a transcript expectation on create and cancels it on kill", () => {
    vi.useFakeTimers()
    const { svc } = makeTestTerminalService()
    // Point the assigner at an empty fake projects root so it never binds a real
    // transcript and the shared loop's lifecycle is what we observe.
    const root = mkdtempSync(join(tmpdir(), "cc-svc-"))
    ;(svc as unknown as { ccProjectsRoot: string }).ccProjectsRoot = root

    const info = svc.create("t", process.cwd())
    const assigner = (svc as unknown as {
      assigner: { pendingCount(): number; isRunning(): boolean }
    }).assigner
    // create() registered exactly one expectation and started the shared loop.
    expect(assigner.pendingCount()).toBe(1)
    expect(assigner.isRunning()).toBe(true)

    const events: string[] = []
    svc.onEvent((e) => events.push(e.type))
    svc.kill(info.id)

    // Expectation cancelled, loop idle, and no convo ever fires post-kill.
    expect(assigner.pendingCount()).toBe(0)
    expect(assigner.isRunning()).toBe(false)
    vi.advanceTimersByTime(5000)
    expect(events).not.toContain("convo")
    vi.useRealTimers()
  })

  it("pre-claims and emits convo immediately for a resumed terminal (no expectation)", () => {
    vi.useFakeTimers()
    const cwd = process.cwd()
    const root = mkdtempSync(join(tmpdir(), "cc-resume-svc-"))
    const dir = join(root, encodeProjectDir(cwd))
    mkdirSync(dir, { recursive: true })
    // The transcript must exist on disk so resumeArgs() adds --resume.
    const convId = "resume-abc"
    writeFileSync(join(dir, `${convId}.jsonl`), "{}")

    const { svc } = makeTestTerminalService()
    ;(svc as unknown as { ccProjectsRoot: string }).ccProjectsRoot = root

    const convos: string[] = []
    svc.onEvent((e) => { if (e.type === "convo") convos.push(e.ccConversationId) })

    const info = svc.create("t", cwd, undefined, convId)
    // Resumed terminals re-emit their id immediately and pre-claim it; they do
    // NOT register a polling expectation.
    expect(convos).toEqual([convId])
    const assigner = (svc as unknown as {
      assigner: { pendingCount(): number }
    }).assigner
    expect(assigner.pendingCount()).toBe(0)
    expect(
      (svc as unknown as { claimedConvoIds: Set<string> }).claimedConvoIds.has(convId),
    ).toBe(true)

    svc.kill(info.id)
    vi.useRealTimers()
  })
})

describe("encodeProjectDir", () => {
  it("encodes a Windows cwd the way Claude Code does", () => {
    expect(encodeProjectDir("C:\\Users\\ryguy\\projects\\claude-tui-app")).toBe(
      "C--Users-ryguy-projects-claude-tui-app",
    )
  })

  it("encodes a POSIX cwd", () => {
    expect(encodeProjectDir("/home/ryguy/projects/app")).toBe("-home-ryguy-projects-app")
  })
})

import { resolveTranscriptId, listTranscriptIds } from "./terminals"
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("resolveTranscriptId", () => {
  it("returns the newest .jsonl id created at/after spawnedAt", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-projects-"))
    const cwd = "C:\\fake\\repo"
    const dir = join(root, encodeProjectDir(cwd))
    mkdirSync(dir, { recursive: true })

    const oldId = "11111111-1111-1111-1111-111111111111"
    const newId = "22222222-2222-2222-2222-222222222222"
    writeFileSync(join(dir, `${oldId}.jsonl`), "{}")
    writeFileSync(join(dir, `${newId}.jsonl`), "{}")

    const spawnedAt = Date.now()
    const past = (spawnedAt - 60_000) / 1000
    const future = (spawnedAt + 1_000) / 1000
    utimesSync(join(dir, `${oldId}.jsonl`), past, past)
    utimesSync(join(dir, `${newId}.jsonl`), future, future)

    expect(resolveTranscriptId(root, cwd, spawnedAt)).toBe(newId)
  })

  it("returns undefined when no transcript is new enough", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-projects-"))
    const cwd = "C:\\fake\\repo2"
    const dir = join(root, encodeProjectDir(cwd))
    mkdirSync(dir, { recursive: true })
    const id = "33333333-3333-3333-3333-333333333333"
    writeFileSync(join(dir, `${id}.jsonl`), "{}")
    const past = (Date.now() - 60_000) / 1000
    utimesSync(join(dir, `${id}.jsonl`), past, past)
    expect(resolveTranscriptId(root, cwd, Date.now())).toBeUndefined()
  })

  it("excludes transcripts that already existed at spawn (sibling in same cwd)", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-projects-"))
    const cwd = "C:\\fake\\shared"
    const dir = join(root, encodeProjectDir(cwd))
    mkdirSync(dir, { recursive: true })

    // A sibling terminal's transcript, already on disk and freshly written.
    const siblingId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    writeFileSync(join(dir, `${siblingId}.jsonl`), "{}")

    const spawnedAt = Date.now()
    // Snapshot taken at our spawn — sibling is present.
    const preexisting = listTranscriptIds(root, cwd)
    expect(preexisting.has(siblingId)).toBe(true)

    // Sibling keeps streaming AFTER we spawned (newest mtime), but it's excluded.
    const future = (spawnedAt + 2_000) / 1000
    utimesSync(join(dir, `${siblingId}.jsonl`), future, future)

    // Without exclusion the sibling would win; with it, nothing new yet.
    expect(resolveTranscriptId(root, cwd, spawnedAt, preexisting)).toBeUndefined()

    // Now OUR transcript appears — it's not in the snapshot, so we bind to it.
    const ourId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    writeFileSync(join(dir, `${ourId}.jsonl`), "{}")
    const ourTime = (spawnedAt + 3_000) / 1000
    utimesSync(join(dir, `${ourId}.jsonl`), ourTime, ourTime)
    expect(resolveTranscriptId(root, cwd, spawnedAt, preexisting)).toBe(ourId)
  })
})

describe("resumeArgs", () => {
  it("adds --resume when the transcript still exists", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-resume-"))
    const cwd = "C:\\fake\\r"
    const dir = join(root, encodeProjectDir(cwd))
    mkdirSync(dir, { recursive: true })
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    writeFileSync(join(dir, `${id}.jsonl`), "{}")
    expect(resumeArgs(root, cwd, id)).toEqual(["--resume", id])
  })

  it("returns [] when the id is missing", () => {
    expect(resumeArgs(mkdtempSync(join(tmpdir(), "cc-r2-")), "C:\\x", undefined)).toEqual([])
  })

  it("returns [] when the transcript file is gone", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-r3-"))
    expect(resumeArgs(root, "C:\\x", "dead-id")).toEqual([])
  })
})

describe("TerminalService MCP identity tokens", () => {
  /** Pull the token query param out of a terminal's generated MCP config file. */
  const tokenFromConfig = (terminalId: string): string | null => {
    const path = join(tmpdir(), "claudetui", `mcp-config-${terminalId}.json`)
    const cfg = JSON.parse(require("fs").readFileSync(path, "utf8"))
    const url = new URL(cfg.mcpServers.claudetui.url)
    return url.searchParams.get("token")
  }

  it("resolveIdentityToken returns undefined for an unknown token", () => {
    const { svc } = makeTestTerminalService()
    expect(svc.resolveIdentityToken("garbage")).toBeUndefined()
  })

  it("issueIdentityToken mints a token that resolves to exactly its own ids", () => {
    const { svc } = makeTestTerminalService()
    const token = svc.issueIdentityToken("sess-1", "term-1")
    expect(typeof token).toBe("string")
    expect(token.length).toBeGreaterThan(0)
    expect(svc.resolveIdentityToken(token)).toEqual({
      sessionId: "sess-1",
      terminalId: "term-1",
    })
  })

  it("issues unique tokens for distinct terminals", () => {
    const { svc } = makeTestTerminalService()
    const a = svc.issueIdentityToken("sess-1", "term-1")
    const b = svc.issueIdentityToken("sess-1", "term-2")
    expect(a).not.toBe(b)
    expect(svc.resolveIdentityToken(a)).toEqual({ sessionId: "sess-1", terminalId: "term-1" })
    expect(svc.resolveIdentityToken(b)).toEqual({ sessionId: "sess-1", terminalId: "term-2" })
  })

  it("mcpConfigFor URL carries a token that resolves to the terminal's own ids", () => {
    const { svc } = makeTestTerminalService()
    svc.setMcpServerUrl("http://127.0.0.1:9999/sse")
    const info = svc.create("t", process.cwd(), "sess-abc")

    const token = tokenFromConfig(info.id)
    expect(token).toBeTruthy()
    expect(svc.resolveIdentityToken(token!)).toEqual({
      sessionId: "sess-abc",
      terminalId: info.id,
    })

    svc.kill(info.id)
  })

  it("invalidates the token on kill so a stale config can't resurrect identity", () => {
    const { svc } = makeTestTerminalService()
    svc.setMcpServerUrl("http://127.0.0.1:9999/sse")
    const info = svc.create("t", process.cwd(), "sess-kill")
    const token = tokenFromConfig(info.id)
    expect(svc.resolveIdentityToken(token!)).toBeTruthy()

    svc.kill(info.id)
    expect(svc.resolveIdentityToken(token!)).toBeUndefined()
  })

  it("clears all tokens on killAll", () => {
    const { svc } = makeTestTerminalService()
    const token = svc.issueIdentityToken("sess-1", "term-1")
    expect(svc.resolveIdentityToken(token)).toBeTruthy()
    svc.killAll()
    expect(svc.resolveIdentityToken(token)).toBeUndefined()
  })
})

describe("TerminalService spawn seam (FakePty — no real process)", () => {
  it("spawns via the injected seam, never a real pty (records the powershell wrapper)", () => {
    const { svc, spawned } = makeTestTerminalService()
    svc.create("t", process.cwd())
    // Exactly one fake PTY was created — and it is a FakePty, not a real process.
    expect(spawned).toHaveLength(1)
    const fake = spawned[0]
    // On every platform we shell-wrap the command; the file is the shell.
    expect(fake.file).toMatch(/powershell\.exe|bash/)
    // The wrapped command always carries the claude default args.
    expect(fake.args.join(" ")).toContain("--dangerously-skip-permissions")
  })

  it("records --mcp-config in the spawned args when a server URL + session id are set", () => {
    const { svc, spawned } = makeTestTerminalService()
    svc.setMcpServerUrl("http://127.0.0.1:9999/sse")
    svc.create("t", process.cwd(), "sess-1")
    expect(spawned[0].args.join(" ")).toContain("--mcp-config")
  })

  it("records --resume <id> in the spawned args when resuming an existing transcript", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-seam-resume-"))
    const cwd = process.cwd()
    const dir = join(root, encodeProjectDir(cwd))
    mkdirSync(dir, { recursive: true })
    const convId = "resume-abc"
    writeFileSync(join(dir, `${convId}.jsonl`), "{}")

    const { svc, spawned } = makeTestTerminalService()
    ;(svc as unknown as { ccProjectsRoot: string }).ccProjectsRoot = root
    svc.create("t", cwd, undefined, convId)

    // This is exactly the spawn that leaked a real `claude --resume resume-abc`
    // before the seam — now it's captured by the fake, no OS process.
    expect(spawned[0].args.join(" ")).toContain(`--resume ${convId}`)
  })

  it("emitData drives capture/state and emitExit marks the terminal dead — all in-process", () => {
    const { svc, spawned } = makeTestTerminalService()
    const info = svc.create("t", process.cwd())
    const fake = spawned[0]

    fake.emitData("● Edit(src/App.tsx)\n")
    expect(svc.getOutput(info.id)).toContain("Edit(src/App.tsx)")

    const events: string[] = []
    svc.onEvent((e) => events.push(e.type))
    fake.emitExit(0)
    expect(events).toContain("exit")
    expect(svc.list().find((t) => t.id === info.id)?.state).toBe("dead")
  })
})

describe("TerminalService.list() carries isLogin (CAPP-54 gate ② BLOCKER)", () => {
  // The re-review BLOCKER: list() rebuilds plain return objects and previously did
  // NOT copy isLogin, so BroadcastService's `.filter(s => !s.isLogin)` was a no-op in
  // production (the field was always undefined) — the live `claude /login` OAuth PTY
  // stayed a valid broadcast target. This DIRECT test on list() is the one that would
  // have caught it: it drives the real service (no stub) and asserts the flag survives.
  it("a login terminal's entry carries isLogin===true; a normal terminal's does not", () => {
    const { svc } = makeTestTerminalService()
    const normal = svc.create("agent", process.cwd())
    const login = svc.createLogin("Sign in", process.cwd())

    const list = svc.list()
    const normalEntry = list.find((t) => t.id === normal.id)
    const loginEntry = list.find((t) => t.id === login.id)

    expect(loginEntry?.isLogin).toBe(true)
    // The normal terminal is NOT a login terminal — falsy (undefined), never true.
    expect(normalEntry?.isLogin).not.toBe(true)
  })

  it("getActivity() also surfaces isLogin for the login terminal (FIX C consistency)", () => {
    const { svc } = makeTestTerminalService()
    const normal = svc.create("agent", process.cwd())
    const login = svc.createLogin("Sign in", process.cwd())

    const activity = svc.getActivity()
    expect(activity.find((a) => a.id === login.id)?.isLogin).toBe(true)
    expect(activity.find((a) => a.id === normal.id)?.isLogin).not.toBe(true)
  })
})

import { parseActivityLine } from "./terminals"

describe("parseActivityLine", () => {
  it("extracts the last tool-call line", () => {
    const out = [
      "some chatter",
      "● Read(electron/services/sessions.ts)",
      "more text",
      "● Edit(electron/services/terminals.ts)",
      "tail",
    ].join("\n")
    expect(parseActivityLine(out)).toBe("Edit(electron/services/terminals.ts)")
  })

  it("returns undefined when there is no tool-call line", () => {
    expect(parseActivityLine("just\nplain\ntext")).toBeUndefined()
  })

  it("matches tool calls but not prose bullets", () => {
    expect(parseActivityLine("● Edit(src/App.tsx)")).toBe("Edit(src/App.tsx)")
    expect(parseActivityLine("● Bash(npm test)")).toBe("Bash(npm test)")
    // prose bullets / markdown lists must NOT match
    expect(parseActivityLine("* this is a note (with parens)")).toBeUndefined()
    expect(parseActivityLine("● note about something (no tool)")).toBeUndefined()
  })
})

import { detectPromptState } from "./terminals"

/**
 * Fixtures seeded from real Claude Code idle/busy output (AQ-1). The input box
 * renders as a bordered `>` prompt above a footer hint line; a busy session shows
 * tool-call activity lines and no bare prompt. These strings are ANSI-stripped,
 * matching what TerminalService captures into its output buffer.
 */
describe("detectPromptState", () => {
  // FIXTURE 1: idle, sitting at the prompt (the canonical "asked you" case).
  const PROMPT_IDLE = [
    "● Done. The refactor is complete and tests pass.",
    "",
    "╭──────────────────────────────────────────────────╮",
    "│ >                                                │",
    "╰──────────────────────────────────────────────────╯",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n")

  // FIXTURE 2: busy — a tool-call activity line, no prompt box.
  const BUSY_WITH_ACTIVITY = [
    "● Edit(electron/services/terminals.ts)",
    "  ⎿ Updated electron/services/terminals.ts with 12 additions",
    "● Bash(npm test)",
    "  ⎿ Running…",
  ].join("\n")

  // FIXTURE 3: mid-output — prose containing a `>` (a quoted shell line) but no
  // footer hint, so it must NOT be read as a prompt.
  const MID_OUTPUT = [
    "Here's the command you should run:",
    "  > git push origin main",
    "and then check the CI dashboard.",
  ].join("\n")

  // FIXTURE 4: empty buffer.
  const EMPTY = ""

  it("detects the idle prompt (prompt box + footer hint)", () => {
    expect(detectPromptState(PROMPT_IDLE)).toBe(true)
  })

  it("does not fire on a busy session with activity lines", () => {
    expect(detectPromptState(BUSY_WITH_ACTIVITY)).toBe(false)
  })

  it("does not fire on mid-output prose that merely contains a '>'", () => {
    expect(detectPromptState(MID_OUTPUT)).toBe(false)
  })

  it("does not fire on empty output", () => {
    expect(detectPromptState(EMPTY)).toBe(false)
  })

  it("requires BOTH the prompt box and the footer hint", () => {
    // Footer hint alone (no empty prompt box) — not idle-at-prompt.
    const footerOnly = ["working...", "  ⏵⏵ bypass permissions on (shift+tab to cycle)", "● Read(x)"].join("\n")
    expect(detectPromptState(footerOnly)).toBe(false)
    // Prompt box alone (no footer) — not enough either.
    const boxOnly = ["│ > │"].join("\n")
    expect(detectPromptState(boxOnly)).toBe(false)
  })
})
