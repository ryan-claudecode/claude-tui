import { useState } from "react"

interface Props {
  data?: unknown
  title?: string
  /** Depth to auto-expand on first render (default 1). */
  defaultExpandDepth?: number
}

type Kind = "object" | "array" | "string" | "number" | "boolean" | "null"

function kindOf(v: unknown): Kind {
  if (v === null || v === undefined) return "null"
  if (Array.isArray(v)) return "array"
  const t = typeof v
  if (t === "object") return "object"
  if (t === "number") return "number"
  if (t === "boolean") return "boolean"
  return "string"
}

export default function TreePanel({ data, title, defaultExpandDepth = 1 }: Props) {
  if (data === undefined) {
    return <div className="panel-empty">No data provided.</div>
  }
  return (
    <div className="tree-panel">
      {title && <h2 className="tree-title">{title}</h2>}
      <div className="tree-root">
        <TreeNode keyName={null} value={data} depth={0} expandDepth={defaultExpandDepth} />
      </div>
    </div>
  )
}

function TreeNode({
  keyName,
  value,
  depth,
  expandDepth,
}: {
  keyName: string | null
  value: unknown
  depth: number
  expandDepth: number
}) {
  const kind = kindOf(value)
  const isContainer = kind === "object" || kind === "array"
  const [open, setOpen] = useState(depth < expandDepth)

  const label =
    keyName !== null ? <span className="tree-key">{keyName}</span> : null

  if (!isContainer) {
    return (
      <div className="tree-line" style={{ paddingLeft: depth * 14 }}>
        <span className="tree-gutter" />
        {label}
        {label && <span className="tree-colon">:</span>}
        <span className={`tree-value tree-${kind}`}>{renderLeaf(value, kind)}</span>
      </div>
    )
  }

  const entries: [string, unknown][] =
    kind === "array"
      ? (value as unknown[]).map((v, i) => [String(i), v])
      : Object.entries(value as Record<string, unknown>)

  const count = entries.length
  const bracket = kind === "array" ? ["[", "]"] : ["{", "}"]
  const summary = `${bracket[0]}${count === 0 ? "" : " … "}${bracket[1]}`

  return (
    <div className="tree-branch">
      <div
        className="tree-line tree-toggle"
        style={{ paddingLeft: depth * 14 }}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`tree-caret ${open ? "open" : ""}`}>{count === 0 ? "" : "▸"}</span>
        {label}
        {label && <span className="tree-colon">:</span>}
        {open && count > 0 ? (
          <span className="tree-bracket">{bracket[0]}</span>
        ) : (
          <span className="tree-bracket">{summary}</span>
        )}
        {!open && count > 0 && <span className="tree-count">{count}</span>}
      </div>
      {open && count > 0 && (
        <>
          {entries.map(([k, v]) => (
            <TreeNode key={k} keyName={k} value={v} depth={depth + 1} expandDepth={expandDepth} />
          ))}
          <div className="tree-line" style={{ paddingLeft: depth * 14 }}>
            <span className="tree-gutter" />
            <span className="tree-bracket">{bracket[1]}</span>
          </div>
        </>
      )}
    </div>
  )
}

function renderLeaf(value: unknown, kind: Kind): string {
  if (kind === "null") return value === undefined ? "undefined" : "null"
  if (kind === "string") return `"${value as string}"`
  return String(value)
}
