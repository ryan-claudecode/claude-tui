import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

/**
 * WS-B — id-based workspace IPC handler round-trip. We mock `electron` so
 * `ipcMain.handle` captures each handler into a map (no real Electron native
 * module loaded), then drive a REAL WorkspaceService (its own temp registry
 * file) through the captured handlers. Asserts: id-based ops round-trip, the
 * PUBLIC projection is returned (no seed* leak), and set-active is selection-only
 * (no spawn) while launch spawns.
 */
const handlers = new Map<string, (...args: unknown[]) => unknown>()
// WS-D — the dialog:open-directory handler reaches for dialog.showOpenDialog +
// BrowserWindow.fromWebContents. We stub both: showOpenDialog returns whatever
// `dialogResult` is set to per-test; fromWebContents returns a truthy fake parent
// window (so the parented branch is exercised).
let dialogResult: { canceled: boolean; filePaths: string[] } = { canceled: false, filePaths: [] }
const showOpenDialog = vi.fn(async (..._args: unknown[]) => dialogResult)
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
  dialog: { showOpenDialog: (...args: unknown[]) => showOpenDialog(...args) },
  BrowserWindow: { fromWebContents: () => ({ id: "win" }) },
}))

import { registerWorkspaceHandlers } from "./workspace-handlers"
import { WorkspaceService } from "../services/workspaces"
import { WorkspaceMemoryService } from "../services/workspaceMemory"
import type { ContextInspectorService } from "../services/contextInspector"
import type { TerminalService, TerminalInfo } from "../services/terminals"

// CAPP-98 — the workspace-memory handlers under test don't exercise the inspector;
// a no-op stub satisfies the (required) dep so the handler registration succeeds.
// The inspector itself has its own dedicated unit suite (contextInspector.test.ts).
const inspectorStub = {
  inspectWorkspaceContext: () => ({ folder: null, gitRoot: null, adopted: false, sources: [] }),
} as unknown as ContextInspectorService

// Invoke a captured handler by channel (the leading IpcMainInvokeEvent is unused
// by every WS-B handler, so we pass a dummy).
function call<T = unknown>(channel: string, ...args: unknown[]): T {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no handler registered for ${channel}`)
  return fn({} as unknown, ...args) as T
}

let root: string
let file: string
let memDir: string
let createCalls: number

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

/** A real WorkspaceMemoryService over a per-test temp dir (no real ~/.claude-tui). */
function memSvc(): WorkspaceMemoryService {
  return new WorkspaceMemoryService({ dir: memDir })
}

beforeEach(() => {
  handlers.clear()
  root = mkdtempSync(join(tmpdir(), "ws-handlers-test-"))
  file = join(root, "workspaces.json")
  memDir = join(root, "workspace-memory")
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("WS-B/H workspace-handlers", () => {
  it("create/get/rename/set-dir round-trip and return the PUBLIC projection (single folder)", () => {
    const workspaceService = svc()
    registerWorkspaceHandlers({ workspaceService, workspaceMemoryService: memSvc(), contextInspectorService: inspectorStub, getScanPaths: () => [] })

    const created = call<Record<string, unknown>>("workspace:create", "Frontend", "/a")
    expect(created.name).toBe("Frontend")
    expect(created.dir).toBe("/a")
    // PUBLIC projection only — no internal seed* fields leak across IPC.
    expect("seedDir" in created).toBe(false)
    expect("dirs" in created).toBe(false)
    const id = created.id as string

    expect(call<Record<string, unknown>>("workspace:get", id).name).toBe("Frontend")
    expect(call<Record<string, unknown>>("workspace:rename", id, "Renamed").name).toBe("Renamed")
    // WS-H — set-dir sets and clears the single folder.
    expect(call<Record<string, unknown>>("workspace:set-dir", id, "/b").dir).toBe("/b")
    expect(call<Record<string, unknown>>("workspace:set-dir", id, null).dir).toBeUndefined()

    // Missing-id mutators resolve to null (not a throw).
    expect(call("workspace:get", "ghost")).toBeNull()
    expect(call("workspace:rename", "ghost", "X")).toBeNull()
    expect(call("workspace:set-dir", "ghost", "/x")).toBeNull()
  })

  it("set-active is SELECTION-ONLY (persists + no spawn); get-active reflects it", () => {
    const workspaceService = svc()
    registerWorkspaceHandlers({ workspaceService, workspaceMemoryService: memSvc(), contextInspectorService: inspectorStub, getScanPaths: () => [] })
    const id = call<Record<string, unknown>>("workspace:create", "WS", "/d1").id as string

    expect(createCalls).toBe(0)
    expect(call<boolean>("workspace:set-active", id)).toBe(true)
    expect(createCalls).toBe(0) // selection did NOT spawn
    expect(call<Record<string, unknown>>("workspace:get-active")?.id).toBe(id)

    // Selection persisted to disk (survives a fresh service over the same file).
    expect(svc().getActiveId()).toBe(id)
  })

  it("launch (the boot verb) STILL spawns one session in the folder", () => {
    const workspaceService = svc()
    registerWorkspaceHandlers({ workspaceService, workspaceMemoryService: memSvc(), contextInspectorService: inspectorStub, getScanPaths: () => [] })
    const id = call<Record<string, unknown>>("workspace:create", "WS", "/d1").id as string

    const result = call<{ workspace: string; sessions: unknown[] }>("workspace:launch", id)
    expect(result.workspace).toBe("WS")
    expect(result.sessions).toHaveLength(1)
    expect(createCalls).toBe(1)
  })

  it("delete returns a boolean and clears get-active when the active workspace is removed", () => {
    const workspaceService = svc()
    registerWorkspaceHandlers({ workspaceService, workspaceMemoryService: memSvc(), contextInspectorService: inspectorStub, getScanPaths: () => [] })
    const id = call<Record<string, unknown>>("workspace:create", "Doomed").id as string
    call("workspace:set-active", id)
    expect(call<boolean>("workspace:delete", id)).toBe(true)
    expect(call("workspace:get-active")).toBeNull()
    expect(call<boolean>("workspace:delete", "ghost")).toBe(false)
  })

  it("set-active(null) clears the selection", () => {
    const workspaceService = svc()
    registerWorkspaceHandlers({ workspaceService, workspaceMemoryService: memSvc(), contextInspectorService: inspectorStub, getScanPaths: () => [] })
    const id = call<Record<string, unknown>>("workspace:create", "A").id as string
    call("workspace:set-active", id)
    expect(call<boolean>("workspace:set-active", null)).toBe(true)
    expect(call("workspace:get-active")).toBeNull()
  })

  // WS-F — the on-demand re-scan IPC. Drives a real service over a temp scan dir
  // via an injected getScanPaths, so the handler resolves the configured paths
  // without touching the user's real config.
  describe("workspace:rescan (WS-F)", () => {
    it("seeds a NEWLY-added manifest and returns the PUBLIC list (no seed* leak)", () => {
      const scanDir = join(root, "ws-new")
      mkdirSync(scanDir, { recursive: true })
      writeFileSync(join(scanDir, "workspace.json"), JSON.stringify({ name: "Imported", repos: [] }))

      const workspaceService = svc()
      registerWorkspaceHandlers({ workspaceService, workspaceMemoryService: memSvc(), contextInspectorService: inspectorStub, getScanPaths: () => [join(root, "ws-*")] })

      const list = call<Array<Record<string, unknown>>>("workspace:rescan")
      expect(list).toHaveLength(1)
      expect(list[0].name).toBe("Imported")
      // Public projection only — no internal seed* fields cross the IPC boundary.
      expect("seedDir" in list[0]).toBe(false)
      expect("seedRepos" in list[0]).toBe(false)

      // Idempotent: re-scanning the same dir does NOT duplicate the entry.
      expect(call<unknown[]>("workspace:rescan")).toHaveLength(1)
    })
  })

  // WS-D/H — the native folder picker IPC (single-select for the one-folder model).
  describe("dialog:open-directory (WS-D/H folder picker)", () => {
    beforeEach(() => {
      const workspaceService = svc()
      registerWorkspaceHandlers({ workspaceService, workspaceMemoryService: memSvc(), contextInspectorService: inspectorStub, getScanPaths: () => [] })
      showOpenDialog.mockClear()
    })

    it("returns the chosen absolute dir path", async () => {
      dialogResult = { canceled: false, filePaths: ["C:/a"] }
      const out = await call<Promise<string[]>>("dialog:open-directory")
      expect(out).toEqual(["C:/a"])
    })

    it("returns [] when the dialog is canceled", async () => {
      dialogResult = { canceled: true, filePaths: [] }
      expect(await call<Promise<string[]>>("dialog:open-directory")).toEqual([])
    })

    it("opens SINGLE-select with the openDirectory property (no multiSelections)", async () => {
      dialogResult = { canceled: false, filePaths: [] }
      await call<Promise<string[]>>("dialog:open-directory")
      const opts = showOpenDialog.mock.calls[0].at(-1) as unknown as { properties: string[] }
      expect(opts.properties).toContain("openDirectory")
      expect(opts.properties).not.toContain("multiSelections")
    })
  })

  // CAPP-87 / U3 — the 6 workspace-memory channels. Drive a real
  // WorkspaceMemoryService (shared instance) through the captured handlers and
  // assert the right service method ran by reading the persisted record back.
  describe("workspace memory channels (CAPP-87 / U3)", () => {
    let mem: WorkspaceMemoryService
    beforeEach(() => {
      const workspaceService = svc()
      mem = memSvc()
      registerWorkspaceHandlers({ workspaceService, workspaceMemoryService: mem, contextInspectorService: inspectorStub, getScanPaths: () => [] })
    })

    it("workspace:get-memory returns the (empty) record for a workspace id", () => {
      const rec = call<{ workspaceId: string; findings: unknown[]; instructions: string }>(
        "workspace:get-memory",
        "ws-1",
      )
      expect(rec.workspaceId).toBe("ws-1")
      expect(rec.findings).toEqual([])
      expect(rec.instructions).toBe("")
    })

    it("workspace:set-instructions writes the standing context (readable via get-memory)", () => {
      call("workspace:set-instructions", "ws-1", "always use snake_case")
      expect(call<{ instructions: string }>("workspace:get-memory", "ws-1").instructions).toBe(
        "always use snake_case",
      )
      // Service is the source of truth too.
      expect(mem.getMemory("ws-1").instructions).toBe("always use snake_case")
    })

    it("workspace:add-finding appends a finding with the given source", () => {
      const finding = call<{ id: string; text: string; source: string }>(
        "workspace:add-finding",
        "ws-1",
        "the db is postgres",
        "user",
      )
      expect(finding.text).toBe("the db is postgres")
      expect(finding.source).toBe("user")
      expect(call<{ findings: unknown[] }>("workspace:get-memory", "ws-1").findings).toHaveLength(1)
    })

    it("workspace:edit-finding updates the text and returns true (false for unknown id)", () => {
      const finding = call<{ id: string }>("workspace:add-finding", "ws-1", "old", "agent")
      expect(call<boolean>("workspace:edit-finding", "ws-1", finding.id, "new")).toBe(true)
      expect(call<boolean>("workspace:edit-finding", "ws-1", "ghost", "x")).toBe(false)
      expect(mem.getMemory("ws-1").findings[0].text).toBe("new")
    })

    it("workspace:delete-finding removes the finding and returns true (false for unknown id)", () => {
      const finding = call<{ id: string }>("workspace:add-finding", "ws-1", "doomed", "agent")
      expect(call<boolean>("workspace:delete-finding", "ws-1", finding.id)).toBe(true)
      expect(call<boolean>("workspace:delete-finding", "ws-1", "ghost")).toBe(false)
      expect(mem.getMemory("ws-1").findings).toHaveLength(0)
    })

    it("workspace:set-pinned pins/unpins a finding and returns true (false for unknown id) — CAPP-97", () => {
      const finding = call<{ id: string }>("workspace:add-finding", "ws-1", "load-bearing", "agent")
      expect(call<boolean>("workspace:set-pinned", "ws-1", finding.id, true)).toBe(true)
      expect(mem.getMemory("ws-1").findings[0].pinned).toBe(true)
      expect(call<boolean>("workspace:set-pinned", "ws-1", finding.id, false)).toBe(true)
      expect(mem.getMemory("ws-1").findings[0].pinned).toBeUndefined()
      expect(call<boolean>("workspace:set-pinned", "ws-1", "ghost", true)).toBe(false)
    })

    it("workspace:promote-findings re-mints + appends the entries to the workspace", () => {
      const promoted = call<Array<{ id: string; originNoteId?: string; text: string }>>(
        "workspace:promote-findings",
        "ws-1",
        [{ text: "root cause: race in init", originSessionId: "s9", originNoteId: "note-x" }],
      )
      expect(promoted).toHaveLength(1)
      expect(promoted[0].text).toBe("root cause: race in init")
      // re-minted id (not the origin note id)
      expect(promoted[0].id).not.toBe("note-x")
      expect(mem.getMemory("ws-1").findings).toHaveLength(1)
    })

    it("a null workspaceId addresses the untagged bucket", () => {
      call("workspace:add-finding", null, "global gotcha", "agent")
      expect(call<{ findings: unknown[] }>("workspace:get-memory", null).findings).toHaveLength(1)
      // A real workspace id is a SEPARATE bucket.
      expect(call<{ findings: unknown[] }>("workspace:get-memory", "ws-1").findings).toHaveLength(0)
    })
  })
})
