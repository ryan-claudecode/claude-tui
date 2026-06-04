import { useState } from "react"

interface FileDiff {
  path: string
  oldContent?: string
  newContent?: string
}

interface Props {
  files?: FileDiff[]
}

type Row = { type: "add" | "del" | "ctx"; oldNo?: number; newNo?: number; text: string }

// Naive line diff — replaced with a proper LCS diff in Task 2.1.
function naiveDiff(oldContent = "", newContent = ""): Row[] {
  const oldLines = oldContent.split("\n")
  const newLines = newContent.split("\n")
  const rows: Row[] = []
  const max = Math.max(oldLines.length, newLines.length)
  let o = 1
  let n = 1
  for (let i = 0; i < max; i++) {
    const ol = oldLines[i]
    const nl = newLines[i]
    if (ol === nl && ol !== undefined) {
      rows.push({ type: "ctx", oldNo: o++, newNo: n++, text: ol })
    } else {
      if (ol !== undefined) rows.push({ type: "del", oldNo: o++, text: ol })
      if (nl !== undefined) rows.push({ type: "add", newNo: n++, text: nl })
    }
  }
  return rows
}

export default function DiffPanel({ files = [] }: Props) {
  const [active, setActive] = useState(0)

  if (files.length === 0) {
    return <div className="panel-empty">No diff data provided.</div>
  }

  const file = files[Math.min(active, files.length - 1)]
  const rows = naiveDiff(file.oldContent, file.newContent)

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
      <div className="diff-filepath">{file.path}</div>
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
