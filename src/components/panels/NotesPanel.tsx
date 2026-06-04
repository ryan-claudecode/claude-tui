import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

interface Note {
  id: string
  title: string
  body: string
  scope?: string
  tags?: string[]
  createdAt?: string
  updatedAt?: string
}

interface Props {
  title?: string
  notes?: Note[]
}

// Format an ISO timestamp as a short, friendly "updated" label.
function when(iso?: string): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ""
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

// Surfaces the persistent cross-session scratchpad (NotesService) in the UI, so
// the user can actually see the durable context Claude leaves for future
// sessions. Bodies render as GitHub-flavored markdown.
export default function NotesPanel({ title = "Notes", notes = [] }: Props) {
  if (notes.length === 0) {
    return <div className="panel-empty">No notes saved yet.</div>
  }

  return (
    <div className="notes-panel">
      <div className="notes-header">
        <h2 className="notes-title">{title}</h2>
        <span className="notes-count">{notes.length}</span>
      </div>
      <div className="notes-list">
        {notes.map((note) => (
          <article className="note-card" key={note.id}>
            <div className="note-card-head">
              <span className="note-card-title">{note.title}</span>
              {note.updatedAt && <span className="note-card-when">{when(note.updatedAt)}</span>}
            </div>
            {(note.scope || (note.tags && note.tags.length > 0)) && (
              <div className="note-card-meta">
                {note.scope && <span className="note-scope">{note.scope}</span>}
                {note.tags?.map((tag) => (
                  <span className="note-tag" key={tag}>
                    {tag}
                  </span>
                ))}
              </div>
            )}
            {note.body && (
              <div className="note-card-body markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{note.body}</ReactMarkdown>
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  )
}
