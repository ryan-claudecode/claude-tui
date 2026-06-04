interface Card {
  title: string
  /** Short tag/badge, e.g. a priority or owner. */
  tag?: string
  /** Optional longer description shown under the title. */
  detail?: string
  /** Optional accent color for the card's left border + tag. */
  color?: string
}

interface Column {
  title: string
  cards?: Card[]
  /** Optional accent color for the column header. */
  color?: string
}

interface Props {
  title?: string
  columns?: Column[]
}

export default function KanbanPanel({ title, columns = [] }: Props) {
  if (columns.length === 0) {
    return <div className="panel-empty">No kanban columns provided.</div>
  }

  return (
    <div className="kanban-panel">
      {title && <h2 className="kanban-title">{title}</h2>}
      <div className="kanban-board">
        {columns.map((col, ci) => {
          const cards = col.cards ?? []
          return (
            <div className="kanban-column" key={ci}>
              <div className="kanban-column-head">
                {col.color && (
                  <span className="kanban-column-dot" style={{ background: col.color }} />
                )}
                <span className="kanban-column-title">{col.title}</span>
                <span className="kanban-column-count">{cards.length}</span>
              </div>
              <div className="kanban-cards">
                {cards.length === 0 ? (
                  <div className="kanban-column-empty">—</div>
                ) : (
                  cards.map((card, ki) => (
                    <div
                      className="kanban-card"
                      key={ki}
                      style={card.color ? { borderLeftColor: card.color } : undefined}
                    >
                      <div className="kanban-card-head">
                        <span className="kanban-card-title">{card.title}</span>
                        {card.tag && (
                          <span
                            className="kanban-card-tag"
                            style={
                              card.color
                                ? { color: card.color, borderColor: card.color }
                                : undefined
                            }
                          >
                            {card.tag}
                          </span>
                        )}
                      </div>
                      {card.detail && <div className="kanban-card-detail">{card.detail}</div>}
                    </div>
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
