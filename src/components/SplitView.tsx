import { useCallback } from "react"
import TerminalPane from "./TerminalPane"

interface Props {
  leftId: string
  rightId: string
  activeId: string
  onSelectSession: (id: string) => void
  theme?: any
  fontFamily?: string
  fontSize?: number
}

export default function SplitView({
  leftId,
  rightId,
  activeId,
  onSelectSession,
  theme,
  fontFamily,
  fontSize,
}: Props) {
  const handleLeftClick = useCallback(() => onSelectSession(leftId), [onSelectSession, leftId])
  const handleRightClick = useCallback(() => onSelectSession(rightId), [onSelectSession, rightId])

  return (
    <div className="split-view">
      <div
        className={`split-pane ${activeId === leftId ? "focused" : ""}`}
        onMouseDown={handleLeftClick}
      >
        <TerminalPane
          sessionId={leftId}
          active={activeId === leftId}
          theme={theme}
          fontFamily={fontFamily}
          fontSize={fontSize}
        />
      </div>
      <div className="split-divider" />
      <div
        className={`split-pane ${activeId === rightId ? "focused" : ""}`}
        onMouseDown={handleRightClick}
      >
        <TerminalPane
          sessionId={rightId}
          active={activeId === rightId}
          theme={theme}
          fontFamily={fontFamily}
          fontSize={fontSize}
        />
      </div>
    </div>
  )
}
