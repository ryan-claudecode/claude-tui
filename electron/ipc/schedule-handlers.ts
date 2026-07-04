import { ipcMain, app, type BrowserWindow } from "electron"
import type { SchedulerService, ScheduleInput, ScheduleUpdate } from "../services/scheduler"

/**
 * CAPP-114 (SCHED-1) — thin one-line wrappers over SchedulerService. The
 * `schedule:updated` / `schedule:removed` renderer push is wired in ipc.ts off
 * `schedulerService.onEvent`.
 *
 * CAPP-115 (SCHED-2) — `schedule:request-edit` is the detail panel's "Edit" button
 * round-trip: the panel (in either the ModalHost or a popped-out companion window)
 * invokes it with a schedule id; the main process forwards it to the MAIN window as a
 * `schedule:edit` renderer event, where App.tsx opens the pre-filled ScheduleForm.
 * Routing through the main process (rather than a renderer-local event) is what lets
 * the popped-out companion reach the main window's overlay uniformly.
 */
export function registerScheduleHandlers(deps: { schedulerService: SchedulerService; win: BrowserWindow }) {
  const { schedulerService, win } = deps

  ipcMain.handle("schedule:list", () => schedulerService.list())
  ipcMain.handle("schedule:create", (_e, input: ScheduleInput) => schedulerService.create(input))
  ipcMain.handle("schedule:update", (_e, id: string, patch: ScheduleUpdate) => schedulerService.update(id, patch))
  ipcMain.handle("schedule:delete", (_e, id: string) => schedulerService.delete(id))
  ipcMain.handle("schedule:run-now", (_e, id: string) => schedulerService.runNow(id))
  ipcMain.handle("schedule:request-edit", (_e, id: string) => {
    if (win.isDestroyed()) return
    // CAPP-115 review (MINOR 3) — the ScheduleForm overlay lives in the MAIN window,
    // but the request can come from a POPPED-OUT companion in the foreground. Raise
    // the main window first (the ipc.ts attention-click pattern: on Windows,
    // BrowserWindow.focus() alone cannot steal foreground from another window —
    // restore + show + moveTop + app.focus({steal:true}) is required), THEN send the
    // edit event so the pre-filled overlay is actually visible and focusable.
    if (win.isMinimized()) win.restore()
    win.show()
    win.moveTop()
    app.focus({ steal: true })
    win.webContents.send("schedule:edit", id)
  })
}
