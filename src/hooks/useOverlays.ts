import { useState, useEffect } from "react"

// Owns the renderer-only overlay/view toggles (command palette, shortcuts help,
// history search, focus/zen mode) and the ui:* IPC listeners that MCP tools use
// to drive them. Owns the cleanup for exactly the listeners it registers:
// ui:focus-mode, ui:command-palette, ui:shortcuts-help, ui:history-search.
//
// ui:export-log stays in App.tsx with the export-log handler (it closes over the
// active terminal + session list via a ref), so it is deliberately NOT registered
// here — this hook owns only the overlays whose state lives entirely within it.
export function useOverlays() {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [zenMode, setZenMode] = useState(false)

  // UI control events from MCP tools. A boolean payload sets the state explicitly;
  // undefined toggles it (functional updates keep this correct despite the
  // once-on-mount registration).
  useEffect(() => {
    const setOrToggle =
      (setter: React.Dispatch<React.SetStateAction<boolean>>) => (value?: boolean) =>
        setter((cur) => (typeof value === "boolean" ? value : !cur))

    window.api.onUiFocusMode(setOrToggle(setZenMode))
    window.api.onUiCommandPalette(setOrToggle(setPaletteOpen))
    window.api.onUiShortcutsHelp(setOrToggle(setHelpOpen))
    window.api.onUiHistorySearch(setOrToggle(setHistoryOpen))

    return () => {
      window.api.removeAllListeners("ui:focus-mode")
      window.api.removeAllListeners("ui:command-palette")
      window.api.removeAllListeners("ui:shortcuts-help")
      window.api.removeAllListeners("ui:history-search")
    }
  }, [])

  return {
    paletteOpen,
    setPaletteOpen,
    helpOpen,
    setHelpOpen,
    historyOpen,
    setHistoryOpen,
    zenMode,
    setZenMode,
  }
}
