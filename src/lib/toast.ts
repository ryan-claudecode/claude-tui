import type { ToastState } from "../components/ToastHost"

/**
 * Renderer-local toast channel.
 *
 * The toast UI (`ToastHost`) historically only rendered toasts pushed from the
 * main process over IPC (`notification:show`). This module gives renderer-side
 * code a way to raise the same toasts without a round-trip to the main process,
 * by dispatching a DOM `CustomEvent` that `ToastHost` also listens for.
 *
 * Use it to surface failures of user-triggered async operations (spawning a
 * session, adding/closing a terminal, etc.) that would otherwise fail silently.
 */
export const TOAST_EVENT = "claudetui:toast"

/** Default auto-dismiss timeouts (ms). Errors linger a little longer. */
const DEFAULT_TIMEOUT = 6000
const ERROR_TIMEOUT = 8000

/**
 * Pure payload builder — constructs the full `ToastState` for a toast.
 *
 * Kept separate from the `window.dispatchEvent` side effect so it can be unit
 * tested in vitest's node environment (no `window`/jsdom required).
 */
export function buildToast(
  level: ToastState["level"],
  message: string,
  title?: string,
): ToastState {
  return {
    id: crypto.randomUUID(),
    level,
    title,
    message,
    timeout: level === "error" ? ERROR_TIMEOUT : DEFAULT_TIMEOUT,
    createdAt: Date.now(),
  }
}

/**
 * Raise a renderer-local toast. Dispatches a `claudetui:toast` CustomEvent on
 * `window`; `ToastHost` listens for it and renders it through the same
 * stacking/dismiss logic as IPC-driven notifications.
 */
export function toast(
  level: ToastState["level"],
  message: string,
  title?: string,
): void {
  window.dispatchEvent(
    new CustomEvent<ToastState>(TOAST_EVENT, { detail: buildToast(level, message, title) }),
  )
}
