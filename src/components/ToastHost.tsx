import { useEffect, useRef, useState } from "react"

export interface ToastState {
  id: string
  level: "info" | "success" | "warning" | "error"
  title?: string
  message: string
  timeout: number
  createdAt: number
}

const ICONS: Record<ToastState["level"], string> = {
  info: "i",
  success: "✓",
  warning: "!",
  error: "×",
}

/**
 * ToastHost — renders Claude-driven toast notifications in a stacked overlay.
 * Notifications arrive over IPC (notification:show) and auto-dismiss after
 * their timeout unless timeout is 0 (sticky).
 */
export default function ToastHost() {
  const [toasts, setToasts] = useState<ToastState[]>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismiss = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
    window.api.dismissNotification(id)
  }

  useEffect(() => {
    window.api.onNotificationShow((toast: ToastState) => {
      setToasts((prev) => [...prev.filter((t) => t.id !== toast.id), toast])
      if (toast.timeout > 0) {
        const timer = setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== toast.id))
          timers.current.delete(toast.id)
        }, toast.timeout)
        timers.current.set(toast.id, timer)
      }
    })

    window.api.onNotificationDismiss((id: string) => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    })

    const pending = timers.current
    return () => {
      window.api.removeAllListeners("notification:show")
      window.api.removeAllListeners("notification:dismiss")
      pending.forEach((t) => clearTimeout(t))
      pending.clear()
    }
  }, [])

  if (toasts.length === 0) return null

  return (
    <div className="toast-host">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.level}`}
          onClick={() => dismiss(toast.id)}
          role="status"
        >
          <span className="toast-icon">{ICONS[toast.level]}</span>
          <div className="toast-content">
            {toast.title && <div className="toast-title">{toast.title}</div>}
            <div className="toast-message">{toast.message}</div>
          </div>
          <button
            className="toast-close"
            onClick={(e) => {
              e.stopPropagation()
              dismiss(toast.id)
            }}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
