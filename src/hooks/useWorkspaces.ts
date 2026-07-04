import { useState, useEffect, useCallback } from "react"
import { toast } from "../lib/toast"
import { nextActiveId, activeWorkspace } from "../lib/workspaceForm"

/** Renderer-facing shape for a workspace — the PUBLIC projection the WS-B IPC
 *  returns (never the internal `seed*` fields). WS-H single-folder model: `dir` is
 *  the workspace's one optional folder (was `dirs[]`). `color` rides along for the
 *  switcher dot. */
export interface WorkspaceSummary {
  id: string
  name: string
  dir?: string
  color?: string
  createdAt?: number
  updatedAt?: number
}

// Normalize an unknown thrown value into a human-readable message for toasts.
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The renderer half of the workspaces surface (P1-4 hook pattern, mirroring
 * useSessions). Seeds list + active on mount via `getWorkspaces()` +
 * `getActiveWorkspace()`, then tracks the active selection REACTIVELY off the
 * `workspace:active-changed` push (selection is separate from launch, WS-B) so a
 * `setActive` from any path — the dropdown, a delete-of-active, or an MCP/agent
 * select — re-renders the sidebar without polling.
 *
 * Owns the cleanup for the one listener it registers (`workspace:active-changed`).
 *
 * Actions (setActive/create/rename/delete) wrap the WS-B IPC with P0-5
 * toast-on-failure. They optimistically nudge local state where it keeps the UI
 * crisp, but the durable truth always arrives via the active-changed push (for
 * the active id) or a fresh `getWorkspaces()` re-read (for list mutations) — the
 * list has no push channel, so mutators re-seed the list themselves.
 */
export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  // Re-read the full list (no push channel for list mutations) and surface
  // failures as a toast. Returns the list so callers can chain off it.
  const refresh = useCallback(async (): Promise<WorkspaceSummary[]> => {
    const list = (await window.api.getWorkspaces()) as WorkspaceSummary[]
    setWorkspaces(list)
    return list
  }, [])

  useEffect(() => {
    // Seed list + active on mount.
    Promise.resolve(window.api.getWorkspaces())
      .then((list) => setWorkspaces(list as WorkspaceSummary[]))
      .catch((err) => toast("error", `Couldn't load workspaces: ${errMsg(err)}`))
    Promise.resolve(window.api.getActiveWorkspace())
      .then((ws) => setActiveId(nextActiveId(ws ?? null)))
      .catch((err) => toast("error", `Couldn't load the active workspace: ${errMsg(err)}`))

    // Track the active selection reactively (selection ≠ launch). Payload is the
    // new active workspace's public projection, or null when cleared/deleted.
    window.api.onWorkspaceActiveChanged((ws: WorkspaceSummary | null) => {
      setActiveId(nextActiveId(ws ?? null))
    })

    return () => {
      window.api.removeAllListeners("workspace:active-changed")
    }
  }, [])

  // SELECTION — make-active (id) or clear to "All" (null). The active id lands via
  // the active-changed push, but we also set it optimistically so the pill/filter
  // flip instantly. A service no-op (re-selecting the current) is harmless.
  const setActive = useCallback((id: string | null) => {
    setActiveId(id)
    Promise.resolve(window.api.setActiveWorkspace(id)).catch((err) => {
      toast("error", `Couldn't switch workspace: ${errMsg(err)}`)
    })
  }, [])

  // CREATE — name + optional single folder. Returns the new workspace (or null on
  // failure) so the caller can chain (the modal sets it active). Re-reads the list
  // so the new row appears; setActive then routes through the active-changed push.
  //
  // The dot COLOR is deliberately NOT persisted here: WS-A/B exposes no setColor
  // mutator and `createWorkspace(name, dir)` takes no color, so the auto-color
  // is RENDERER-DERIVED from the workspace's position via `colorFor(ws, index)`
  // (src/lib/workspaceColors.ts). An explicit user recolor is a deferred
  // follow-up — see WS-D scope note 5.
  const create = useCallback(
    async (name: string, dir?: string): Promise<WorkspaceSummary | null> => {
      try {
        const ws = (await window.api.createWorkspace(name, dir)) as WorkspaceSummary | null
        await refresh()
        return ws
      } catch (err) {
        toast("error", `Couldn't create the workspace: ${errMsg(err)}`)
        return null
      }
    },
    [refresh],
  )

  // RENAME — from the dropdown's inline affordance. Re-reads the list on success.
  const rename = useCallback(
    async (id: string, name: string): Promise<boolean> => {
      try {
        const ws = await window.api.renameWorkspace(id, name)
        await refresh()
        return ws != null
      } catch (err) {
        toast("error", `Couldn't rename the workspace: ${errMsg(err)}`)
        return false
      }
    },
    [refresh],
  )

  // DELETE — from the selected-workspace delete button. If it was active, the
  // service emits active-changed(null) so the active id resets to "All" via the
  // push. Re-reads the list so the row vanishes.
  //
  // OPTIMISTIC CLEAR (MINOR 4): when deleting the CURRENTLY-ACTIVE workspace, drop
  // activeId to null IMMEDIATELY (mirroring setActive's optimism) instead of
  // waiting for the active-changed(null) push. Otherwise there's a transient
  // window where the pill already reads "All" but the three sections still scope
  // to the now-dead id (→ flash of empty sections). The push still arrives and is
  // idempotent (null → null).
  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        // Use the functional setter so we read the freshest active id without
        // needing it in the dep array (keeps `remove` stable).
        setActiveId((cur) => (cur === id ? null : cur))
        const ok = await window.api.deleteWorkspace(id)
        await refresh()
        return ok
      } catch (err) {
        toast("error", `Couldn't delete the workspace: ${errMsg(err)}`)
        return false
      }
    },
    [refresh],
  )

  // SET DIR — WS-H. Set (or clear, with null) the workspace's single folder via the
  // `setWorkspaceDir` IPC (a SET also scaffolds a workspace.json + toasts, G3).
  // Re-reads the list so the dir-row updates. Returns the updated workspace (or null
  // on failure) so the caller can react.
  const setDir = useCallback(
    async (id: string, dir: string | null): Promise<WorkspaceSummary | null> => {
      try {
        const ws = (await window.api.setWorkspaceDir(id, dir)) as WorkspaceSummary | null
        await refresh()
        return ws
      } catch (err) {
        toast("error", `Couldn't set the folder: ${errMsg(err)}`)
        return null
      }
    },
    [refresh],
  )

  // RESCAN — WS-F. Re-run on-disk discovery against the configured scan paths and
  // refresh the list from the RETURNED public list (no second read). Idempotent
  // server-side (seeds new manifests, never duplicates a seeded workspace, never
  // reverts user edits), so a redundant click is harmless. Returns the count
  // delta so the caller can give the user feedback ("Found N new workspaces").
  const rescan = useCallback(async (): Promise<{ added: number } | null> => {
    try {
      const before = workspaces.length
      const list = (await window.api.rescanWorkspaces()) as WorkspaceSummary[]
      setWorkspaces(list)
      return { added: Math.max(0, list.length - before) }
    } catch (err) {
      toast("error", `Couldn't rescan workspaces: ${errMsg(err)}`)
      return null
    }
  }, [workspaces.length])

  const active = activeWorkspace(workspaces, activeId)

  return { workspaces, activeId, active, setActive, create, rename, remove, setDir, refresh, rescan }
}
