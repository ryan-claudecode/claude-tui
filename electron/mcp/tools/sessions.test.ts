import { describe, it, expect, vi } from "vitest"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { registerSessionTools } from "./sessions"
import {
  TerminalService,
  type ProcLike,
  type SpawnProc,
  type PtyLike,
  type SpawnPty,
} from "../../services/terminals"
import { SessionService } from "../../services/sessions"
import type { AttentionService } from "../../services/attention"
import type { WorkspaceService } from "../../services/workspaces"

// Keep headless stderr warnings out of the real log dir.
vi.mock("../../log", () => ({ logWarn: vi.fn(), logError: vi.fn() }))

function fakeProc(): ProcLike {
  return { pid: 1, onStdout: () => {}, onStderr: () => {}, onExit: () => {}, write: () => {}, kill: () => {} }
}

/** A no-op PTY that records writes — enough to prove the legacy /handoff fires. */
class FakePty implements PtyLike {
  pid = 7
  cols = 80
  rows = 24
  written: string[] = []
  constructor(readonly file: string, readonly args: string[], readonly options: any) {}
  onData(): void {}
  onExit(): void {}
  write(d: string): void {
    this.written.push(d)
  }
  resize(): void {}
  kill(): void {}
}

function makeTerminals(): { svc: TerminalService; ptys: FakePty[] } {
  const ptys: FakePty[] = []
  const spawnProc: SpawnProc = () => fakeProc()
  const spawnPty: SpawnPty = (file, args, options) => {
    const f = new FakePty(file, args, options)
    ptys.push(f)
    return f
  }
  const svc = new TerminalService({ spawnProc, spawnPty })
  // CAPP-39 gate ④ — the DEFAULT engine is now "structured". This factory's xterm-path
  // tests (the legacy /handoff fire, the WS-G create_session cwd assertions) call
  // create() and assert on the recorded FakePty (`ptys[0]`), so pin "xterm" to PRESERVE
  // that intent; the structured tests below still flip it explicitly via setEngine.
  svc.setEngine("xterm")
  return { svc, ptys }
}

/** A fake McpServer capturing registered tool handlers by name. */
function fakeServer() {
  const handlers: Record<string, (a: any) => Promise<{ content: Array<{ type: string; text: string }> }>> = {}
  const server = {
    tool: (name: string, _d: string, _s: unknown, h: (a: any) => any) => {
      handlers[name] = h
    },
  }
  return { server, handlers }
}

/** Minimal fake WorkspaceService — create_session only ever reads the active
 *  workspace dir off it. `activeDir` controls what getActiveWorkspaceDir returns. */
function fakeWorkspaces(activeDir: string | null = null): WorkspaceService {
  return { getActiveWorkspaceDir: () => activeDir } as unknown as WorkspaceService
}

function register(
  terminals: TerminalService,
  work: SessionService,
  workspaces: WorkspaceService = fakeWorkspaces(),
) {
  const { server, handlers } = fakeServer()
  registerSessionTools(
    server as any,
    terminals,
    {} as unknown as AttentionService,
    work,
    workspaces,
  )
  return handlers
}

describe("trigger_handoff MCP routing (BO-4a punch-list c)", () => {
  it("a STRUCTURED terminal routes to the durable retire-&-continue (not a silent no-op)", async () => {
    const { svc: terminals } = makeTerminals()
    terminals.setEngine("structured")
    const work = new SessionService({ dir: mkdtempSync(join(tmpdir(), "bo4a-handoff-")) })
    work.attachTerminals(terminals)
    const { session, terminalId } = work.openSession(process.cwd())
    expect(terminals.isHeadless(terminalId)).toBe(true)

    const handlers = register(terminals, work)
    const res = await handlers["trigger_handoff"]({ id: terminalId })

    // The structured branch ran handoffTerminal: a fresh structured terminal took
    // over; the old one was retired (no longer a live headless terminal).
    expect(res.content[0].text).toMatch(/continued in terminal/i)
    expect(terminals.isHeadless(terminalId)).toBe(false)
    const refs = work.get(session.id)!.terminals
    // BO-4b: the fresh structured replacement is parked IDLE on spawn (awaiting the
    // first message / context inheritance), not "active" — it's live, just not yet
    // working. The retired terminal is dead.
    const replacement = refs.find((t) => t.id !== terminalId)
    expect(replacement?.lastState).toBe("idle")
    expect(replacement?.engine).toBe("structured")
    expect(refs.find((t) => t.id === terminalId)?.lastState).toBe("dead")
  })

  it("an unregistered structured terminal reports it can't hand off (no silent success)", async () => {
    const { svc: terminals } = makeTerminals()
    const head = terminals.createHeadless("orphan", process.cwd()) // not in any work session
    const work = new SessionService({ dir: mkdtempSync(join(tmpdir(), "bo4a-handoff-")) })
    const handlers = register(terminals, work)
    const res = await handlers["trigger_handoff"]({ id: head.id })
    expect(res.content[0].text).toMatch(/isn't registered in a work session/i)
  })

  it("an XTERM terminal still fires the legacy /handoff (unchanged)", async () => {
    const { svc: terminals, ptys } = makeTerminals() // makeTerminals pins engine = xterm (CAPP-39 gate ④)
    const info = terminals.create("t", process.cwd())
    const work = new SessionService({ dir: mkdtempSync(join(tmpdir(), "bo4a-handoff-")) })
    const handlers = register(terminals, work)
    const res = await handlers["trigger_handoff"]({ id: info.id })
    expect(res.content[0].text).toBe("Handoff triggered")
    expect(ptys[0].written.join("")).toContain("/handoff")
  })
})

describe("create_session MCP — active workspace dir default (WS-G parity with the renderer path)", () => {
  it("with NO explicit cwd, defaults the session cwd to the active workspace dir", async () => {
    const { svc: terminals, ptys } = makeTerminals()
    const work = new SessionService({ dir: mkdtempSync(join(tmpdir(), "ws-g-create-")) })
    const handlers = register(terminals, work, fakeWorkspaces("/ws/active"))
    const res = await handlers["create_session"]({})
    // The created terminal spawned in the active workspace dir.
    const info = JSON.parse(res.content[0].text)
    expect(info.cwd).toBe("/ws/active")
    expect(ptys[0].options.cwd).toBe("/ws/active")
  })

  it("an EXPLICIT cwd always wins over the active workspace dir", async () => {
    const { svc: terminals } = makeTerminals()
    const work = new SessionService({ dir: mkdtempSync(join(tmpdir(), "ws-g-create-")) })
    const handlers = register(terminals, work, fakeWorkspaces("/ws/active"))
    const res = await handlers["create_session"]({ cwd: "/explicit/dir" })
    expect(JSON.parse(res.content[0].text).cwd).toBe("/explicit/dir")
  })

  it("NO active workspace → falls back to the default cwd (process.cwd via TerminalService)", async () => {
    const { svc: terminals } = makeTerminals()
    const work = new SessionService({ dir: mkdtempSync(join(tmpdir(), "ws-g-create-")) })
    const handlers = register(terminals, work, fakeWorkspaces(null))
    const res = await handlers["create_session"]({})
    // null → undefined → TerminalService.create falls back to process.cwd().
    expect(JSON.parse(res.content[0].text).cwd).toBe(process.cwd())
  })
})
