interface Props {
  active: boolean
}

export default function DropZone({ active }: Props) {
  if (!active) return null
  return (
    <div className="drop-zone">
      <div className="drop-zone-inner">
        <div className="drop-zone-icon">🖼️</div>
        <div className="drop-zone-text">Drop image to share with Claude</div>
        <div className="drop-zone-sub">
          The image path is injected into the active session
        </div>
      </div>
    </div>
  )
}
