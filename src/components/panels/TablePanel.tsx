import { useState, useMemo } from "react"

interface Props {
  columns?: string[]
  rows?: (string | number)[][]
  sortable?: boolean
}

export default function TablePanel({ columns = [], rows = [], sortable = true }: Props) {
  const [sortCol, setSortCol] = useState<number | null>(null)
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")

  const sortedRows = useMemo(() => {
    if (sortCol === null) return rows
    const copy = [...rows]
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
  }, [rows, sortCol, sortDir])

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
          {sortedRows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
