import MarkdownView from "../MarkdownView"

interface Props {
  content?: string
}

// Renders GitHub-flavored markdown (tables, code blocks, headings, lists) through
// the shared MarkdownView (BO-8) — the same renderer the inline structured chat
// uses, so the panel and inline prose can never drift. react-markdown escapes raw
// HTML by default, so untrusted content is safe.
export default function MarkdownPanel({ content = "" }: Props) {
  if (!content) {
    return <div className="panel-empty">No markdown content provided.</div>
  }
  return (
    <div className="markdown-panel">
      <MarkdownView source={content} />
    </div>
  )
}
