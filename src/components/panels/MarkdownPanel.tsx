import { useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

interface Props {
  content?: string
}

// A fenced code block with a hover "Copy" button. Reads text straight from the
// rendered DOM so it works regardless of how react-markdown nests children.
function CodeBlock({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    const el = ref.current
    const text = el?.querySelector("code")?.textContent ?? el?.textContent ?? ""
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="md-codeblock">
      <button className="md-copy" onClick={copy} type="button">
        {copied ? "Copied" : "Copy"}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  )
}

// Renders GitHub-flavored markdown (tables, code blocks, headings, lists).
// react-markdown escapes raw HTML by default, so untrusted content is safe.
export default function MarkdownPanel({ content = "" }: Props) {
  if (!content) {
    return <div className="panel-empty">No markdown content provided.</div>
  }
  return (
    <div className="markdown-panel">
      <div className="markdown-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{ pre: ({ children }) => <CodeBlock>{children}</CodeBlock> }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  )
}
