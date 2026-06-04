import { useState, useEffect, useCallback } from "react"
import Sidebar from "./components/Sidebar"
import TabBar from "./components/TabBar"
import TerminalPane from "./components/TerminalPane"
import SplitView from "./components/SplitView"
import StatusBar from "./components/StatusBar"
import PanelDrawer, { PanelState } from "./components/PanelDrawer"
import DropZone from "./components/DropZone"

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
      onSplitSet: (callback: (leftId: string, rightId: string) => void) => void
      onSplitClose: (callback: () => void) => void
      renameSession: (id: string, newName: string) => Promise<boolean>
      getConfig: () => Promise<any>
      saveDroppedImage: (base64: string, filename: string) => Promise<string>
      showPanel: (type: string, props: Record<string, any>, position?: string) => Promise<PanelState>
      listPanels: () => Promise<PanelState[]>
      hidePanel: (id: string) => Promise<boolean>
      hideAllPanels: () => Promise<void>
      submitForm: (id: string, data: Record<string, any>) => void
      onPanelShow: (callback: (panel: PanelState) => void) => void
      onPanelUpdate: (callback: (payload: { id: string; props: any }) => void) => void
      onPanelHide: (callback: (id: string) => void) => void
      onPanelHideAll: (callback: () => void) => void
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
  const [splitLeft, setSplitLeft] = useState<string | null>(null)
  const [splitRight, setSplitRight] = useState<string | null>(null)
  const [config, setConfig] = useState<any>(null)
  const [panels, setPanels] = useState<PanelState[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [drawerCollapsed, setDrawerCollapsed] = useState(false)

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

    // Split pane events from main process (triggered by MCP tools)
    window.api.onSplitSet((leftId, rightId) => {
      setSplitLeft(leftId)
      setSplitRight(rightId)
    })

    window.api.onSplitClose(() => {
      setSplitLeft(null)
      setSplitRight(null)
    })

    // Panel events from main process (triggered by MCP tools)
    window.api.onPanelShow((panel) => {
      setPanels((prev) => [...prev.filter((p) => p.id !== panel.id), panel])
    })

    window.api.onPanelUpdate(({ id, props }) => {
      setPanels((prev) =>
        prev.map((p) => (p.id === id ? { ...p, props } : p))
      )
    })

    window.api.onPanelHide((id) => {
      setPanels((prev) => prev.filter((p) => p.id !== id))
    })

    window.api.onPanelHideAll(() => {
      setPanels([])
    })

    return () => {
      window.api.removeAllListeners("session:created")
      window.api.removeAllListeners("session:exit")
      window.api.removeAllListeners("split:set")
      window.api.removeAllListeners("split:close")
      window.api.removeAllListeners("panel:show")
      window.api.removeAllListeners("panel:update")
      window.api.removeAllListeners("panel:hide")
      window.api.removeAllListeners("panel:hide-all")
    }
  }, [])

  const handleClosePanel = useCallback((id: string) => {
    setPanels((prev) => prev.filter((p) => p.id !== id))
    window.api.hidePanel(id)
  }, [])

  // Drag-and-drop image support
  const hasImage = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.items).some((it) => it.type.startsWith("image/"))

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (hasImage(e)) {
      e.preventDefault()
      setDragActive(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when leaving the window entirely
    if (e.relatedTarget === null) setDragActive(false)
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setDragActive(false)
      const file = Array.from(e.dataTransfer.files).find((f) =>
        f.type.startsWith("image/")
      )
      if (!file) return
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.readAsDataURL(file)
      })
      const path = await window.api.saveDroppedImage(base64, file.name)
      await window.api.showPanel("image", { src: path, alt: file.name })
      if (activeId) {
        window.api.writeToSession(activeId, `"${path}" `)
      }
    },
    [activeId]
  )

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
    if (id === splitLeft || id === splitRight) {
      setSplitLeft(null)
      setSplitRight(null)
    }
  }, [splitLeft, splitRight])

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
        if (splitLeft) {
          // Close split
          setSplitLeft(null)
          setSplitRight(null)
        } else if (sessions.length >= 2 && activeId) {
          // Open split: active session on left, next session on right
          const other = sessions.find(s => s.id !== activeId)
          if (other) {
            setSplitLeft(activeId)
            setSplitRight(other.id)
          }
        }
      } else if (e.ctrlKey && e.key === "p") {
        // Toggle the panel drawer (only meaningful when panels exist)
        e.preventDefault()
        e.stopPropagation()
        if (panels.some((p) => p.visible)) {
          setDrawerCollapsed((c) => !c)
        }
      } else if (e.key === "Escape") {
        // Close the most recently shown visible panel
        const visible = panels.filter((p) => p.visible)
        if (visible.length > 0 && !drawerCollapsed) {
          e.preventDefault()
          e.stopPropagation()
          handleClosePanel(visible[visible.length - 1].id)
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
  }, [handleNewSession, handleKillSession, handleHandoff, sessions, splitLeft, activeId, panels, drawerCollapsed, handleClosePanel])

  return (
    <div
      className="app"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <DropZone active={dragActive} />
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
          splitId={splitRight}
          onSelectSession={handleSelectSession}
          onKillSession={handleKillSessionById}
          onRenameSession={handleRenameSession}
        />
        <div
          className={`workspace-body ${
            !drawerCollapsed && panels.some((p) => p.visible && p.position === "bottom")
              ? "col"
              : "row"
          }`}
        >
        <div className="terminal-container">
          {splitLeft && splitRight ? (
            <SplitView
              leftId={splitLeft}
              rightId={splitRight}
              activeId={activeId ?? splitLeft}
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
                    <span className="shortcut-key">Ctrl+P</span>
                    <span className="shortcut-desc">Toggle panel drawer</span>
                    <span className="shortcut-key">Esc</span>
                    <span className="shortcut-desc">Close panel</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
          {!drawerCollapsed && <PanelDrawer panels={panels} onClose={handleClosePanel} />}
        </div>
        <StatusBar
          session={sessions.find((s) => s.id === activeId) ?? null}
          sessionCount={sessions.length}
        />
      </div>
    </div>
  )
}
