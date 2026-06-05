import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import Sidebar from "./components/Sidebar"
import TabBar from "./components/TabBar"
import TerminalPane from "./components/TerminalPane"
import SplitView from "./components/SplitView"
import StatusBar from "./components/StatusBar"
import PanelDrawer, { PanelState } from "./components/PanelDrawer"
import DropZone from "./components/DropZone"
import CommandPalette, { Command } from "./components/CommandPalette"
import ToastHost from "./components/ToastHost"
import ShortcutsHelp from "./components/ShortcutsHelp"
import HistorySearch from "./components/HistorySearch"
import MissionPrompt, { Autonomy } from "./components/MissionPrompt"
import MissionsList, { Mission } from "./components/MissionsList"

// TypeScript type for the API exposed by preload
declare global {
  interface Window {
    api: {
      // Terminal-tier transport (xterm I/O) — keyed by live PTY id
      writeToSession: (id: string, data: string) => void
      resizeSession: (id: string, cols: number, rows: number) => void
      renameSession: (id: string, newName: string) => Promise<boolean>
      getSessionOutput: (id: string, maxChars?: number) => Promise<string | null>
      searchSessionOutput: (query: string, sessionId?: string, limit?: number) => Promise<
        { sessionId: string; name: string; line: number; text: string }[]
      >
      onSessionData: (callback: (id: string, data: string) => void) => void
      onSessionFocus: (callback: (id: string) => void) => void
      // Work-session (container) tier
      listWorkSessions: () => Promise<any[]>
      openWorkSession: (cwd?: string) => Promise<{ session: any; terminalId: string }>
      addTerminal: (sessionId: string, cwd?: string) => Promise<{ terminalId: string } | undefined>
      reopenTerminal: (sessionId: string, terminalId: string) => Promise<{ terminalId: string } | undefined>
      closeTerminal: (sessionId: string, terminalId: string) => Promise<void>
      killWorkSession: (sessionId: string) => Promise<void>
      getWorkSessionContext: (sessionId: string) => Promise<string | undefined>
      onWorkSessionUpdated: (callback: (session: any) => void) => void
      onWorkSessionRemoved: (callback: (id: string) => void) => void
      // Workspaces / config
      getWorkspaces: () => Promise<any[]>
      activateWorkspace: (index: number) => Promise<any>
      getConfig: () => Promise<any>
      // Split panes (terminal ids)
      onSplitSet: (callback: (leftId: string, rightId: string) => void) => void
      onSplitClose: (callback: () => void) => void
      // UI control events from MCP tools
      onUiFocusMode: (callback: (enabled?: boolean) => void) => void
      onUiDrawer: (callback: (collapsed?: boolean) => void) => void
      onUiCommandPalette: (callback: (open?: boolean) => void) => void
      onUiShortcutsHelp: (callback: (open?: boolean) => void) => void
      onUiHistorySearch: (callback: (open?: boolean) => void) => void
      onUiExportLog: (callback: (sessionId: string | null) => void) => void
      // App testing / drops
      saveDroppedImage: (base64: string, filename: string) => Promise<string>
      // Panels
      showPanel: (type: string, props: Record<string, any>, position?: string) => Promise<PanelState>
      listPanels: () => Promise<PanelState[]>
      hidePanel: (id: string) => Promise<boolean>
      hideAllPanels: () => Promise<void>
      submitForm: (id: string, data: Record<string, any>) => void
      // Notifications
      listNotifications: () => Promise<any[]>
      dismissNotification: (id: string) => Promise<boolean>
      onNotificationShow: (callback: (notification: any) => void) => void
      onNotificationDismiss: (callback: (id: string) => void) => void
      onPanelShow: (callback: (panel: PanelState) => void) => void
      onPanelUpdate: (callback: (payload: { id: string; props: any }) => void) => void
      onPanelHide: (callback: (id: string) => void) => void
      onPanelHideAll: (callback: () => void) => void
      // Missions
      createMission: (goal: string, cwd: string, autonomy?: string) => Promise<any>
      listMissions: () => Promise<any[]>
      getMissionStatus: (id?: string) => Promise<any>
      stopMission: (id: string) => Promise<any>
      pauseMission: (id: string) => Promise<any>
      resumeMission: (id: string) => Promise<any>
      removeAllListeners: (channel: string) => void
      getSessionOverview: (sessionId: string) => Promise<any>
      handoffTerminal: (sessionId: string, terminalId: string) => Promise<{ terminalId: string } | undefined>
    }
  }
}

interface Terminal {
  id: string
  name: string
  cwd: string
  lastState: "active" | "idle" | "dead"
  activity?: string
}

interface WorkSession {
  id: string
  name: string
  status: "active" | "stopped"
  summary: string
  terminals: Terminal[]
}

export default function App() {
  const [sessions, setSessions] = useState<WorkSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<any[]>([])
  const [splitLeft, setSplitLeft] = useState<string | null>(null)
  const [splitRight, setSplitRight] = useState<string | null>(null)
  const [config, setConfig] = useState<any>(null)
  const [panels, setPanels] = useState<PanelState[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [drawerCollapsed, setDrawerCollapsed] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [missionPromptOpen, setMissionPromptOpen] = useState(false)
  const [missionsListOpen, setMissionsListOpen] = useState(false)
  const [missions, setMissions] = useState<Mission[]>([])
  const [zenMode, setZenMode] = useState(false)

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null
  const activeTerminals = activeSession?.terminals ?? []
  const activeTerminal = activeTerminals.find((t) => t.id === activeTerminalId) ?? null

  // Load workspaces, config, and existing session records on mount (no spawn).
  useEffect(() => {
    window.api.getWorkspaces().then(setWorkspaces)
    window.api.getConfig().then(setConfig)
    window.api.listWorkSessions().then((list: WorkSession[]) => {
      setSessions(list)
      if (list.length) {
        setActiveSessionId(list[0].id)
        setActiveTerminalId(list[0].terminals[0]?.id ?? null)
      }
    })
  }, [])

  // Listen for container + terminal events from the main process
  useEffect(() => {
    window.api.onWorkSessionUpdated((updated: WorkSession) => {
      setSessions((prev) => {
        const i = prev.findIndex((s) => s.id === updated.id)
        if (i === -1) return [...prev, updated]
        const next = [...prev]
        next[i] = updated
        return next
      })
      setActiveSessionId((cur) => cur ?? updated.id)
      setActiveTerminalId(
        (cur) => cur ?? updated.terminals[updated.terminals.length - 1]?.id ?? null,
      )
    })

    window.api.onWorkSessionRemoved((id: string) => {
      setSessions((prev) => prev.filter((s) => s.id !== id))
      setActiveSessionId((cur) => (cur === id ? null : cur))
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

    // Switch the visible terminal when the focus_session MCP tool fires.
    window.api.onSessionFocus((id) => setActiveTerminalId(id))

    // UI control events from MCP tools. A boolean payload sets the state
    // explicitly; undefined toggles it (functional updates keep this correct
    // despite the once-on-mount registration).
    const setOrToggle =
      (setter: React.Dispatch<React.SetStateAction<boolean>>) => (value?: boolean) =>
        setter((cur) => (typeof value === "boolean" ? value : !cur))

    window.api.onUiFocusMode(setOrToggle(setZenMode))
    window.api.onUiCommandPalette(setOrToggle(setPaletteOpen))
    window.api.onUiShortcutsHelp(setOrToggle(setHelpOpen))
    window.api.onUiHistorySearch(setOrToggle(setHistoryOpen))
    window.api.onUiDrawer((collapsed) =>
      setDrawerCollapsed((cur) => (typeof collapsed === "boolean" ? collapsed : !cur)),
    )
    window.api.onUiExportLog((id) => exportLogRef.current(id ?? undefined))

    // Panel events from main process (triggered by MCP tools)
    window.api.onPanelShow((panel) => {
      setPanels((prev) => [...prev.filter((p) => p.id !== panel.id), panel])
    })

    window.api.onPanelUpdate(({ id, props }) => {
      setPanels((prev) => prev.map((p) => (p.id === id ? { ...p, props } : p)))
    })

    window.api.onPanelHide((id) => {
      setPanels((prev) => prev.filter((p) => p.id !== id))
    })

    window.api.onPanelHideAll(() => {
      setPanels([])
    })

    return () => {
      window.api.removeAllListeners("worksession:updated")
      window.api.removeAllListeners("worksession:removed")
      window.api.removeAllListeners("split:set")
      window.api.removeAllListeners("split:close")
      window.api.removeAllListeners("session:focus")
      window.api.removeAllListeners("ui:focus-mode")
      window.api.removeAllListeners("ui:drawer")
      window.api.removeAllListeners("ui:command-palette")
      window.api.removeAllListeners("ui:shortcuts-help")
      window.api.removeAllListeners("ui:history-search")
      window.api.removeAllListeners("ui:export-log")
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
    if (e.relatedTarget === null) setDragActive(false)
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setDragActive(false)
      const file = Array.from(e.dataTransfer.files).find((f) =>
        f.type.startsWith("image/"),
      )
      if (!file) return
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.readAsDataURL(file)
      })
      const path = await window.api.saveDroppedImage(base64, file.name)
      await window.api.showPanel("image", { src: path, alt: file.name })
      if (activeTerminalId) {
        window.api.writeToSession(activeTerminalId, `"${path}" `)
      }
    },
    [activeTerminalId],
  )

  // Send text straight into the active terminal (used by the diff review button).
  const sendToActiveSession = useCallback(
    (text: string): boolean => {
      if (!activeTerminalId) return false
      window.api.writeToSession(activeTerminalId, `\x1b[200~${text}\x1b[201~\r`)
      return true
    },
    [activeTerminalId],
  )

  const handleNewSession = useCallback(() => {
    window.api.openWorkSession("")
  }, [])

  const handleNewTerminal = useCallback(() => {
    if (activeSessionId) window.api.addTerminal(activeSessionId, "")
    else window.api.openWorkSession("")
  }, [activeSessionId])

  const handleCloseTerminal = useCallback(() => {
    if (activeSessionId && activeTerminalId) {
      window.api.closeTerminal(activeSessionId, activeTerminalId)
    }
  }, [activeSessionId, activeTerminalId])

  const handleHandoff = useCallback(async () => {
    if (!activeSessionId || !activeTerminalId) return
    const r = await window.api.handoffTerminal(activeSessionId, activeTerminalId)
    if (r?.terminalId) setActiveTerminalId(r.terminalId)
  }, [activeSessionId, activeTerminalId])

  const handleKillSession = useCallback(() => {
    if (!activeSessionId) return
    if (window.confirm("Kill this session and all its terminals? This deletes its record.")) {
      window.api.killWorkSession(activeSessionId)
    }
  }, [activeSessionId])

  const handleRenameTerminal = useCallback((id: string, newName: string) => {
    window.api.renameSession(id, newName)
  }, [])

  const handleSelectSession = useCallback(
    (id: string) => {
      setActiveSessionId(id)
      const s = sessions.find((x) => x.id === id)
      setActiveTerminalId(s?.terminals[0]?.id ?? null)
    },
    [sessions],
  )

  const handleSelectTerminal = useCallback(
    async (sessionId: string, terminalId: string) => {
      setActiveSessionId(sessionId)
      const s = sessions.find((x) => x.id === sessionId)
      const ref = s?.terminals.find((t) => t.id === terminalId)
      if (ref && ref.lastState === "dead") {
        const r = await window.api.reopenTerminal(sessionId, terminalId) // 3a: fresh primed reopen
        if (r?.terminalId) setActiveTerminalId(r.terminalId)
      } else {
        setActiveTerminalId(terminalId)
      }
    },
    [sessions],
  )

  const toggleSplit = useCallback(() => {
    if (splitLeft) {
      setSplitLeft(null)
      setSplitRight(null)
    } else if (activeTerminals.length >= 2 && activeTerminalId) {
      const other = activeTerminals.find((t) => t.id !== activeTerminalId)
      if (other) {
        setSplitLeft(activeTerminalId)
        setSplitRight(other.id)
      }
    }
  }, [splitLeft, activeTerminals, activeTerminalId])

  const toggleDrawer = useCallback(() => {
    if (panels.some((p) => p.visible)) setDrawerCollapsed((c) => !c)
  }, [panels])

  // Save a terminal's captured scrollback to a downloaded .txt file.
  const handleExportLog = useCallback(
    async (id?: string) => {
      const target = id ?? activeTerminalId
      if (!target) return
      const text = await window.api.getSessionOutput(target, 100000)
      if (text == null) return
      const name =
        sessions.flatMap((s) => s.terminals).find((t) => t.id === target)?.name ?? target
      const blob = new Blob([text], { type: "text/plain" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `${name}-output.txt`
      a.click()
      URL.revokeObjectURL(url)
    },
    [activeTerminalId, sessions],
  )

  const exportLogRef = useRef(handleExportLog)
  useEffect(() => {
    exportLogRef.current = handleExportLog
  }, [handleExportLog])

  // Open (or refresh) a mission's dashboard panel.
  const openMission = useCallback((m: { id: string }) => {
    const panel: PanelState = {
      id: `mission-${m.id}`,
      type: "mission",
      position: "right",
      props: m,
      visible: true,
    }
    setPanels((prev) => [...prev.filter((p) => p.id !== panel.id), panel])
    setDrawerCollapsed(false)
  }, [])

  const openOverview = useCallback(async (sessionId: string) => {
    const ov = await window.api.getSessionOverview(sessionId)
    if (!ov) return
    const panel: PanelState = {
      id: `overview-${sessionId}`,
      type: "session-overview",
      position: "right",
      props: {
        ...ov,
        onReopenTerminal: (terminalId: string) => window.api.reopenTerminal(sessionId, terminalId),
      },
      visible: true,
    }
    setPanels((prev) => [...prev.filter((p) => p.id !== panel.id), panel])
    setDrawerCollapsed(false)
  }, [])

  // Create a mission from the prompt overlay, then open its dashboard panel.
  const createMission = useCallback(
    async (goal: string, autonomy: Autonomy) => {
      const cwd = activeSession?.terminals[0]?.cwd ?? ""
      const m = await window.api.createMission(goal, cwd, autonomy)
      openMission(m)
    },
    [activeSession, openMission],
  )

  const hasLiveMissionPanel = panels.some(
    (p) =>
      p.type === "mission" &&
      p.visible &&
      !["done", "stopped"].includes((p.props as { status?: string })?.status ?? ""),
  )
  useEffect(() => {
    if (!missionsListOpen && !hasLiveMissionPanel) return
    let cancelled = false
    const refresh = async () => {
      const list = (await window.api.listMissions()) as Mission[]
      if (cancelled) return
      setMissions(list)
      setPanels((prev) =>
        prev.map((p) => {
          if (p.type !== "mission") return p
          const m = list.find((x) => `mission-${x.id}` === p.id)
          return m ? { ...p, props: m } : p
        }),
      )
    }
    refresh()
    const t = setInterval(refresh, 3000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [missionsListOpen, hasLiveMissionPanel])

  // Commands surfaced in the Ctrl+Shift+P command palette.
  const commands = useMemo<Command[]>(() => {
    const base: Command[] = [
      { id: "new", label: "New Session", hint: "Ctrl+N", run: handleNewSession },
      { id: "new-terminal", label: "New Terminal", hint: "Ctrl+T", run: handleNewTerminal },
      { id: "close-terminal", label: "Close Active Terminal", hint: "Ctrl+W", run: handleCloseTerminal },
      { id: "kill", label: "Kill Active Session", hint: "Ctrl+K", run: handleKillSession },
      { id: "split", label: splitLeft ? "Close Split View" : "Split Panes", hint: "Ctrl+\\", run: toggleSplit },
      { id: "drawer", label: "Toggle Panel Drawer", hint: "Ctrl+P", run: toggleDrawer },
      { id: "hide-panels", label: "Close All Panels", keywords: "hide clear", run: () => { setPanels([]); window.api.hideAllPanels() } },
      { id: "history", label: "Search Session History", hint: "Ctrl+Shift+F", keywords: "find output log scrollback", run: () => setHistoryOpen(true) },
      { id: "export-log", label: "Export Active Terminal Log", keywords: "save download output history file", run: () => handleExportLog() },
      { id: "zen", label: zenMode ? "Exit Focus Mode" : "Enter Focus Mode", hint: "Ctrl+Shift+Z", keywords: "zen distraction free hide sidebar fullscreen", run: () => setZenMode((z) => !z) },
      { id: "shortcuts", label: "Keyboard Shortcuts", hint: "Ctrl+/", keywords: "help keys bindings", run: () => setHelpOpen(true) },
      { id: "mission", label: "Start Mission…", keywords: "orchestrate conductor autonomous build", run: () => setMissionPromptOpen(true) },
      { id: "missions", label: "View Missions", keywords: "orchestrate conductor list dashboard status", run: () => setMissionsListOpen(true) },
      { id: "session-overview", label: "Show Session Overview", keywords: "context summary findings notes birdseye", run: () => activeSessionId && openOverview(activeSessionId) },
      { id: "handoff", label: "Retire & Continue Terminal", hint: "Ctrl+Shift+H", keywords: "handoff flush summary fresh terminal retire context", run: () => handleHandoff() },
    ]
    const sessionCmds: Command[] = sessions.map((s, i) => ({
      id: `switch-${s.id}`,
      label: `Switch to: ${s.name}`,
      hint: i < 9 ? `Ctrl+${i + 1}` : undefined,
      keywords: "session focus",
      run: () => handleSelectSession(s.id),
    }))
    return [...base, ...sessionCmds]
  }, [handleNewSession, handleNewTerminal, handleCloseTerminal, handleKillSession, handleHandoff, toggleSplit, toggleDrawer, handleExportLog, handleSelectSession, zenMode, splitLeft, sessions, openOverview, activeSessionId])

  // Keyboard shortcuts — use capture phase so they fire before xterm.js
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault(); e.stopPropagation()
        setPaletteOpen((o) => !o)
      } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault(); e.stopPropagation()
        setHistoryOpen((o) => !o)
      } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault(); e.stopPropagation()
        setZenMode((z) => !z)
      } else if (e.ctrlKey && e.key === "/") {
        e.preventDefault(); e.stopPropagation()
        setHelpOpen((o) => !o)
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
        // Ctrl+N — new session
        e.preventDefault(); e.stopPropagation()
        handleNewSession()
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "t") {
        // Ctrl+T — new terminal in the active session (or a new session if none)
        e.preventDefault(); e.stopPropagation()
        handleNewTerminal()
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "w") {
        // Ctrl+W — close the active terminal (session stays alive if it was the last)
        e.preventDefault(); e.stopPropagation()
        handleCloseTerminal()
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        // Ctrl+K — kill the active session (confirm)
        e.preventDefault(); e.stopPropagation()
        handleKillSession()
      } else if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === "h") {
        // Ctrl+Shift+H — retire & continue (handoff): flush summary, fresh terminal,
        // retire old. NOT plain Ctrl+H: that's ASCII Backspace (^H), so swallowing
        // it here would eat the user's backspace inside the terminal prompt.
        e.preventDefault(); e.stopPropagation()
        handleHandoff()
      } else if (e.ctrlKey && e.key === "\\") {
        e.preventDefault(); e.stopPropagation()
        toggleSplit()
      } else if (e.ctrlKey && e.key === "Tab") {
        // Ctrl+Tab / Ctrl+Shift+Tab — cycle terminals within the active session
        e.preventDefault(); e.stopPropagation()
        if (activeTerminals.length) {
          const i = Math.max(0, activeTerminals.findIndex((t) => t.id === activeTerminalId))
          const next = e.shiftKey
            ? (i - 1 + activeTerminals.length) % activeTerminals.length
            : (i + 1) % activeTerminals.length
          setActiveTerminalId(activeTerminals[next].id)
        }
      } else if (e.ctrlKey && e.key === "p") {
        e.preventDefault(); e.stopPropagation()
        if (panels.some((p) => p.visible)) {
          setDrawerCollapsed((c) => !c)
        }
      } else if (e.key === "Escape" && helpOpen) {
        e.preventDefault(); e.stopPropagation()
        setHelpOpen(false)
      } else if (e.key === "Escape") {
        const visible = panels.filter((p) => p.visible)
        if (visible.length > 0 && !drawerCollapsed) {
          e.preventDefault(); e.stopPropagation()
          handleClosePanel(visible[visible.length - 1].id)
        }
      } else if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key >= "1" && e.key <= "9") {
        // Alt+1–9 — switch terminal within the active session
        e.preventDefault(); e.stopPropagation()
        const t = activeTerminals[parseInt(e.key) - 1]
        if (t) setActiveTerminalId(t.id)
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key >= "1" && e.key <= "9") {
        // Ctrl+1–9 — switch session
        e.preventDefault(); e.stopPropagation()
        const s = sessions[parseInt(e.key) - 1]
        if (s) handleSelectSession(s.id)
      }
    }
    window.addEventListener("keydown", handler, { capture: true })
    return () => window.removeEventListener("keydown", handler, { capture: true })
  }, [handleNewSession, handleNewTerminal, handleCloseTerminal, handleKillSession, handleHandoff, toggleSplit, handleSelectSession, sessions, activeTerminals, activeTerminalId, panels, drawerCollapsed, handleClosePanel, helpOpen])

  return (
    <div
      className={`app${zenMode ? " zen" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <DropZone active={dragActive} />
      <ToastHost />
      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <HistorySearch
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onSelectSession={(id) => setActiveTerminalId(id)}
      />
      <MissionPrompt
        open={missionPromptOpen}
        onClose={() => setMissionPromptOpen(false)}
        onSubmit={createMission}
      />
      <MissionsList
        open={missionsListOpen}
        missions={missions}
        onClose={() => setMissionsListOpen(false)}
        onOpen={(m) => {
          openMission(m)
          setMissionsListOpen(false)
        }}
        onStop={(id) => window.api.stopMission(id)}
        onPause={(id) => window.api.pauseMission(id)}
        onResume={(id) => window.api.resumeMission(id)}
      />
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        workspaces={workspaces}
        onNewSession={handleNewSession}
        onKillSession={handleKillSession}
        onSelectSession={handleSelectSession}
        onSelectWorkspace={(index) => window.api.activateWorkspace(index)}
        onShowOverview={openOverview}
      />
      <div className="main-area">
        <TabBar
          terminals={activeTerminals}
          activeTerminalId={activeTerminalId}
          splitId={splitRight}
          onSelectTerminal={(id) => setActiveTerminalId(id)}
          onCloseTerminal={(id) => activeSessionId && window.api.closeTerminal(activeSessionId, id)}
          onRenameTerminal={handleRenameTerminal}
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
              activeId={activeTerminalId ?? splitLeft}
              onSelectSession={(id) => setActiveTerminalId(id)}
              theme={config?.theme}
              fontFamily={config?.fontFamily}
              fontSize={config?.fontSize}
            />
          ) : (
            <>
              {activeTerminals.map((t) => (
                <TerminalPane
                  key={t.id}
                  sessionId={t.id}
                  active={t.id === activeTerminalId}
                  theme={config?.theme}
                  fontFamily={config?.fontFamily}
                  fontSize={config?.fontSize}
                />
              ))}
              {activeTerminals.length === 0 && (
                <div className="empty-state">
                  <p>No active terminal.</p>
                  <p>Create a session to get started.</p>
                  <div className="shortcut-hints">
                    <span className="shortcut-key">Ctrl+N</span>
                    <span className="shortcut-desc">New session</span>
                    <span className="shortcut-key">Ctrl+T</span>
                    <span className="shortcut-desc">New terminal</span>
                    <span className="shortcut-key">Ctrl+W</span>
                    <span className="shortcut-desc">Close terminal</span>
                    <span className="shortcut-key">Ctrl+K</span>
                    <span className="shortcut-desc">Kill session</span>
                    <span className="shortcut-key">Ctrl+\</span>
                    <span className="shortcut-desc">Split panes</span>
                    <span className="shortcut-key">Ctrl+1-9</span>
                    <span className="shortcut-desc">Switch session</span>
                    <span className="shortcut-key">Alt+1-9</span>
                    <span className="shortcut-desc">Switch terminal</span>
                    <span className="shortcut-key">Ctrl+Shift+P</span>
                    <span className="shortcut-desc">Command palette</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
          {!drawerCollapsed && (
            <PanelDrawer
              panels={panels}
              onClose={handleClosePanel}
              onSendToSession={sendToActiveSession}
              onMissionStop={(id) => window.api.stopMission(id)}
              onMissionPause={(id) => window.api.pauseMission(id)}
            />
          )}
        </div>
        <StatusBar
          session={activeTerminal ? { id: activeTerminal.id, name: activeTerminal.name, state: activeTerminal.lastState } : null}
          sessionCount={sessions.length}
        />
      </div>
    </div>
  )
}
