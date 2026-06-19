import { useCallback, useEffect, useMemo, useState } from "react"
import type { AgentCatalog } from "../../electron/services/streamProtocol"
import {
  buildCatalogEntries,
  filterCatalogEntries,
  slashQuery,
  type CatalogEntry,
} from "../lib/slashCatalog"

/**
 * BO-7 (CAPP-41) — the `/`-command autocomplete state for the structured composer.
 * Sources its catalog LIVE from the headless `init` event (slash commands + skills),
 * never a hardcoded list: it pulls the already-captured catalog on mount via the
 * `agent:catalog` accessor AND tracks live `init` stream events (init can arrive
 * after the composer mounts — a headless `claude -p` emits init after the first
 * user message). Keeping it in a hook keeps AgentComposer's diff small (so it merges
 * cleanly with BO-6's model picker, which also edits AgentComposer).
 *
 * The hook only exposes state + a keydown delegate; AgentComposer owns the textarea
 * and renders the dropdown. `handleKeyDown` returns true when it consumed the event
 * (so the composer skips its own Enter-to-send), false otherwise.
 */
export interface SlashPicker {
  open: boolean
  entries: CatalogEntry[]
  index: number
  setIndex: (i: number) => void
  /** Accept an entry: inserts `/name ` via onAccept and closes the picker. */
  accept: (name: string) => void
  /** Returns true if it handled the key (composer should not also act on it). */
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
}

export function useSlashPicker(opts: {
  terminalId: string
  text: string
  onAccept: (name: string) => void
}): SlashPicker {
  const { terminalId, text, onAccept } = opts
  const [catalog, setCatalog] = useState<AgentCatalog>({ slashCommands: [], skills: [] })
  const [dismissed, setDismissed] = useState(false)
  const [index, setIndex] = useState(0)

  // Catalog source: pull whatever's already captured, then keep current off live
  // init events. Per-instance unsubscribe (preload returns a disposer) so this
  // second stream listener never clobbers AgentView's.
  useEffect(() => {
    let alive = true
    window.api
      .getAgentCatalog(terminalId)
      .then((c) => {
        if (alive && c) setCatalog(c)
      })
      .catch(() => {})
    const dispose = window.api.onStreamEvent((p) => {
      if (p.terminalId !== terminalId) return
      if (p.event.kind === "init") {
        setCatalog({
          slashCommands: p.event.slashCommands ?? [],
          skills: p.event.skills ?? [],
        })
      }
    })
    return () => {
      alive = false
      dispose?.()
    }
  }, [terminalId])

  const allEntries = useMemo(() => buildCatalogEntries(catalog), [catalog])
  const query = slashQuery(text) // null unless the text is an in-progress slash token
  const entries = useMemo(
    () => (query == null ? [] : filterCatalogEntries(allEntries, query)),
    [allEntries, query],
  )

  // Re-open after an Esc dismissal once the user edits the text again; reset the
  // highlight whenever the result set changes.
  useEffect(() => {
    setDismissed(false)
  }, [text])
  useEffect(() => {
    setIndex(0)
  }, [query])

  const open = query != null && !dismissed && entries.length > 0
  const safeIndex = entries.length > 0 ? Math.min(index, entries.length - 1) : 0

  const accept = useCallback(
    (name: string) => {
      if (!name) return
      onAccept(name)
      setDismissed(false)
      setIndex(0)
    },
    [onAccept],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open) return false
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault()
          setIndex((i) => (i + 1) % entries.length)
          return true
        case "ArrowUp":
          e.preventDefault()
          setIndex((i) => (i - 1 + entries.length) % entries.length)
          return true
        case "Enter":
          if (e.shiftKey || e.nativeEvent.isComposing) return false
          e.preventDefault()
          accept(entries[safeIndex]?.name)
          return true
        case "Tab":
          e.preventDefault()
          accept(entries[safeIndex]?.name)
          return true
        case "Escape":
          e.preventDefault()
          setDismissed(true)
          return true
        default:
          return false
      }
    },
    [open, entries, safeIndex, accept],
  )

  return { open, entries, index: safeIndex, setIndex, accept, handleKeyDown }
}
