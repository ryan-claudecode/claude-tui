import { useState, useMemo, useCallback } from "react"
import { diffLines } from "diff"

interface FileDiff {
  path: string
  oldContent?: string
  newContent?: string
}

interface Props {
  files?: FileDiff[]
  // Sends the built review request to the active session. Returns false when
  // there's no active session to receive it. Injected by PanelDrawer/App.
  onSend?: (text: string) => boolean
}

type Row = { type: "add" | "del" | "ctx"; oldNo?: number; newNo?: number; text: string }

// Proper line diff using the `diff` package's LCS-based algorithm. Each change
// chunk carries a list of lines; we expand it into per-line rows with running
// old/new line numbers so additions and deletions stay correctly aligned.
function computeDiff(oldContent = "", newContent = ""): Row[] {
  const rows: Row[] = []
  let o = 1
  let n = 1
  for (const part of diffLines(oldContent, newContent)) {
    // diffLines keeps the trailing newline on each part; drop a single empty
    // trailing element so we don't render a phantom blank line per chunk.
    const lines = part.value.split("\n")
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
    for (const text of lines) {
      if (part.added) {
        rows.push({ type: "add", newNo: n++, text })
      } else if (part.removed) {
        rows.push({ type: "del", oldNo: o++, text })
      } else {
        rows.push({ type: "ctx", oldNo: o++, newNo: n++, text })
      }
    }
  }
  return rows
}

// Human-readable line label for a row, preferring the new-file number.
function rowLabel(r: Row): number | undefined {
  return r.newNo ?? r.oldNo
}

// Build a structured review request Claude can act on directly. Includes the
// file path, the selected hunk as a fenced diff, and the reviewer's note.
function buildReviewRequest(path: string, selected: Row[], note: string): string {
  const first = selected.find((r) => rowLabel(r) !== undefined)
  const last = [...selected].reverse().find((r) => rowLabel(r) !== undefined)
  const a = first ? rowLabel(first) : undefined
  const b = last ? rowLabel(last) : undefined
  const range = a !== undefined ? (a === b ? `line ${a}` : `lines ${a}\u2013${b}`) : "the selected lines"

  const hunk = selected
    .map((r) => {
      const marker = r.type === "add" ? "+" : r.type === "del" ? "-" : " "
      return `${marker}${r.text}`
    })
    .join("\n")

  const trimmed = note.trim()
  const instruction = trimmed.length > 0 ? trimmed : "Please review this selection and suggest changes."

  return `Regarding \`${path}\` (${range}):\n\n\`\`\`diff\n${hunk}\n\`\`\`\n\n${instruction}\n`
}

export default function DiffPanel({ files = [], onSend }: Props) {
  const [active, setActive] = useState(0)
  // Inclusive selection range over `rows`, by row index. `anchor` is where the
  // selection started; `head` is the most recent dragged-over/clicked line.
  const [anchor, setAnchor] = useState<number | null>(null)
  const [head, setHead] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [note, setNote] = useState("")
  // null = idle, "sent" = delivered, "no-session" = nothing to receive it.
  const [sendState, setSendState] = useState<null | "sent" | "no-session">(null)

  const file = files.length > 0 ? files[Math.min(active, files.length - 1)] : undefined

  const rows = useMemo(
    () => (file ? computeDiff(file.oldContent, file.newContent) : []),
    [file],
  )

  const clearSelection = useCallback(() => {
    setAnchor(null)
    setHead(null)
    setDragging(false)
    setNote("")
    setSendState(null)
  }, [])

  // Begin a drag-selection (or extend it with Shift). Mouse-enter while the
  // button is held grows the range; mouse-up anywhere in the body ends it.
  const handleLineMouseDown = useCallback(
    (i: number, e: React.MouseEvent) => {
      e.preventDefault()
      setSendState(null)
      if (e.shiftKey && anchor !== null) {
        setHead(i)
      } else {
        setAnchor(i)
        setHead(i)
      }
      setDragging(true)
    },
    [anchor],
  )

  const handleLineEnter = useCallback(
    (i: number) => {
      if (dragging) setHead(i)
    },
    [dragging],
  )

  const endDrag = useCallback(() => setDragging(false), [])

  const selectFile = useCallback(
    (i: number) => {
      setActive(i)
      clearSelection()
    },
    [clearSelection],
  )

  const lo = anchor !== null && head !== null ? Math.min(anchor, head) : -1
  const hi = anchor !== null && head !== null ? Math.max(anchor, head) : -1
  const hasSelection = lo >= 0

  const handleSend = useCallback(() => {
    if (!file || !hasSelection || !onSend) return
    const text = buildReviewRequest(file.path, rows.slice(lo, hi + 1), note)
    setSendState(onSend(text) ? "sent" : "no-session")
  }, [file, hasSelection, onSend, rows, lo, hi, note])

  if (files.length === 0 || !file) {
    return <div className="panel-empty">No diff data provided.</div>
  }

  const stats = rows.reduce(
    (acc, r) => {
      if (r.type === "add") acc.add++
      else if (r.type === "del") acc.del++
      return acc
    },
    { add: 0, del: 0 },
  )

  const selCount = hasSelection ? hi - lo + 1 : 0

  return (
    <div className="diff-panel">
      {files.length > 1 && (
        <div className="diff-tabs">
          {files.map((f, i) => (
            <button
              key={f.path + i}
              className={`diff-tab ${i === active ? "active" : ""}`}
              onClick={() => selectFile(i)}
            >
              {f.path.split(/[\\/]/).pop()}
            </button>
          ))}
        </div>
      )}
      <div className="diff-filepath">
        <span className="diff-filename">{file.path}</span>
        <span className="diff-stats">
          {stats.add > 0 && <span className="diff-stat-add">+{stats.add}</span>}
          {stats.del > 0 && <span className="diff-stat-del">−{stats.del}</span>}
        </span>
      </div>
      <div className="diff-body" onMouseUp={endDrag} onMouseLeave={endDrag}>
        {rows.map((row, i) => {
          const selected = hasSelection && i >= lo && i <= hi
          return (
            <div
              key={i}
              className={`diff-line diff-${row.type}${selected ? " diff-selected" : ""}`}
              onMouseDown={(e) => handleLineMouseDown(i, e)}
              onMouseEnter={() => handleLineEnter(i)}
            >
              <span className="diff-lineno">{row.oldNo ?? ""}</span>
              <span className="diff-lineno">{row.newNo ?? ""}</span>
              <span className="diff-marker">
                {row.type === "add" ? "+" : row.type === "del" ? "−" : " "}
              </span>
              <span className="diff-text">{row.text}</span>
            </div>
          )
        })}
      </div>
      {hasSelection ? (
        <div className="diff-review">
          <div className="diff-review-head">
            <span className="diff-review-count">
              {selCount} line{selCount === 1 ? "" : "s"} selected
            </span>
            <button className="diff-review-clear" onClick={clearSelection}>
              Clear
            </button>
          </div>
          <textarea
            className="diff-review-note"
            placeholder="Tell Claude what to change about this selection…"
            value={note}
            onChange={(e) => {
              setNote(e.target.value)
              setSendState(null)
            }}
          />
          <button className="diff-review-copy" onClick={handleSend}>
            {sendState === "sent"
              ? "Sent to session ✓"
              : sendState === "no-session"
                ? "No active session"
                : "Send to session"}
          </button>
        </div>
      ) : (
        <div className="diff-review-hint">
          Click or drag across lines to start a review comment.
        </div>
      )}
    </div>
  )
}
