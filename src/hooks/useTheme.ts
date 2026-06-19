import { useState, useEffect } from "react"

// Owns the renderer's theme mode: loads the persisted theme on mount, listens for
// theme:changed (MCP-driven switches), and applies the data-theme attribute on
// <html> reactively. Owns the cleanup for exactly the theme:changed listener.
export function useTheme() {
  const [themeMode, setThemeMode] = useState<string>("light")

  // Load persisted theme on mount and apply it.
  useEffect(() => {
    window.api.getTheme().then((mode) => {
      setThemeMode(mode)
      document.documentElement.setAttribute("data-theme", mode)
    })
    window.api.onThemeChanged((mode) => {
      setThemeMode(mode)
      document.documentElement.setAttribute("data-theme", mode)
    })
    return () => {
      window.api.removeAllListeners("theme:changed")
    }
  }, [])

  const setTheme = (mode: string) => window.api.setTheme(mode)

  return { themeMode, setTheme }
}
