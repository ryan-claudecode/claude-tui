import { useState, useMemo } from "react"

interface Props {
  columns?: string[]
  rows?: (string | number)[][]
  sortable?: boolean
}

export default function TablePanel({ columns = [], rows = [], sortable = true }: Props) {
  const [sortCol, setSortCol] = useState<number | null>(null)
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")
  const [filter, setFilter] = useState("")

  // Case-insensitive substring match across all cells in a row.
  const filteredRows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((row) => row.some((cell) => String(cell).toLowerCase().includes(q)))
  }, [rows, filter])

  const sortedRows = useMemo(() => {
    if (sortCol === null) return filteredRows
    const copy = [...filteredRows]
    copy.sort((a, b) => {
      const av = a[sortCol]
      const bv = b[sortCol]
      const an = typeof av === "number" ? av : parseFloat(String(av))
      const bn = typeof bv === "number" ? bv : parseFloat(String(bv))
      let cmp: number
      if (!isNaN(an) && !isNaN(bn)) cmp = an - bn
      else cmp = String(av).localeCompare(String(bv))
      return sortDir === "asc" ? cmp : -cmp
    })
    return copy
  }, [filteredRows, sortCol, sortDir])

  const handleSort = (i: number) => {
    if (!sortable) return
    if (sortCol === i) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortCol(i)
      setSortDir("asc")
    }
  }

  if (columns.length === 0) {
    return <div className="panel-empty">No table data provided.</div>
  }

  return (
    <div className="table-panel">
      <div className="table-toolbar">
        <input
          className="table-filter"
          type="text"
          placeholder="Filter rows…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="table-count">
          {sortedRows.length === rows.length
            ? `${rows.length} row${rows.length === 1 ? "" : "s"}`
            : `${sortedRows.length} of ${rows.length}`}
        </span>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((col, i) => (
              <th
                key={i}
                className={sortable ? "sortable" : undefined}
                onClick={() => handleSort(i)}
              >
                <span>{col}</span>
                {sortCol === i && (
                  <span className="sort-arrow">{sortDir === "asc" ? "▲" : "▼"}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.length === 0 ? (
            <tr>
              <td className="table-empty" colSpan={columns.length}>
                No rows match “{filter.trim()}”.
              </td>
            </tr>
          ) : (
            sortedRows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c}>{cell}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
