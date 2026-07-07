import type { QueuedAgentInput } from "../../electron/services/streamProtocol"

/** Max characters shown in a queued-message chip before an ellipsis. */
const CHIP_PREVIEW_MAX = 48

/**
 * CAPP-130 — the display projection of one queued item: a single-line, truncated text
 * preview and the attachment count that rides along. Pure (no React) so it's unit-tested
 * in node. An attachment-only queue (no text) previews as "📎 N attachment(s)" so the chip
 * is never blank.
 */
export function queuedChipPreview(item: QueuedAgentInput): { text: string; attachCount: number } {
  const attachCount = item.attachments?.length ?? 0
  const raw = (item.text ?? "").replace(/\s+/g, " ").trim()
  let text = raw
  if (text.length > CHIP_PREVIEW_MAX) text = text.slice(0, CHIP_PREVIEW_MAX - 1) + "…"
  if (!text) text = attachCount > 0 ? `${attachCount} attachment${attachCount === 1 ? "" : "s"}` : "(empty)"
  return { text, attachCount }
}

interface Props {
  /** FIFO queue snapshot (oldest first) — rendered top-to-bottom in send order. */
  queue: QueuedAgentInput[]
  /** Remove one queued item by its queued id (the chip's ✕). */
  onRemove: (queuedId: string) => void
}

/**
 * CAPP-130 — the statically-visible row of queued messages ABOVE the composer input.
 * Every control is visible at rest (HARD UI rule: no hover-reveal): each chip shows a
 * truncated text preview, a 📎N marker when attachments ride along, and an ALWAYS-VISIBLE
 * ✕ remove button. Chips key off the STABLE queued id (no re-firing arrival animation on
 * remount — the stream-reveal-flicker trap). Renders nothing when the queue is empty.
 */
export default function QueuedMessages({ queue, onRemove }: Props) {
  if (queue.length === 0) return null
  return (
    <div className="composer-queue" role="list" aria-label="Queued messages">
      {queue.map((item, i) => {
        const { text, attachCount } = queuedChipPreview(item)
        return (
          <div className="composer-queue-chip" role="listitem" key={item.id}>
            <span className="composer-queue-index" aria-hidden="true">
              {i + 1}
            </span>
            <span className="composer-queue-text" title={item.text || undefined}>
              {text}
            </span>
            {attachCount > 0 && (
              <span className="composer-queue-attach" aria-label={`${attachCount} attachment${attachCount === 1 ? "" : "s"}`}>
                📎{attachCount}
              </span>
            )}
            <button
              type="button"
              className="composer-queue-x"
              aria-label="Remove queued message"
              onClick={() => onRemove(item.id)}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}
