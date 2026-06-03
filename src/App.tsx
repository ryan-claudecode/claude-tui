import { useState, useEffect, useCallback } from "react"
import Sidebar from "./components/Sidebar"
import TabBar from "./components/TabBar"
import TerminalPane from "./components/TerminalPane"
import StatusBar from "./components/StatusBar"

// TypeScript type for the API exposed by preload
declare global {
  interface Window {
    api: {
      createSession: (name: string, cwd: string) => Promise<any>
      killSession: (id: string) => Promise<boolean>
      focusSession: (id: string) => Promise<boolean>
      getSessions: () => Promise<any[]>
      writeToSession: (id: string, data: string) => void
      resizeSession: (id: string, cols: number, rows: number) => void
      getWorkspaces: () => Promise<any[]>
      activateWorkspace: (index: number) => Promise<any>
      triggerHandoff: (id: string) => Promise<boolean>
      onSessionData: (callback: (id: string, data: string) => void) => void
      onSessionExit: (callback: (id: string) => void) => void
      onSessionCreated: (callback: (session: any) => void) => void
      removeAllListeners: (channel: string) => void
    }
  }
}

interface Session {
  id: string
  name: string
  cwd: string
  state: string
}

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<any[]>([])

  // Load workspaces on mount
  useEffect(() => {
    window.api.getWorkspaces().then(setWorkspaces)
  }, [])

  // Listen for session events from main process
  useEffect(() => {
    window.api.onSessionCreated((session) => {
      setSessions((prev) => {
        if (prev.find((s) => s.id === session.id)) return prev
        return [...prev, session]
      })
      setActiveId(session.id)
    })

    window.api.onSessionExit((id) => {
      setSessions((prev) => prev.filter((s) => s.id !== id))
      setActiveId((prev) => {
        if (prev === id) {
          // Focus next available session
          return null // will be set by effect below
        }
        return prev
      })
    })

    return () => {
      window.api.removeAllListeners("session:created")
      window.api.removeAllListeners("session:exit")
    }
  }, [])

  // Auto-focus first session if active was removed
  useEffect(() => {
    if (!activeId && sessions.length > 0) {
      setActiveId(sessions[0].id)
    }
  }, [activeId, sessions])

  const handleNewSession = useCallback(async () => {
    const name = `session-${sessions.length + 1}`
    await window.api.createSession(name, "")
  }, [sessions.length])

  const handleKillSession = useCallback(async () => {
    if (activeId) {
      await window.api.killSession(activeId)
    }
  }, [activeId])

  const handleHandoff = useCallback(async () => {
    if (activeId) {
      await window.api.triggerHandoff(activeId)
    }
  }, [activeId])

  const handleSelectSession = useCallback((id: string) => {
    setActiveId(id)
  }, [])

  // Keyboard shortcuts — use capture phase so they fire before xterm.js
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "n") {
        e.preventDefault()
        e.stopPropagation()
        handleNewSession()
      } else if (e.ctrlKey && e.key === "k") {
        e.preventDefault()
        e.stopPropagation()
        handleKillSession()
      } else if (e.ctrlKey && e.key === "h") {
        e.preventDefault()
        e.stopPropagation()
        handleHandoff()
      } else if (e.ctrlKey && e.key >= "1" && e.key <= "9") {
        e.preventDefault()
        e.stopPropagation()
        const idx = parseInt(e.key) - 1
        if (idx < sessions.length) {
          setActiveId(sessions[idx].id)
        }
      }
    }
    window.addEventListener("keydown", handler, { capture: true })
    return () => window.removeEventListener("keydown", handler, { capture: true })
  }, [handleNewSession, handleKillSession, handleHandoff, sessions])

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        workspaces={workspaces}
        onNewSession={handleNewSession}
        onKillSession={handleKillSession}
        onHandoff={handleHandoff}
        onSelectSession={handleSelectSession}
      />
      <div className="main-area">
        <TabBar
          sessions={sessions}
          activeId={activeId}
          onSelectSession={handleSelectSession}
        />
        <div className="terminal-container">
          {sessions.map((session) => (
            <TerminalPane
              key={session.id}
              sessionId={session.id}
              active={session.id === activeId}
            />
          ))}
          {sessions.length === 0 && (
            <div className="empty-state">
              <p>No active session.</p>
              <p>Press Ctrl+N to create one.</p>
            </div>
          )}
        </div>
        <StatusBar
          session={sessions.find((s) => s.id === activeId) ?? null}
          sessionCount={sessions.length}
        />
      </div>
    </div>
  )
}
