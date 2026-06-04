import { useState, useEffect, useCallback } from "react"
import Sidebar from "./components/Sidebar"
import TabBar from "./components/TabBar"
import TerminalPane from "./components/TerminalPane"
import SplitView from "./components/SplitView"
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
      renameSession: (id: string, newName: string) => Promise<boolean>
      getConfig: () => Promise<any>
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
  const [splitId, setSplitId] = useState<string | null>(null)
  const [config, setConfig] = useState<any>(null)

  // Load workspaces and config on mount
  useEffect(() => {
    window.api.getWorkspaces().then(setWorkspaces)
    window.api.getConfig().then(setConfig)
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

  const handleKillSessionById = useCallback(async (id: string) => {
    await window.api.killSession(id)
    // If we killed the split pane session, close split
    if (id === splitId) {
      setSplitId(null)
    }
  }, [splitId])

  const handleRenameSession = useCallback(async (id: string, newName: string) => {
    await window.api.renameSession(id, newName)
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, name: newName } : s))
    )
  }, [])

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
      } else if (e.ctrlKey && e.key === "\\") {
        e.preventDefault()
        e.stopPropagation()
        // Toggle split: if split is active, close it. Otherwise split with next session.
        if (splitId) {
          setSplitId(null)
        } else {
          const other = sessions.find(s => s.id !== activeId)
          if (other) setSplitId(other.id)
        }
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
  }, [handleNewSession, handleKillSession, handleHandoff, sessions, splitId, activeId])

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
        onSelectWorkspace={(index) => window.api.activateWorkspace(index)}
      />
      <div className="main-area">
        <TabBar
          sessions={sessions}
          activeId={activeId}
          splitId={splitId}
          onSelectSession={handleSelectSession}
          onKillSession={handleKillSessionById}
          onRenameSession={handleRenameSession}
        />
        <div className="terminal-container">
          {splitId && activeId ? (
            <SplitView
              leftId={activeId}
              rightId={splitId}
              activeId={activeId}
              onSelectSession={handleSelectSession}
              theme={config?.theme}
              fontFamily={config?.fontFamily}
              fontSize={config?.fontSize}
            />
          ) : (
            <>
              {sessions.map((session) => (
                <TerminalPane
                  key={session.id}
                  sessionId={session.id}
                  active={session.id === activeId}
                  theme={config?.theme}
                  fontFamily={config?.fontFamily}
                  fontSize={config?.fontSize}
                />
              ))}
              {sessions.length === 0 && (
                <div className="empty-state">
                  <p>No active session.</p>
                  <p>Create a session to get started.</p>
                  <div className="shortcut-hints">
                    <span className="shortcut-key">Ctrl+N</span>
                    <span className="shortcut-desc">New session</span>
                    <span className="shortcut-key">Ctrl+K</span>
                    <span className="shortcut-desc">Kill session</span>
                    <span className="shortcut-key">Ctrl+H</span>
                    <span className="shortcut-desc">Handoff</span>
                    <span className="shortcut-key">Ctrl+\</span>
                    <span className="shortcut-desc">Split panes</span>
                    <span className="shortcut-key">Ctrl+1-9</span>
                    <span className="shortcut-desc">Switch session</span>
                  </div>
                </div>
              )}
            </>
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
