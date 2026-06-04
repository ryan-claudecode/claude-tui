import { useState, useEffect, useRef, useMemo } from "react"

export interface Command {
  id: string
  label: string
  hint?: string
  keywords?: string
  run: () => void
}

interface Props {
  open: boolean
  commands: Command[]
  onClose: () => void
}

// Lightweight subsequence fuzzy match — returns true if every char of `query`
// appears in order within `text`. Empty query matches everything.
function fuzzyMatch(query: string, text: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let i = 0
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) i++
  }
  return i === q.length
}

export default function CommandPalette({ open, commands, onClose }: Props) {
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const results = useMemo(
    () =>
      commands.filter((c) =>
        fuzzyMatch(query, `${c.label} ${c.hint ?? ""} ${c.keywords ?? ""}`),
      ),
    [commands, query],
  )

  // Reset state whenever the palette opens, and focus the input.
  useEffect(() => {
    if (open) {
      setQuery("")
      setSelected(0)
      // Focus after the element is mounted/painted.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Keep the selection index in range as the result set shrinks.
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, results.length - 1)))
  }, [results.length])

  // Scroll the active row into view as the user navigates.
  useEffect(() => {
    const node = listRef.current?.children[selected] as HTMLElement | undefined
    node?.scrollIntoView({ block: "nearest" })
  }, [selected])

  if (!open) return null

  const exec = (cmd?: Command) => {
    if (!cmd) return
    onClose()
    cmd.run()
  }

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

  return (
    <div className="cmdk-overlay" onMouseDown={onClose}>
      <div className="cmdk-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cmdk-input-row">
          <span className="cmdk-prompt">›</span>
          <input
            ref={inputRef}
            className="cmdk-input"
            placeholder="Type a command…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
          />
        </div>
        <div className="cmdk-list" ref={listRef}>
          {results.length === 0 && <div className="cmdk-empty">No matching commands</div>}
          {results.map((cmd, i) => (
            <div
              key={cmd.id}
              className={`cmdk-item ${i === selected ? "active" : ""}`}
              onMouseEnter={() => setSelected(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                exec(cmd)
              }}
            >
              <span className="cmdk-label">{cmd.label}</span>
              {cmd.hint && <span className="cmdk-hint">{cmd.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
