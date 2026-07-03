import { useState, useEffect, useCallback } from "react"
import { toast } from "../lib/toast"
import type { ActionButtonView } from "../lib/actionButtonRow"

/**
 * The renderer half of the Agent Rail BUTTONS group (CAPP-104 / AB-1). Mirrors
 * {@link useSchedules}: seeds once with `listActionButtons()` on mount, then maintains
 * a flat list from the `actionbuttons:updated` push (each carries ONE owner's full
 * button set — replace-in-place by (scope, ownerId)). The rail derives its visible
 * subset from `buttons` via `deriveVisibleButtons`.
 */

interface ChangedPayload {
  scope: "session" | "workspace"
  ownerId: string
  buttons: ActionButtonView[]
}

interface DispatchResult {
  ok: boolean
  error?: string
  sessionName?: string
  spawned?: boolean
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function useActionButtons() {
  const [buttons, setButtons] = useState<ActionButtonView[]>([])

  useEffect(() => {
    Promise.resolve(window.api.listActionButtons())
      .then((list) => setButtons(list as ActionButtonView[]))
      .catch((err) => toast("error", `Couldn't load action buttons: ${errMsg(err)}`))

    window.api.onActionButtonsUpdated((payload: ChangedPayload) => {
      setButtons((prev) => {
        const others = prev.filter(
          (b) => !(b.scope === payload.scope && b.ownerId === payload.ownerId),
        )
        return [...others, ...payload.buttons]
      })
    })

    return () => window.api.removeAllListeners("actionbuttons:updated")
  }, [])

  const remove = useCallback((button: ActionButtonView) => {
    Promise.resolve(window.api.removeActionButton(button.scope, button.ownerId, button.id)).catch(
      (err) => toast("error", `Couldn't remove the button: ${errMsg(err)}`),
    )
  }, [])

  const dispatch = useCallback((button: ActionButtonView, targetSessionId: string) => {
    Promise.resolve(window.api.dispatchActionButton(button.id, targetSessionId))
      .then((res: DispatchResult) => {
        if (res?.ok) {
          toast("info", `Sent "${button.label}" to ${res.sessionName ?? "the session"}`)
        } else {
          toast("error", res?.error ?? "Couldn't run the button.")
        }
      })
      .catch((err) => toast("error", `Couldn't run the button: ${errMsg(err)}`))
  }, [])

  return { buttons, remove, dispatch }
}
