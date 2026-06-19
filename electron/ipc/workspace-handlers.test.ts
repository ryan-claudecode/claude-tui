import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
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
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}))

import { registerWorkspaceHandlers } from "./workspace-handlers"
import { WorkspaceService } from "../services/workspaces"
import type { TerminalService, TerminalInfo } from "../services/terminals"

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

describe("WS-B workspace-handlers", () => {
  it("create/get/rename/add-dir/remove-dir round-trip and return the PUBLIC projection", () => {
    const workspaceService = svc()
    registerWorkspaceHandlers({ workspaceService })

    const created = call<Record<string, unknown>>("workspace:create", "Frontend", ["/a"])
    expect(created.name).toBe("Frontend")
    expect(created.dirs).toEqual(["/a"])
    // PUBLIC projection only — no internal seed* fields leak across IPC.
    expect("seedDir" in created).toBe(false)
    const id = created.id as string

    expect(call<Record<string, unknown>>("workspace:get", id).name).toBe("Frontend")
    expect(call<Record<string, unknown>>("workspace:rename", id, "Renamed").name).toBe("Renamed")
    expect(call<Record<string, unknown>>("workspace:add-dir", id, "/b").dirs).toEqual(["/a", "/b"])
    expect(call<Record<string, unknown>>("workspace:remove-dir", id, "/a").dirs).toEqual(["/b"])

    // Missing-id mutators resolve to null (not a throw).
    expect(call("workspace:get", "ghost")).toBeNull()
    expect(call("workspace:rename", "ghost", "X")).toBeNull()
  })

  it("set-active is SELECTION-ONLY (persists + no spawn); get-active reflects it", () => {
    const workspaceService = svc()
    registerWorkspaceHandlers({ workspaceService })
    const id = call<Record<string, unknown>>("workspace:create", "WS", ["/d1", "/d2"]).id as string

    expect(createCalls).toBe(0)
    expect(call<boolean>("workspace:set-active", id)).toBe(true)
    expect(createCalls).toBe(0) // selection did NOT spawn
    expect(call<Record<string, unknown>>("workspace:get-active")?.id).toBe(id)

    // Selection persisted to disk (survives a fresh service over the same file).
    expect(svc().getActiveId()).toBe(id)
  })

  it("launch (the boot verb) STILL spawns one session per dir", () => {
    const workspaceService = svc()
    registerWorkspaceHandlers({ workspaceService })
    const id = call<Record<string, unknown>>("workspace:create", "WS", ["/d1", "/d2"]).id as string

    const result = call<{ workspace: string; sessions: unknown[] }>("workspace:launch", id)
    expect(result.workspace).toBe("WS")
    expect(result.sessions).toHaveLength(2)
    expect(createCalls).toBe(2)
  })

  it("delete returns a boolean and clears get-active when the active workspace is removed", () => {
    const workspaceService = svc()
    registerWorkspaceHandlers({ workspaceService })
    const id = call<Record<string, unknown>>("workspace:create", "Doomed").id as string
    call("workspace:set-active", id)
    expect(call<boolean>("workspace:delete", id)).toBe(true)
    expect(call("workspace:get-active")).toBeNull()
    expect(call<boolean>("workspace:delete", "ghost")).toBe(false)
  })

  it("set-active(null) clears the selection", () => {
    const workspaceService = svc()
    registerWorkspaceHandlers({ workspaceService })
    const id = call<Record<string, unknown>>("workspace:create", "A").id as string
    call("workspace:set-active", id)
    expect(call<boolean>("workspace:set-active", null)).toBe(true)
    expect(call("workspace:get-active")).toBeNull()
  })
})
