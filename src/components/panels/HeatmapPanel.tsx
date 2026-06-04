interface HeatmapProps {
  title?: string
  xLabels?: string[]
  yLabels?: string[]
  rows: number[][]
  unit?: string
  min?: number
  max?: number
}

// Map a 0..1 fraction onto a blue→green→amber→red heat ramp.
function heatColor(t: number): string {
  const stops: [number, [number, number, number]][] = [
    [0, [30, 41, 59]], // slate (cold / empty)
    [0.25, [37, 99, 235]], // blue
    [0.5, [16, 185, 129]], // green
    [0.75, [245, 158, 11]], // amber
    [1, [239, 68, 68]], // red (hot)
  ]
  const c = Math.max(0, Math.min(1, t))
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i - 1]
    const [p2, c2] = stops[i]
    if (c <= p2) {
      const f = (c - p1) / (p2 - p1 || 1)
      const r = Math.round(c1[0] + (c2[0] - c1[0]) * f)
      const g = Math.round(c1[1] + (c2[1] - c1[1]) * f)
      const b = Math.round(c1[2] + (c2[2] - c1[2]) * f)
      return `rgb(${r}, ${g}, ${b})`
    }
  }
  return `rgb(239, 68, 68)`
}

export default function HeatmapPanel({
  title,
  xLabels,
  yLabels,
  rows,
  unit,
  min,
  max,
}: HeatmapProps) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return <div className="heatmap-panel heatmap-empty">No heatmap data.</div>
  }

  const flat = rows.flat().filter((v) => typeof v === "number" && !isNaN(v))
  const lo = min ?? (flat.length ? Math.min(...flat) : 0)
  const hi = max ?? (flat.length ? Math.max(...flat) : 1)
  const span = hi - lo || 1

  const fmt = (v: number) => {
    const s = Math.abs(v) >= 1000 ? v.toLocaleString() : `${Math.round(v * 100) / 100}`
    return unit ? `${s}${unit}` : s
  }

  return (
    <div className="heatmap-panel">
      {title && <div className="heatmap-title">{title}</div>}
      <div className="heatmap-scroll">
        <table className="heatmap-grid">
          {xLabels && xLabels.length > 0 && (
            <thead>
              <tr>
                {yLabels && <th className="heatmap-corner" />}
                {xLabels.map((x, i) => (
                  <th key={i} className="heatmap-xlabel" title={x}>
                    <span>{x}</span>
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {yLabels && (
                  <th className="heatmap-ylabel" title={yLabels[ri]}>
                    {yLabels[ri] ?? ri}
                  </th>
                )}
                {row.map((val, ci) => {
                  const num = typeof val === "number" && !isNaN(val) ? val : null
                  const t = num === null ? -1 : (num - lo) / span
                  const bg = num === null ? "transparent" : heatColor(t)
                  const light = t > 0.45 && t < 0.85
                  return (
                    <td
                      key={ci}
                      className={`heatmap-cell${num === null ? " empty" : ""}`}
                      style={{ background: bg, color: light ? "#0d1117" : "#f0f6fc" }}
                      title={num === null ? "—" : fmt(num)}
                    >
                      {num === null ? "" : fmt(num)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="heatmap-legend">
        <span className="heatmap-legend-label">{fmt(lo)}</span>
        <div className="heatmap-legend-bar" />
        <span className="heatmap-legend-label">{fmt(hi)}</span>
      </div>
    </div>
  )
}
