import { useState, useRef, useCallback, WheelEvent, MouseEvent } from "react"

interface Props {
  src?: string
  base64?: string
  alt?: string
}

export default function ImagePanel({ src, base64, alt = "image" }: Props) {
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragging = useRef(false)
  const last = useRef({ x: 0, y: 0 })

  const source = base64
    ? base64.startsWith("data:")
      ? base64
      : `data:image/png;base64,${base64}`
    : src
      ? src.startsWith("file:") || src.startsWith("http") || src.startsWith("data:")
        ? src
        : `file://${src}`
      : ""

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    setZoom((z) => Math.min(8, Math.max(0.1, z - e.deltaY * 0.001)))
  }, [])

  const handleMouseDown = (e: MouseEvent) => {
    dragging.current = true
    last.current = { x: e.clientX, y: e.clientY }
  }
  const handleMouseMove = (e: MouseEvent) => {
    if (!dragging.current) return
    const dx = e.clientX - last.current.x
    const dy = e.clientY - last.current.y
    last.current = { x: e.clientX, y: e.clientY }
    setOffset((o) => ({ x: o.x + dx, y: o.y + dy }))
  }
  const stopDrag = () => {
    dragging.current = false
  }

  const fit = () => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }

  if (!source) {
    return <div className="panel-empty">No image source provided.</div>
  }

  return (
    <div className="image-panel">
      <div className="image-toolbar">
        <button onClick={() => setZoom((z) => Math.min(8, z + 0.25))}>+</button>
        <button onClick={() => setZoom((z) => Math.max(0.1, z - 0.25))}>−</button>
        <button onClick={fit}>Fit</button>
        <span className="zoom-label">{Math.round(zoom * 100)}%</span>
      </div>
      <div
        className="image-viewport"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={stopDrag}
        onMouseLeave={stopDrag}
      >
        <img
          src={source}
          alt={alt}
          draggable={false}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          }}
        />
      </div>
    </div>
  )
}
