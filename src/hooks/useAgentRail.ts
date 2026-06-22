import { useCallback, useEffect, useState } from "react"
import { effectiveRailOpen, RAIL_WIDTH_FLOOR } from "../lib/agentRail"

/**
 * Agent Rail (v1) — owns the rail's open/collapsed state across three inputs:
 *   1. the persisted GLOBAL pref (`config.agentRail.open`, seeded on mount; a user
 *      toggle persists via `window.api.setAgentRailOpen`);
 *   2. the live viewport width (the responsive sub-{@link RAIL_WIDTH_FLOOR} auto-
 *      collapse, which NEVER writes the pref — a narrow window must not overwrite the
 *      saved choice);
 *   3. the `toggle()`/`setOpen()` actions wired to the chevron + the Ctrl+Alt+A
 *      shortcut + the command-palette entry.
 *
 * The effective open/closed is derived purely by {@link effectiveRailOpen}; this hook
 * is the thin React shell that feeds it the live width + the persisted collapse and
 * exposes the actions. Tested via the pure helper (src/lib/agentRail.test.ts).
 */
export function useAgentRail() {
  // The EXPLICIT user collapse (seeded from the persisted pref; `false` = open). This
  // is what persists — the width auto-collapse below is layered on top and never
  // mutates it.
  const [collapsed, setCollapsed] = useState(false)
  const [width, setWidth] = useState<number>(() =>
    typeof window !== "undefined" ? window.innerWidth : RAIL_WIDTH_FLOOR + 1,
  )

  // Seed the collapse from the persisted pref on mount. getConfig() carries the
  // projected `agentRail` field; absent/true → open, explicit false → collapsed.
  useEffect(() => {
    let cancelled = false
    window.api
      .getConfig()
      .then((cfg) => {
        if (cancelled) return
        if (cfg?.agentRail?.open === false) setCollapsed(true)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Track the live viewport width for the responsive auto-collapse. Listener-only —
  // it never persists; widening back past the floor restores the user's saved choice.
  useEffect(() => {
    if (typeof window === "undefined") return
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  // Persist + set the EXPLICIT collapse (the chevron / shortcut / palette). Writes the
  // pref so it survives a reload. `open` here is the user's desired open state.
  const setOpen = useCallback((open: boolean) => {
    setCollapsed(!open)
    void window.api.setAgentRailOpen?.(open)
  }, [])

  const toggle = useCallback(() => {
    setCollapsed((c) => {
      const next = !c
      void window.api.setAgentRailOpen?.(!next) // !next === the new OPEN state
      return next
    })
  }, [])

  const open = effectiveRailOpen({ collapsed, width })

  return { open, collapsed, width, toggle, setOpen }
}
