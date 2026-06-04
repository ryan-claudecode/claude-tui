import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

interface Props {
  content?: string
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
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    </div>
  )
}
