interface Props {
  content?: string
}

// Basic markdown renderer — upgraded to react-markdown in Task 2.4.
export default function MarkdownPanel({ content = "" }: Props) {
  if (!content) {
    return <div className="panel-empty">No markdown content provided.</div>
  }
  return (
    <div className="markdown-panel">
      <pre className="markdown-raw">{content}</pre>
    </div>
  )
}
