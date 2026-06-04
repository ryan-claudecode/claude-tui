import { useState } from "react"

interface DataPoint {
  label: string
  value: number
  color?: string
}

interface Props {
  kind?: "bar" | "line" | "pie"
  title?: string
  data?: DataPoint[]
  /** For line/bar: label for the value axis (shown in tooltip/legend). */
  unit?: string
}

// Pulled from the design-token accent palette so charts feel native to the app.
const PALETTE = [
  "#5aa6ff",
  "#44c45a",
  "#e3b341",
  "#bd8cff",
  "#ff5f57",
  "#42d4c4",
  "#ff9f40",
  "#7cbaff",
]

const colorFor = (i: number, explicit?: string) => explicit ?? PALETTE[i % PALETTE.length]

const fmt = (n: number) =>
  Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 })

export default function ChartPanel({ kind = "bar", title, data = [], unit }: Props) {
  if (data.length === 0) {
    return <div className="panel-empty">No chart data provided.</div>
  }

  return (
    <div className="chart-panel">
      {title && <h2 className="chart-title">{title}</h2>}
      <div className="chart-canvas">
        {kind === "bar" && <BarChart data={data} unit={unit} />}
        {kind === "line" && <LineChart data={data} unit={unit} />}
        {kind === "pie" && <PieChart data={data} />}
      </div>
      {(kind === "pie" || kind === "line") && <Legend data={data} />}
    </div>
  )
}

function Legend({ data }: { data: DataPoint[] }) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1
  return (
    <div className="chart-legend">
      {data.map((d, i) => (
        <div key={i} className="chart-legend-item">
          <span className="chart-swatch" style={{ background: colorFor(i, d.color) }} />
          <span className="chart-legend-label">{d.label}</span>
          <span className="chart-legend-value">
            {fmt(d.value)} ({Math.round((d.value / total) * 100)}%)
          </span>
        </div>
      ))}
    </div>
  )
}

function BarChart({ data, unit }: { data: DataPoint[]; unit?: string }) {
  const W = 600
  const H = 340
  const pad = { top: 16, right: 16, bottom: 48, left: 48 }
  const innerW = W - pad.left - pad.right
  const innerH = H - pad.top - pad.bottom
  const max = Math.max(...data.map((d) => d.value), 0) || 1
  const gap = innerW / data.length
  const barW = Math.min(56, gap * 0.62)
  const ticks = niceTicks(max, 4)
  const [hover, setHover] = useState<number | null>(null)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" preserveAspectRatio="xMidYMid meet">
      {ticks.map((t, i) => {
        const y = pad.top + innerH - (t / max) * innerH
        return (
          <g key={i}>
            <line x1={pad.left} y1={y} x2={W - pad.right} y2={y} className="chart-grid" />
            <text x={pad.left - 8} y={y + 4} className="chart-axis-label" textAnchor="end">
              {fmt(t)}
            </text>
          </g>
        )
      })}
      {data.map((d, i) => {
        const h = (d.value / max) * innerH
        const x = pad.left + i * gap + (gap - barW) / 2
        const y = pad.top + innerH - h
        return (
          <g
            key={i}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            className="chart-bar-group"
          >
            <rect
              x={x}
              y={y}
              width={barW}
              height={Math.max(h, 1)}
              rx={4}
              fill={colorFor(i, d.color)}
              className="chart-bar"
              opacity={hover === null || hover === i ? 1 : 0.45}
            />
            {hover === i && (
              <text x={x + barW / 2} y={y - 8} className="chart-value" textAnchor="middle">
                {fmt(d.value)}
                {unit ? ` ${unit}` : ""}
              </text>
            )}
            <text
              x={x + barW / 2}
              y={pad.top + innerH + 18}
              className="chart-axis-label"
              textAnchor="middle"
            >
              {truncate(d.label, 10)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function LineChart({ data, unit }: { data: DataPoint[]; unit?: string }) {
  const W = 600
  const H = 340
  const pad = { top: 16, right: 20, bottom: 48, left: 48 }
  const innerW = W - pad.left - pad.right
  const innerH = H - pad.top - pad.bottom
  const max = Math.max(...data.map((d) => d.value), 0) || 1
  const min = Math.min(...data.map((d) => d.value), 0)
  const span = max - min || 1
  const ticks = niceTicks(max, 4)
  const stepX = data.length > 1 ? innerW / (data.length - 1) : 0
  const [hover, setHover] = useState<number | null>(null)

  const pts = data.map((d, i) => ({
    x: pad.left + i * stepX,
    y: pad.top + innerH - ((d.value - min) / span) * innerH,
  }))
  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ")
  const areaPath = `${linePath} L${pts[pts.length - 1].x},${pad.top + innerH} L${pts[0].x},${pad.top + innerH} Z`

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="chartLineFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#5aa6ff" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#5aa6ff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {ticks.map((t, i) => {
        const y = pad.top + innerH - (t / max) * innerH
        return (
          <g key={i}>
            <line x1={pad.left} y1={y} x2={W - pad.right} y2={y} className="chart-grid" />
            <text x={pad.left - 8} y={y + 4} className="chart-axis-label" textAnchor="end">
              {fmt(t)}
            </text>
          </g>
        )
      })}
      <path d={areaPath} fill="url(#chartLineFill)" />
      <path d={linePath} className="chart-line" fill="none" />
      {pts.map((p, i) => (
        <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
          <circle cx={p.x} cy={p.y} r={hover === i ? 6 : 3.5} className="chart-dot" />
          <rect
            x={p.x - stepX / 2}
            y={pad.top}
            width={stepX || innerW}
            height={innerH}
            fill="transparent"
          />
          {hover === i && (
            <text x={p.x} y={p.y - 12} className="chart-value" textAnchor="middle">
              {fmt(data[i].value)}
              {unit ? ` ${unit}` : ""}
            </text>
          )}
          <text
            x={p.x}
            y={pad.top + innerH + 18}
            className="chart-axis-label"
            textAnchor="middle"
          >
            {truncate(data[i].label, 8)}
          </text>
        </g>
      ))}
    </svg>
  )
}

function PieChart({ data }: { data: DataPoint[] }) {
  const size = 320
  const cx = size / 2
  const cy = size / 2
  const r = size / 2 - 20
  const inner = r * 0.58 // donut hole
  const total = data.reduce((s, d) => s + d.value, 0) || 1
  const [hover, setHover] = useState<number | null>(null)

  let angle = -Math.PI / 2 // start at top
  const arcs = data.map((d, i) => {
    const slice = (d.value / total) * Math.PI * 2
    const start = angle
    const end = angle + slice
    angle = end
    return { d, i, start, end, slice }
  })

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="chart-svg chart-pie" preserveAspectRatio="xMidYMid meet">
      {arcs.map(({ d, i, start, end }) => {
        const path = donutSlice(cx, cy, r, inner, start, end)
        return (
          <path
            key={i}
            d={path}
            fill={colorFor(i, d.color)}
            className="chart-slice"
            opacity={hover === null || hover === i ? 1 : 0.4}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        )
      })}
      <text x={cx} y={cy - 6} className="chart-pie-total" textAnchor="middle">
        {hover === null ? fmt(total) : fmt(data[hover].value)}
      </text>
      <text x={cx} y={cy + 16} className="chart-pie-sub" textAnchor="middle">
        {hover === null ? "total" : truncate(data[hover].label, 14)}
      </text>
    </svg>
  )
}

// ── geometry / formatting helpers ──────────────────────────────────────────

function donutSlice(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  start: number,
  end: number,
): string {
  const large = end - start > Math.PI ? 1 : 0
  const x0 = cx + rOuter * Math.cos(start)
  const y0 = cy + rOuter * Math.sin(start)
  const x1 = cx + rOuter * Math.cos(end)
  const y1 = cy + rOuter * Math.sin(end)
  const x2 = cx + rInner * Math.cos(end)
  const y2 = cy + rInner * Math.sin(end)
  const x3 = cx + rInner * Math.cos(start)
  const y3 = cy + rInner * Math.sin(start)
  return [
    `M${x0},${y0}`,
    `A${rOuter},${rOuter} 0 ${large} 1 ${x1},${y1}`,
    `L${x2},${y2}`,
    `A${rInner},${rInner} 0 ${large} 0 ${x3},${y3}`,
    "Z",
  ].join(" ")
}

// Generate ~count "nice" round gridline values from 0..max.
function niceTicks(max: number, count: number): number[] {
  if (max <= 0) return [0]
  const raw = max / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag
  const ticks: number[] = []
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 100) / 100)
  return ticks
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}
