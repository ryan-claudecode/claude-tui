import { useState } from "react"

interface Props {
  /** The source text to display. */
  code?: string
  /** Optional language label shown in the header (purely informational). */
  language?: string
  /** Optional filename shown in the header. */
  filename?: string
  /** Line number the first line maps to (1-based). Defaults to 1. */
  startLine?: number
  /** Absolute line numbers to highlight (e.g. [42, 43]). */
  highlightLines?: number[]
  /** Soft-wrap long lines instead of horizontal scroll. */
  wrap?: boolean
}

// A focused, read-only code viewer: filename/language header, gutter line
// numbers, per-line highlighting, a wrap toggle, and copy-to-clipboard.
// Distinct from DiffPanel (two versions) and MarkdownPanel (prose) — this is
// for showing a single excerpt and pointing at specific lines ("the bug is here").
export default function CodePanel({
  code = "",
  language,
  filename,
  startLine = 1,
  highlightLines = [],
  wrap = false,
}: Props) {
  const [wrapped, setWrapped] = useState(wrap)
  const [copied, setCopied] = useState(false)

  const lines = code.replace(/\n$/, "").split("\n")
  const highlight = new Set(highlightLines)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard may be unavailable — ignore */
    }
  }

  return (
    <div className="code-panel">
      <div className="code-header">
        <div className="code-header-meta">
          {filename && <span className="code-filename">{filename}</span>}
          {language && <span className="code-lang">{language}</span>}
          <span className="code-linecount">
            {lines.length} {lines.length === 1 ? "line" : "lines"}
          </span>
        </div>
        <div className="code-header-actions">
          <button
            className={`code-action${wrapped ? " active" : ""}`}
            onClick={() => setWrapped((w) => !w)}
            title="Toggle soft wrap"
          >
            Wrap
          </button>
          <button className="code-action" onClick={copy} title="Copy to clipboard">
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <div className={`code-body${wrapped ? " wrapped" : ""}`}>
        <pre className="code-pre">
          {lines.map((line, i) => {
            const lineNo = startLine + i
            return (
              <div
                className={`code-line${highlight.has(lineNo) ? " highlighted" : ""}`}
                key={i}
              >
                <span className="code-gutter">{lineNo}</span>
                <span className="code-text">{line || "\u00A0"}</span>
              </div>
            )
          })}
        </pre>
      </div>
    </div>
  )
}
