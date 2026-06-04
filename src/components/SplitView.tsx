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
  return (
    <div className="split-view">
      <div
        className={`split-pane ${activeId === leftId ? "focused" : ""}`}
        onClick={() => onSelectSession(leftId)}
      >
        <TerminalPane
          sessionId={leftId}
          active={true}
          theme={theme}
          fontFamily={fontFamily}
          fontSize={fontSize}
        />
      </div>
      <div className="split-divider" />
      <div
        className={`split-pane ${activeId === rightId ? "focused" : ""}`}
        onClick={() => onSelectSession(rightId)}
      >
        <TerminalPane
          sessionId={rightId}
          active={true}
          theme={theme}
          fontFamily={fontFamily}
          fontSize={fontSize}
        />
      </div>
    </div>
  )
}
