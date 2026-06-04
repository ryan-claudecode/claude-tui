import { useState, useMemo } from "react"
import { diffLines } from "diff"

interface FileDiff {
  path: string
  oldContent?: string
  newContent?: string
}

interface Props {
  files?: FileDiff[]
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

export default function DiffPanel({ files = [] }: Props) {
  const [active, setActive] = useState(0)

  const file = files.length > 0 ? files[Math.min(active, files.length - 1)] : undefined

  const rows = useMemo(
    () => (file ? computeDiff(file.oldContent, file.newContent) : []),
    [file],
  )

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

  return (
    <div className="diff-panel">
      {files.length > 1 && (
        <div className="diff-tabs">
          {files.map((f, i) => (
            <button
              key={f.path + i}
              className={`diff-tab ${i === active ? "active" : ""}`}
              onClick={() => setActive(i)}
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
      <div className="diff-body">
        {rows.map((row, i) => (
          <div key={i} className={`diff-line diff-${row.type}`}>
            <span className="diff-lineno">{row.oldNo ?? ""}</span>
            <span className="diff-lineno">{row.newNo ?? ""}</span>
            <span className="diff-marker">
              {row.type === "add" ? "+" : row.type === "del" ? "−" : " "}
            </span>
            <span className="diff-text">{row.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
