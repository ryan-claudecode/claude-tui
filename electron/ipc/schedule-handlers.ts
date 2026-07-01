import { ipcMain } from "electron"
import type { SchedulerService, ScheduleInput, ScheduleUpdate } from "../services/scheduler"

/**
 * CAPP-114 (SCHED-1) — thin one-line wrappers over SchedulerService. Mirrors
 * mission-handlers.ts. The `schedule:updated` / `schedule:removed` renderer push is
 * wired in ipc.ts off `schedulerService.onEvent` (like `mission:updated`).
 */
export function registerScheduleHandlers(deps: { schedulerService: SchedulerService }) {
  const { schedulerService } = deps

  ipcMain.handle("schedule:list", () => schedulerService.list())
  ipcMain.handle("schedule:create", (_e, input: ScheduleInput) => schedulerService.create(input))
  ipcMain.handle("schedule:update", (_e, id: string, patch: ScheduleUpdate) => schedulerService.update(id, patch))
  ipcMain.handle("schedule:delete", (_e, id: string) => schedulerService.delete(id))
  ipcMain.handle("schedule:run-now", (_e, id: string) => schedulerService.runNow(id))
}
