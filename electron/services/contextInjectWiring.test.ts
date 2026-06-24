import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  TerminalService,
  encodeProjectDir,
  type ProcLike,
  type SpawnProc,
  type SpawnProcOptions,
  type PtyLike,
  type SpawnPty,
  type SpawnPtyOptions,
} from "./terminals"
import { SessionService } from "./sessions"
import { WorkspaceMemoryService } from "./workspaceMemory"
import { RecallService } from "./recall"
import { buildInjectedContext, type InjectWorkspaceFinding } from "./contextInject"

vi.mock("../log", () => ({ logWarn: vi.fn(), logError: vi.fn() }))

/**
 * CAPP-96 — END-TO-END wiring (hermetic): the SAME closure ipc.ts installs, exercised
 * through TerminalService's injected fake spawn. Pins the load-bearing scope rule
 * (workspace tier sourced from the SPAWNING session's workspaceId, NEVER getActiveId), the
 * file-backed --append-system-prompt-file flag, and the fresh-vs-resume distinction.
 */

class FakeProc implements ProcLike {
  pid = 1
  written: string[] = []
  constructor(readonly file: string, readonly args: string[], readonly options: SpawnProcOptions) {}
  onStdout(): void {}
  onStderr(): void {}
  onExit(): void {}
  onError(): void {}
  write(d: string): void {
    this.written.push(d)
  }
  kill(): void {}
}

let homeDir: string
let spawned: FakeProc[]
let terminals: TerminalService
let sessions: SessionService
let memory: WorkspaceMemoryService
let recall: RecallService
let activeWorkspace: string | undefined

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "capp96-"))
  spawned = []
  activeWorkspace = undefined
  const spawnProc: SpawnProc = (file, args, options) => {
    const p = new FakeProc(file, args, options)
    spawned.push(p)
    return p
  }
  terminals = new TerminalService({ spawnProc, contextDir: join(homeDir, ".claude-tui", "context") })
  // Point the resume-transcript lookup at the temp home (the DI cast tests use).
  ;(terminals as unknown as { ccProjectsRoot: string }).ccProjectsRoot = join(
    homeDir,
    ".claude",
    "projects",
  )
  sessions = new SessionService({
    dir: join(homeDir, ".claude-tui", "sessions"),
    getActiveWorkspaceId: () => activeWorkspace,
  })
  sessions.attachTerminals(terminals)
  memory = new WorkspaceMemoryService({ dir: join(homeDir, ".claude-tui", "workspace-memory") })
  recall = new RecallService(
    () => sessions.list(),
    () => memory.listWorkspaceMemory(),
  )

  // The exact builder ipc.ts installs (scope off the SPAWNING session's workspaceId).
  terminals.setContextBuilder((sessionId, { resume }) => {
    if (resume) return buildInjectedContext({ instructions: "", workspaceFindings: [] }, { resume: true })
    if (!sessionId) return ""
    const workspaceId = sessions.workspaceIdOf(sessionId)
    const mem = memory.getMemory(workspaceId ?? null)
    const workspaceFindings: InjectWorkspaceFinding[] = recall
      .workspaceTierEntries(workspaceId)
      .map((e) => ({
        text: e.text,
        status: e.status === "ruled-out" ? "ruled-out" : "active",
        ...(e.correction ? { correction: e.correction } : {}),
        createdAt: e.createdAt,
        ...(e.pinned ? { pinned: true } : {}),
      }))
    const session = sessions.getSessionContextSections(sessionId)
    return buildInjectedContext({ instructions: mem.instructions, workspaceFindings, session })
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    rmSync(homeDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

/** The path arg of the --append-system-prompt-file flag in a spawn's args, or undefined. */
function injectedFile(p: FakeProc): string | undefined {
  const joined = p.args.join(" ")
  const m = joined.match(/--append-system-prompt-file ('?)([^'\s]+)\1/)
  return m?.[2]
}

describe("CAPP-96 wiring — file-backed inject + scope", () => {
  it("scopes the workspace tier off the SPAWNING session's workspaceId, NOT the active selection", () => {
    // Create a session bound to ws-A (active = A at mint time)…
    activeWorkspace = "ws-A"
    const s = sessions.create()
    expect(sessions.workspaceIdOf(s.id)).toBe("ws-A")

    // …then flip the ACTIVE workspace to B. Seed memory for BOTH.
    activeWorkspace = "ws-B"
    memory.addFinding("ws-A", "WORKSPACE-A FINDING about the auth module", "user")
    memory.addFinding("ws-B", "WORKSPACE-B FINDING about billing", "user")
    recall.invalidate()

    terminals.createHeadless("t", homeDir, s.id)
    const body = readFileSync(injectedFile(spawned.at(-1)!)!, "utf8")
    // The session belongs to A → A's brain is injected even though B is active.
    expect(body).toContain("WORKSPACE-A FINDING")
    expect(body).not.toContain("WORKSPACE-B FINDING")
  })

  it("writes the payload file + adds --append-system-prompt-file on a FRESH spawn", () => {
    activeWorkspace = "ws-A"
    const s = sessions.create()
    memory.setInstructions("ws-A", "Always run the gate before commit.")
    recall.invalidate()
    sessions.addNote(s.id, "Tokens live in cookies")

    terminals.createHeadless("t", homeDir, s.id)
    const file = injectedFile(spawned.at(-1)!)
    expect(file).toBeTruthy()
    expect(existsSync(file!)).toBe(true)
    const body = readFileSync(file!, "utf8")
    expect(body).toContain("# Context for this session")
    expect(body).toContain("Always run the gate before commit.")
    expect(body).toContain("Tokens live in cookies")
  })

  it("injects only the SHORT pointer on a RESUME spawn", () => {
    activeWorkspace = "ws-A"
    const s = sessions.create()
    memory.setInstructions("ws-A", "lots of standing context")
    recall.invalidate()
    sessions.addNote(s.id, "a big finding")

    // A resume spawn passes a resumeConvId whose transcript EXISTS → resumeArgs returns
    // --resume → resume=true. Fabricate the transcript file so resumeArgs sees it.
    const convId = "conv-123"
    const projDir = join(homeDir, ".claude", "projects", encodeProjectDir(homeDir))
    mkdirSync(projDir, { recursive: true })
    writeFileSync(join(projDir, `${convId}.jsonl`), "{}")

    terminals.createHeadless("t", homeDir, s.id, convId)
    const proc = spawned.at(-1)!
    expect(proc.args.join(" ")).toContain("--resume")
    const body = readFileSync(injectedFile(proc)!, "utf8")
    expect(body).toContain("Durable context may have changed")
    expect(body).not.toContain("lots of standing context")
    expect(body).not.toContain("a big finding")
  })

  it("adds NO flag when the builder yields an empty payload (nothing durable)", () => {
    activeWorkspace = "ws-A"
    const s = sessions.create()
    terminals.createHeadless("t", homeDir, s.id)
    expect(spawned.at(-1)!.args.join(" ")).not.toContain("--append-system-prompt-file")
  })

  it("the xterm path also writes the inject file + adds the flag", () => {
    activeWorkspace = "ws-A"
    const s = sessions.create()
    // A minimal PtyLike fake that records the spawn args.
    const xtermSpawned: { file: string; args: string[] }[] = []
    const spawnPty: SpawnPty = (file, args, _options: SpawnPtyOptions): PtyLike => {
      xtermSpawned.push({ file, args })
      return {
        pid: 1,
        cols: 80,
        rows: 24,
        onData() {},
        onExit() {},
        write() {},
        resize() {},
        kill() {},
      }
    }
    const xtermSvc = new TerminalService({
      spawnPty,
      contextDir: join(homeDir, ".claude-tui", "context"),
    })
    xtermSvc.setContextBuilder(() =>
      buildInjectedContext({ instructions: "an xterm standing instruction", workspaceFindings: [] }),
    )
    xtermSvc.createXterm("t", homeDir, s.id)
    expect(xtermSpawned.at(-1)!.args.join(" ")).toContain("--append-system-prompt-file")
  })
})
