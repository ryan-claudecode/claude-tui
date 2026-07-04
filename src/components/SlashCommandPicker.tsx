import type { CatalogEntry } from "../lib/slashCatalog"

/**
 * BO-7 (CAPP-41) — the `/`-command autocomplete dropdown for the structured
 * composer. Purely presentational: it renders the filtered catalog entries (sourced
 * live from the headless `init` event, never hardcoded) and reports hover/click; all
 * keyboard nav + the open/closed decision live in useSlashPicker. Mounted only inside
 * AgentComposer, which is itself rendered only for structured terminals — so the
 * picker is inherently structured-only.
 */
export default function SlashCommandPicker({
  entries,
  index,
  onHover,
  onSelect,
  stale = false,
}: {
  entries: CatalogEntry[]
  index: number
  onHover: (i: number) => void
  onSelect: (name: string) => void
  /**
   * CAPP-126 — render the muted "from last session" hint when the list is the
   * persisted/builtin floor (no fresh `init` yet this process). Visible TEXT (no
   * hover/tooltip), so the user knows the list refreshes after the first reply.
   */
  stale?: boolean
}) {
  if (entries.length === 0) return null
  return (
    <div className="slash-picker" role="listbox" aria-label="Slash commands">
      {entries.map((entry, i) => (
        <button
          key={entry.name}
          type="button"
          role="option"
          aria-selected={i === index}
          className={`slash-picker-item${i === index ? " active" : ""}`}
          // Use mousedown (not click) so selecting an item doesn't blur the textarea
          // first (which would otherwise drop focus before the insert).
          onMouseDown={(e) => {
            e.preventDefault()
            onSelect(entry.name)
          }}
          onMouseEnter={() => onHover(i)}
        >
          <span className="slash-picker-name">/{entry.name}</span>
          <span className={`slash-picker-kind slash-picker-kind-${entry.kind}`}>{entry.kind}</span>
        </button>
      ))}
      {stale && (
        <div className="slash-picker-stale">from last session — refreshes after the first reply</div>
      )}
    </div>
  )
}
