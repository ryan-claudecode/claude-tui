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
import type { ContextInspectorService } from "../services/contextInspector"
import type { TerminalService, TerminalInfo } from "../services/terminals"

// CAPP-98 — the workspace handlers under test don't exercise the inspector;
// a no-op stub satisfies the (required) dep so the handler registration succeeds.
// The inspector itself has its own dedicated unit suite (contextInspector.test.ts).
const inspectorStub = {
  inspectWorkspaceContext: () => ({ folder: null, gitRoot: null, sources: [] }),
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

beforeEach(() => {
  handlers.clear()
  root = mkdtempSync(join(tmpdir(), "ws-handlers-test-"))
  file = join(root, "workspaces.json")
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("WS-B/H workspace-handlers", () => {
  it("create/get/rename/set-dir round-trip and return the PUBLIC projection (single folder)", () => {
    const workspaceService = svc()
    registerWorkspaceHandlers({ workspaceService, contextInspectorService: inspectorStub, getScanPaths: () => [] })

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
    registerWorkspaceHandlers({ workspaceService, contextInspectorService: inspectorStub, getScanPaths: () => [] })
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
    registerWorkspaceHandlers({ workspaceService, contextInspectorService: inspectorStub, getScanPaths: () => [] })
    const id = call<Record<string, unknown>>("workspace:create", "WS", "/d1").id as string

    const result = call<{ workspace: string; sessions: unknown[] }>("workspace:launch", id)
    expect(result.workspace).toBe("WS")
    expect(result.sessions).toHaveLength(1)
    expect(createCalls).toBe(1)
  })

  it("delete returns a boolean and clears get-active when the active workspace is removed", () => {
    const workspaceService = svc()
    registerWorkspaceHandlers({ workspaceService, contextInspectorService: inspectorStub, getScanPaths: () => [] })
    const id = call<Record<string, unknown>>("workspace:create", "Doomed").id as string
    call("workspace:set-active", id)
    expect(call<boolean>("workspace:delete", id)).toBe(true)
    expect(call("workspace:get-active")).toBeNull()
    expect(call<boolean>("workspace:delete", "ghost")).toBe(false)
  })

  it("set-active(null) clears the selection", () => {
    const workspaceService = svc()
    registerWorkspaceHandlers({ workspaceService, contextInspectorService: inspectorStub, getScanPaths: () => [] })
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
      registerWorkspaceHandlers({ workspaceService, contextInspectorService: inspectorStub, getScanPaths: () => [join(root, "ws-*")] })

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
      registerWorkspaceHandlers({ workspaceService, contextInspectorService: inspectorStub, getScanPaths: () => [] })
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
})
