import { useEffect, useRef } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"

interface Props {
  sessionId: string
  active: boolean
}

export default function TerminalPane({ sessionId, active }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  // Create terminal on mount
  useEffect(() => {
    if (!containerRef.current) return

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'Cascadia Code', 'JetBrains Mono', 'Fira Code', monospace",
      theme: {
        background: "#0d1117",
        foreground: "#c9d1d9",
        cursor: "#58a6ff",
        cursorAccent: "#0d1117",
        selectionBackground: "#264f78",
        black: "#0d1117",
        red: "#ff7b72",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39d353",
        white: "#c9d1d9",
        brightBlack: "#484f58",
        brightRed: "#ffa198",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d364",
        brightWhite: "#f0f6fc",
      },
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

  // Focus terminal when tab becomes active
  useEffect(() => {
    if (active && terminalRef.current) {
      terminalRef.current.focus()
      fitAddonRef.current?.fit()
    }
  }, [active])

  return (
    <div
      ref={containerRef}
      className={`terminal-pane ${active ? "active" : "hidden"}`}
    />
  )
}
