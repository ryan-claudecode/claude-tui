/**
 * CAPP-111 (S4) — the per-block "open in detail view" button.
 *
 * Replaces the old whole-block click-to-open (which opened a markdown/diff/code
 * panel on a click ANYWHERE in the block) with an EXPLICIT, statically-visible
 * action button at a block's top-right corner. The trigger moved; the `onExpand`
 * logic (compute the panel request + `window.api.showPanel`) is unchanged — under
 * S2 that call now lands in the main-window ModalHost.
 *
 * STATICALLY VISIBLE — full opacity at rest, NEVER hover-revealed (the project's
 * hard UI rule). `compact` renders an icon-only square (the dense `tool`/`raw`
 * rows) so the control never squeezes their one-line summary; otherwise it shows
 * the icon + a short text label (the prose `assistant`/`result` blocks). The
 * `label` is always carried on `title`/`aria-label` so the icon-only variant stays
 * discoverable + accessible.
 */
export function BlockExpandButton({
  label,
  compact,
  onExpand,
}: {
  label: string
  compact: boolean
  onExpand: () => void
}) {
  return (
    <button
      type="button"
      className={`agent-block-expand ${compact ? "compact" : ""}`}
      // stopPropagation guards any future block-level handler; the whole-block
      // click-to-open is gone, but the button stays self-contained.
      onClick={(e) => {
        e.stopPropagation()
        onExpand()
      }}
      title={label}
      aria-label={label}
    >
      <span aria-hidden="true">⤢</span>
      {compact ? null : <span className="agent-block-expand-text">{label}</span>}
    </button>
  )
}
