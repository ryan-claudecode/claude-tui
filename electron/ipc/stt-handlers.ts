import { ipcMain } from "electron"
import type { SttService } from "../services/stt"
import type { SttStatus, SttStatusSnapshot, SttTranscription } from "../stt/protocol"

/**
 * CAPP-120 (STT-1) — thin one-line wrappers over SttService (mirrors schedule-handlers.ts).
 * The `stt:progress` renderer push is wired in ipc.ts off `sttService.onProgress` (like
 * `schedule:updated`). NO MCP tool — dictation is a user-facing input affordance, not an
 * agent tool.
 */
export function registerSttHandlers(deps: {
  sttService: SttService
  /** config `stt.enabled`, read FRESH so an edit is honored without a restart. */
  isEnabled: () => boolean
}) {
  const { sttService, isEnabled } = deps

  ipcMain.handle("stt:status", (): SttStatusSnapshot => ({
    status: sttService.status(),
    enabled: isEnabled(),
    modelDir: sttService.modelDir,
    attribution: sttService.attribution,
    // Review finding 5 — the WHY behind an "error" status (acquisition failure or the
    // repeated worker-init failure), so the overlay can show it + offer re-download.
    message: sttService.statusMessage(),
    // CAPP-121 (STT-2) — the count of active workspace-vocabulary hotwords for the mic tooltip.
    hotwordCount: sttService.hotwordCount,
  }))

  ipcMain.handle(
    "stt:transcribe",
    (_e, samples: Float32Array, sampleRate: number): Promise<SttTranscription> => {
      // Structured clone across IPC preserves Float32Array, but coerce defensively.
      const s =
        samples instanceof Float32Array ? samples : new Float32Array(samples as ArrayLike<number>)
      return sttService.transcribe(s, sampleRate)
    },
  )

  // Kick off (or no-op) model acquisition; progress rides the stt:progress push channel.
  // Returns the resulting coarse status so the caller's UI can react immediately.
  // Review finding 6c — `force` is the corrupt-model recovery: delete the model dir +
  // re-download (the overlay's "Re-download model" action in the error state).
  ipcMain.handle("stt:acquire", (_e, force?: boolean): SttStatus => {
    void sttService.acquire({ force: force === true })
    return sttService.status()
  })

  ipcMain.handle("stt:cancel-acquire", (): void => {
    sttService.cancelAcquire()
  })
}
