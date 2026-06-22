import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { registerWorkspaceTools } from "./workspaces"
import { WorkspaceService } from "../../services/workspaces"
import { WorkspaceMemoryService } from "../../services/workspaceMemory"
import type { TerminalService, TerminalInfo } from "../../services/terminals"
import type { SessionService } from "../../services/sessions"
import type { TerminalIdentity } from "./shared"

/**
 * WS-E — MCP workspace-tool round-trip. A fake McpServer captures each registered
 * tool handler into a map (mirroring the sessions.test.ts pattern), then drives a
 * REAL WorkspaceService (over its own temp registry file) through the captured
 * handlers. Asserts: id-based CRUD round-trips, every workspace-returning tool
 * returns the PUBLIC projection (no seed* leak), set-active is selection-only
 * (no spawn) + accepts null, launch spawns, and unknown ids return a graceful
 * error message rather than crashing.
 */

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

let root: string
let file: string
let createCalls: number

/** A real WorkspaceService over a temp registry file, with a fake TerminalService
 *  whose `create` only counts spawns (no real PTYs). */
function svc(): WorkspaceService {
  createCalls = 0
  const fakeTerminals = {
    create(name?: string, cwd?: string): TerminalInfo {
      createCalls += 1
      return { id: `t-${createCalls}`, name: name ?? "s", cwd: cwd ?? ".", state: "active" }
    },
  } as unknown as TerminalService
  return new WorkspaceService(fakeTerminals, { file })
}

/** Register the workspace tools against a fresh service; return the handler map.
 *  workSessions/workspaceMemory/identity are unused by the registry CRUD tools, so a
 *  bare cast suffices for those (the CAPP-87 memory tools have their own test below
 *  that drives real instances). WS-F — `getScanPaths` is injected so the rescan tool
 *  can be driven against a temp scan dir (defaults to none, which keeps the CRUD
 *  tests off the real config). */
function register(workspaceService: WorkspaceService, getScanPaths: () => string[] = () => []) {
  const { server, handlers } = fakeServer()
  registerWorkspaceTools(
    server as any,
    workspaceService,
    {} as unknown as SessionService,
    {} as unknown as WorkspaceMemoryService,
    {},
    getScanPaths,
  )
  return handlers
}

/** Parse the JSON body a tool returned in its single text content block. */
function parse<T = any>(res: { content: Array<{ text: string }> }): T {
  return JSON.parse(res.content[0].text) as T
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ws-e-mcp-test-"))
  file = join(root, "workspaces.json")
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("WS-E/H workspace MCP tools", () => {
  it("create/get-active/set-active/rename/set-dir/delete round-trip via the service", async () => {
    const workspaceService = svc()
    const h = register(workspaceService)

    // create (single folder)
    const created = parse<Record<string, unknown>>(await h.create_workspace({ name: "Frontend", dir: "/a" }))
    expect(created.name).toBe("Frontend")
    expect(created.dir).toBe("/a")
    expect("dirs" in created).toBe(false)
    const id = created.id as string

    // rename
    expect(parse(await h.rename_workspace({ id, name: "Renamed" })).name).toBe("Renamed")
    // set-dir (set + clear)
    expect(parse(await h.set_workspace_dir({ id, dir: "/b" })).dir).toBe("/b")
    expect(parse(await h.set_workspace_dir({ id, dir: null })).dir).toBeUndefined()

    // list reflects the live state
    const list = parse<Array<Record<string, unknown>>>(await h.list_workspaces({}))
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe("Renamed")

    // set-active + get-active round-trip
    expect((await h.set_active_workspace({ id })).content[0].text).toMatch(/Active workspace set/)
    expect(parse(await h.get_active_workspace({})).id).toBe(id)

    // delete clears the active selection (it was the active workspace)
    expect((await h.delete_workspace({ id })).content[0].text).toBe("Workspace deleted")
    expect(parse(await h.list_workspaces({}))).toHaveLength(0)
    // get-active now returns null
    expect(parse(await h.get_active_workspace({}))).toBeNull()
  })

  it("every workspace-returning tool returns the PUBLIC projection (no seed* leak)", async () => {
    // Seed an entry via discovery so it carries internal seed* fields, then assert
    // none of them cross the MCP surface on any read/mutator.
    const workspaceService = svc()
    const seeded = workspaceService.create("Seeded", "/x")
    const stored = workspaceService.get(seeded.id)!
    ;(stored as any).seedDir = "C:/manifest/dir"
    ;(stored as any).seedRepos = [{ name: "r", path: "/x", open_on_boot: true }]
    ;(stored as any).seedEditor = "code"

    const h = register(workspaceService)
    const noSeed = (obj: Record<string, unknown>) => {
      expect("seedDir" in obj).toBe(false)
      expect("seedRepos" in obj).toBe(false)
      expect("seedEditor" in obj).toBe(false)
    }

    noSeed(parse<Array<Record<string, unknown>>>(await h.list_workspaces({}))[0])
    noSeed(parse(await h.rename_workspace({ id: seeded.id, name: "X" })))
    noSeed(parse(await h.set_workspace_dir({ id: seeded.id, dir: "/y" })))
    await h.set_active_workspace({ id: seeded.id })
    noSeed(parse(await h.get_active_workspace({})))
  })

  it("set-active is SELECTION-ONLY (no spawn) and accepts null / clears to 'All'", async () => {
    const workspaceService = svc()
    const h = register(workspaceService)
    const id = (parse(await h.create_workspace({ name: "WS", dir: "/d1" })).id as string)

    expect(createCalls).toBe(0)
    await h.set_active_workspace({ id })
    expect(createCalls).toBe(0) // selection did NOT spawn
    expect(parse(await h.get_active_workspace({})).id).toBe(id)

    // null clears the selection (the 'All' bucket).
    const cleared = await h.set_active_workspace({ id: null })
    expect(cleared.content[0].text).toMatch(/cleared/)
    expect(parse(await h.get_active_workspace({}))).toBeNull()
  })

  it("launch_workspace boots (spawns one session in the folder) with the fake session driver", async () => {
    const workspaceService = svc()
    const h = register(workspaceService)
    const id = parse(await h.create_workspace({ name: "WS", dir: "/d1" })).id as string

    const result = parse<{ workspace: string; sessions: unknown[] }>(await h.launch_workspace({ id }))
    expect(result.workspace).toBe("WS")
    expect(result.sessions).toHaveLength(1)
    expect(createCalls).toBe(1) // one folder → one spawned session (no real PTYs)
  })

  it("unknown ids return a graceful error (no crash) across every id-taking tool", async () => {
    const workspaceService = svc()
    const h = register(workspaceService)

    expect((await h.rename_workspace({ id: "ghost", name: "X" })).content[0].text).toMatch(/not found/i)
    expect((await h.set_workspace_dir({ id: "ghost", dir: "/x" })).content[0].text).toMatch(/not found/i)
    expect((await h.delete_workspace({ id: "ghost" })).content[0].text).toMatch(/not found/i)
    expect((await h.set_active_workspace({ id: "ghost" })).content[0].text).toMatch(/not found/i)
    expect((await h.launch_workspace({ id: "ghost" })).content[0].text).toMatch(/not found/i)
  })

  it("create_workspace leaves dir undefined when omitted", async () => {
    const workspaceService = svc()
    const h = register(workspaceService)
    const created = parse(await h.create_workspace({ name: "Empty" }))
    expect(created.dir).toBeUndefined()
  })

  // WS-F — the on-demand re-scan tool, driven against a temp scan dir.
  it("rescan_workspaces seeds a new manifest and returns the PUBLIC list (no seed* leak, idempotent)", async () => {
    const scanDir = join(root, "ws-seed")
    mkdirSync(scanDir, { recursive: true })
    writeFileSync(join(scanDir, "workspace.json"), JSON.stringify({ name: "Imported", repos: [] }))

    const workspaceService = svc()
    const h = register(workspaceService, () => [join(root, "ws-*")])

    const list = parse<Array<Record<string, unknown>>>(await h.rescan_workspaces({}))
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe("Imported")
    // No internal seed* fields cross the MCP boundary.
    expect("seedDir" in list[0]).toBe(false)
    expect("seedRepos" in list[0]).toBe(false)
    expect("seedEditor" in list[0]).toBe(false)

    // Idempotent: a second rescan of the same dir does NOT duplicate the entry.
    const again = parse<unknown[]>(await h.rescan_workspaces({}))
    expect(again).toHaveLength(1)
  })
})

/**
 * CAPP-87 / U3 — the workspace-memory MCP tools. The SECURITY blockers:
 *   • add/set-context destination = the caller's bound session's workspace ONLY
 *     (NEVER getActiveId); an untagged session writes to the untagged bucket.
 *   • an explicit unknown workspace_id is rejected.
 *   • promote_finding lands in the OWNING session's workspace even when the
 *     caller's identity is a DIFFERENT workspace; a not-found note is rejected; a
 *     mismatched explicit workspace_id is rejected.
 */
describe("CAPP-87 / U3 workspace memory MCP tools", () => {
  let memDir: string

  /** A real WorkspaceMemoryService over a per-test temp dir. */
  function mem(): WorkspaceMemoryService {
    return new WorkspaceMemoryService({ dir: memDir })
  }

  /** A fake SessionService that maps session id → workspaceId, and resolves a
   *  single canned promotable finding per (sessionId, noteId). */
  function fakeSessions(opts: {
    workspaceOf: Record<string, string | undefined>
    notes?: Record<string, Record<string, { text: string; originNoteId: string }>>
  }): SessionService {
    return {
      get: (id: string) =>
        id in opts.workspaceOf ? { workspaceId: opts.workspaceOf[id] } : undefined,
      getPromotableFinding: (sessionId: string, noteId: string) =>
        opts.notes?.[sessionId]?.[noteId],
    } as unknown as SessionService
  }

  /** Register the memory tools with a concrete identity + memory + sessions. */
  function registerMem(
    workspaceService: WorkspaceService,
    sessions: SessionService,
    memory: WorkspaceMemoryService,
    identity: TerminalIdentity,
  ) {
    const { server, handlers } = fakeServer()
    registerWorkspaceTools(server as any, workspaceService, sessions, memory, identity, () => [])
    return handlers
  }

  beforeEach(() => {
    memDir = join(root, "workspace-memory")
  })

  it("add_workspace_memory writes to the CALLER's bound session's workspace (never getActiveId)", async () => {
    const ws = svc()
    const a = ws.create("A", "/a")
    // Make a DIFFERENT workspace the globally-active one — the write must NOT use it.
    const b = ws.create("B", "/b")
    ws.setActive(b.id)

    const memory = mem()
    const sessions = fakeSessions({ workspaceOf: { "sess-1": a.id } })
    const h = registerMem(ws, sessions, memory, { sessionId: "sess-1" })

    await h.add_workspace_memory({ text: "convention X" })
    // Landed in the caller's session workspace (A), NOT the active selection (B).
    expect(memory.getMemory(a.id).findings.map((f) => f.text)).toEqual(["convention X"])
    expect(memory.getMemory(b.id).findings).toHaveLength(0)
    // Source is "agent".
    expect(memory.getMemory(a.id).findings[0].source).toBe("agent")
  })

  it("add_workspace_memory writes to the UNTAGGED bucket when the caller's session has no workspace", async () => {
    const ws = svc()
    const active = ws.create("Active", "/x")
    ws.setActive(active.id) // active selection must be ignored

    const memory = mem()
    const sessions = fakeSessions({ workspaceOf: { "sess-1": undefined } })
    const h = registerMem(ws, sessions, memory, { sessionId: "sess-1" })

    await h.add_workspace_memory({ text: "global note" })
    // Untagged bucket (null), NOT the active workspace.
    expect(memory.getMemory(null).findings.map((f) => f.text)).toEqual(["global note"])
    expect(memory.getMemory(active.id).findings).toHaveLength(0)
  })

  it("set_workspace_memory_context writes the standing context to the caller's workspace", async () => {
    const ws = svc()
    const a = ws.create("A", "/a")
    const memory = mem()
    const sessions = fakeSessions({ workspaceOf: { "sess-1": a.id } })
    const h = registerMem(ws, sessions, memory, { sessionId: "sess-1" })

    await h.set_workspace_memory_context({ context: "use TDD" })
    expect(memory.getMemory(a.id).instructions).toBe("use TDD")
  })

  it("an explicit UNKNOWN workspace_id is rejected (add + set-context + get)", async () => {
    const ws = svc()
    const memory = mem()
    const sessions = fakeSessions({ workspaceOf: { "sess-1": undefined } })
    const h = registerMem(ws, sessions, memory, { sessionId: "sess-1" })

    expect((await h.add_workspace_memory({ text: "x", workspace_id: "ghost" })).content[0].text).toMatch(
      /not found/i,
    )
    expect(
      (await h.set_workspace_memory_context({ context: "x", workspace_id: "ghost" })).content[0].text,
    ).toMatch(/not found/i)
    expect((await h.get_workspace_memory({ workspace_id: "ghost" })).content[0].text).toMatch(/not found/i)
    // Nothing was written.
    expect(memory.getMemory(null).findings).toHaveLength(0)
  })

  it("promote_finding lands in the OWNING session's workspace even when the caller is in a DIFFERENT workspace", async () => {
    const ws = svc()
    const owner = ws.create("Owner", "/owner")
    const caller = ws.create("Caller", "/caller")
    ws.setActive(caller.id) // active selection must be ignored

    const memory = mem()
    const sessions = fakeSessions({
      workspaceOf: { "owner-sess": owner.id, "caller-sess": caller.id },
      notes: { "owner-sess": { "note-1": { text: "the bug", originNoteId: "note-1" } } },
    })
    // Caller identity is in the CALLER workspace; the note belongs to OWNER's session.
    const h = registerMem(ws, sessions, memory, { sessionId: "caller-sess" })

    const res = await h.promote_finding({ note_id: "note-1", session_id: "owner-sess" })
    const promoted = JSON.parse(res.content[0].text) as Array<{ text: string }>
    expect(promoted.map((p) => p.text)).toEqual(["the bug"])
    // Landed in the OWNER's workspace, NOT the caller's and NOT the active selection.
    expect(memory.getMemory(owner.id).findings.map((f) => f.text)).toEqual(["the bug"])
    expect(memory.getMemory(caller.id).findings).toHaveLength(0)
  })

  it("promote_finding defaults the owning session to the caller's identity", async () => {
    const ws = svc()
    const a = ws.create("A", "/a")
    const memory = mem()
    const sessions = fakeSessions({
      workspaceOf: { "sess-1": a.id },
      notes: { "sess-1": { "note-1": { text: "fact", originNoteId: "note-1" } } },
    })
    const h = registerMem(ws, sessions, memory, { sessionId: "sess-1" })

    await h.promote_finding({ note_id: "note-1" }) // no session_id → caller's own
    expect(memory.getMemory(a.id).findings.map((f) => f.text)).toEqual(["fact"])
  })

  it("promote_finding rejects a not-found note_id", async () => {
    const ws = svc()
    const a = ws.create("A", "/a")
    const memory = mem()
    const sessions = fakeSessions({ workspaceOf: { "sess-1": a.id }, notes: { "sess-1": {} } })
    const h = registerMem(ws, sessions, memory, { sessionId: "sess-1" })

    expect((await h.promote_finding({ note_id: "ghost" })).content[0].text).toMatch(/not found/i)
    expect(memory.getMemory(a.id).findings).toHaveLength(0)
  })

  it("promote_finding rejects a mismatched explicit workspace_id (no silent cross-workspace re-home)", async () => {
    const ws = svc()
    const owner = ws.create("Owner", "/owner")
    const other = ws.create("Other", "/other")
    const memory = mem()
    const sessions = fakeSessions({
      workspaceOf: { "owner-sess": owner.id },
      notes: { "owner-sess": { "note-1": { text: "x", originNoteId: "note-1" } } },
    })
    const h = registerMem(ws, sessions, memory, { sessionId: "owner-sess" })

    const res = await h.promote_finding({ note_id: "note-1", workspace_id: other.id })
    expect(res.content[0].text).toMatch(/cross-workspace|refus/i)
    // Nothing promoted into either workspace.
    expect(memory.getMemory(owner.id).findings).toHaveLength(0)
    expect(memory.getMemory(other.id).findings).toHaveLength(0)
  })
})
