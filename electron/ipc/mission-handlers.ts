import { ipcMain } from "electron"
import type { MissionService } from "../services/mission"

export function registerMissionHandlers(deps: { missionService: MissionService }) {
  const { missionService } = deps

  // Mission orchestration IPC
  ipcMain.handle("mission:list", () => missionService.list())
  ipcMain.handle("mission:status", (_e, id?: string) => missionService.status(id))
  ipcMain.handle("mission:create", (_e, goal: string, cwd: string, autonomy?: any) =>
    missionService.create(goal, cwd, autonomy),
  )
  ipcMain.handle("mission:stop", (_e, id: string) => missionService.stop(id))
  ipcMain.handle("mission:pause", (_e, id: string, resumeAt?: number) =>
    missionService.pause(id, resumeAt),
  )
  ipcMain.handle("mission:resume", (_e, id: string) => missionService.resume(id))
  // Durable delete (the sidebar ✕). Removes the persisted <id>.json + drops it
  // from the in-memory map, gated to terminal-state missions. Emits a `removed`
  // event (routed to the renderer as `mission:removed` in ipc.ts).
  ipcMain.handle("mission:delete", (_e, id: string) => missionService.deleteMission(id))

  // WW-2b — worktree review UX. Approve/reject drive the frozen WW-2a backend
  // (MissionService.approveTask/rejectTask); the panel reflects the result, so
  // these return the resulting task state (status + reviewReason). The lookup
  // fetches the latest captured diff for the review panel (read-only — no
  // backend mutation, just reads MissionService's in-memory mission).
  ipcMain.handle("worktree:approve", (_e, missionId: string, taskId: string) => {
    const m = missionService.approveTask(missionId, taskId)
    const task = m?.tasks.find((t) => t.id === taskId)
    return task ? { status: task.status, reviewReason: task.reviewReason } : null
  })
  ipcMain.handle("worktree:reject", (_e, missionId: string, taskId: string, reason?: string) => {
    const m = missionService.rejectTask(missionId, taskId, reason)
    const task = m?.tasks.find((t) => t.id === taskId)
    return task ? { status: task.status, reviewReason: task.reviewReason } : null
  })
  ipcMain.handle("worktree:get-review-task", (_e, missionId: string, taskId: string) => {
    const task = missionService.get(missionId)?.tasks.find((t) => t.id === taskId)
    if (!task) return null
    return {
      missionId,
      taskId,
      title: task.title,
      diff: task.diff ?? "",
      reviewReason: task.reviewReason,
      status: task.status,
    }
  })
}
