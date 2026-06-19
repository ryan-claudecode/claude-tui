import { useEffect, useRef, useState } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { xtermThemes } from "../lib/xtermThemes"
import "@xterm/xterm/css/xterm.css"

interface Props {
  sessionId: string
  active: boolean
  lastState?: string
  themeMode?: string
  fontFamily?: string
  fontSize?: number
}

export default function TerminalPane({ sessionId, active, lastState, themeMode, fontFamily, fontSize }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [hasData, setHasData] = useState(false)

  // Create terminal on mount
  useEffect(() => {
    if (!containerRef.current) return

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: fontSize ?? 14,
      fontFamily: fontFamily ?? "'Cascadia Code', 'JetBrains Mono', 'Fira Code', monospace",
      theme: xtermThemes[themeMode ?? "light"] ?? xtermThemes.light,
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)

    terminal.open(containerRef.current)
    fitAddon.fit()

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    // Send terminal dimensions to main process
    const { cols, rows } = terminal
    window.api.resizeSession(sessionId, cols, rows)

    // Forward keyboard input to PTY
    terminal.onData((data) => {
      window.api.writeToSession(sessionId, data)
    })

    // Handle resize
    terminal.onResize(({ cols, rows }) => {
      window.api.resizeSession(sessionId, cols, rows)
    })

    // Listen for PTY data
    const dataHandler = (id: string, data: string) => {
      if (id === sessionId) {
        terminal.write(data)
        setHasData(true)
      }
    }
    window.api.onSessionData(dataHandler)

    // Resize observer
    const observer = new ResizeObserver(() => {
      fitAddon.fit()
    })
    observer.observe(containerRef.current)

    return () => {
      observer.disconnect()
      terminal.dispose()
    }
  }, [sessionId])

  // Update xterm theme when themeMode changes
  useEffect(() => {
    if (terminalRef.current && themeMode) {
      terminalRef.current.options.theme = xtermThemes[themeMode] ?? xtermThemes.light
    }
  }, [themeMode])

  // Focus terminal when tab becomes active
  useEffect(() => {
    if (active && terminalRef.current) {
      terminalRef.current.focus()
      fitAddonRef.current?.fit()
    }
  }, [active])

  const restoring = lastState === "dead" && !hasData

  return (
    <div
      ref={containerRef}
      className={`terminal-pane ${active ? "active" : "hidden"}`}
    >
      {restoring && (
        <div className="terminal-restoring">
          <div className="terminal-restoring-spinner" />
          <span>Restoring session...</span>
        </div>
      )}
    </div>
  )
}
