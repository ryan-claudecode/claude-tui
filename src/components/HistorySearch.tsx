import { useState, useEffect, useRef, useCallback } from "react"
import { useFocusTrap } from "../hooks/useFocusTrap"

export interface OutputMatch {
  sessionId: string
  name: string
  line: number
  text: string
}

interface Props {
  open: boolean
  onClose: () => void
  onSelectSession: (id: string) => void
}

// A spotlight-style overlay for searching captured output across every session.
// Backed by SessionService.searchOutput (case-insensitive, all sessions).
// Selecting a result focuses the session the match came from.
export default function HistorySearch({ open, onClose, onSelectSession }: Props) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<OutputMatch[]>([])
  const [selected, setSelected] = useState(0)
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)

  useEffect(() => {
    if (open) {
      setQuery("")
      setResults([])
      setSelected(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Debounce the search so we don't hammer IPC on every keystroke.
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (!q) {
      setResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    const t = setTimeout(async () => {
      const matches = await window.api.searchSessionOutput(q, undefined, 100)
      setResults(matches)
      setSelected(0)
      setSearching(false)
    }, 180)
    return () => clearTimeout(t)
  }, [query, open])

  useEffect(() => {
    const node = listRef.current?.children[selected] as HTMLElement | undefined
    node?.scrollIntoView({ block: "nearest" })
  }, [selected])

  const exec = useCallback(
    (m?: OutputMatch) => {
      if (!m) return
      onClose()
      onSelectSession(m.sessionId)
    },
    [onClose, onSelectSession],
  )

  if (!open) return null

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelected((s) => (results.length ? (s + 1) % results.length : 0))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelected((s) => (results.length ? (s - 1 + results.length) % results.length : 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      exec(results[selected])
    } else if (e.key === "Escape") {
      e.preventDefault()
      onClose()
    }
  }

  // Highlight the matched substring within a result line.
  const renderText = (text: string) => {
    const q = query.trim().toLowerCase()
    const idx = text.toLowerCase().indexOf(q)
    if (!q || idx === -1) return text
    return (
      <>
        {text.slice(0, idx)}
        <mark className="history-mark">{text.slice(idx, idx + q.length)}</mark>
        {text.slice(idx + q.length)}
      </>
    )
  }

  return (
    <div className="cmdk-overlay" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className="cmdk-panel history-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Search session history"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="cmdk-input-row">
          <span className="cmdk-prompt">⌕</span>
          <input
            ref={inputRef}
            className="cmdk-input"
            placeholder="Search session output history…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
          />
          {results.length > 0 && (
            <span className="history-count">{results.length}</span>
          )}
        </div>
        <div className="cmdk-list history-list" ref={listRef}>
          {query.trim() && !searching && results.length === 0 && (
            <div className="cmdk-empty">No matches in session output</div>
          )}
          {!query.trim() && (
            <div className="cmdk-empty">Type to search across all session output</div>
          )}
          {results.map((m, i) => (
            <div
              key={`${m.sessionId}-${m.line}-${i}`}
              className={`cmdk-item history-item ${i === selected ? "active" : ""}`}
              onMouseEnter={() => setSelected(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                exec(m)
              }}
            >
              <span className="history-source">{m.name}</span>
              <span className="history-line">{renderText(m.text) || "\u00a0"}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
