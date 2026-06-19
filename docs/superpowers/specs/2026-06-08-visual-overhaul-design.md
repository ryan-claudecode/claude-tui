# ClaudeTUI Visual Overhaul — Design Spec

**Date:** 2026-06-08
**Status:** Active

## Overview

A full visual and layout overhaul of ClaudeTUI. Replace the cold dark-navy aesthetic with a warm "Sand & Stone" design language — light mode by default, dark mode toggle, same warm color family in both. Simultaneously reshape the layout: seamless surfaces, pill tabs, generous spacing, rounded corners, flat fills, minimal chrome. Move the panel system from an in-app drawer to spawned companion windows.

The existing cold-dark theme is preserved as the "dark mode" option (re-tuned to the warm palette), and the current design token system in `App.css` is retained and extended — not replaced from scratch.

## Design Principles

1. **Warm over cold** — cream/linen surfaces, amber/sienna accents, warm browns for text. No blue tint anywhere in the chrome.
2. **Seamless over bordered** — surfaces blend via background tone shifts, not hard borders. Borders are used sparingly and subtly.
3. **Pill over box** — tabs are rounded pills, session items have capsule shapes, radii are 10-14px throughout.
4. **Breathe** — generous padding (12-16px rhythm), whitespace does the separation work.
5. **Hide until needed** — reduce always-visible chrome. No status bar, no keycap shortcut hints, session overview buttons appear on hover.
6. **Flat fills** — no gradients on any surface. Depth comes from background tone shifts and soft shadows.
7. **Terminal is a card** — the terminal viewport sits inset with margin and rounded corners, not edge-to-edge.

## Color Palettes

### Light Mode (default)

```
Surfaces:
  --bg-0: #f8f4ed    (main area, app base)
  --bg-1: #f1ece3    (sidebar, raised surfaces)
  --bg-2: #e8e0d4    (hover, pressed)
  --bg-3: #ded5c8    (active/selected backgrounds)

Terminal:
  --terminal-bg: #faf7f2
  --terminal-fg: #3a3028
  --terminal-dim: #6a5d4e
  --terminal-muted: #9a8d7e

Borders:
  --border: #e0d8cc
  --border-subtle: #e8e0d4

Text:
  --text-0: #2a2420    (headings, primary)
  --text-1: #3a3028    (body)
  --text-2: #6a5d4e    (secondary)
  --text-3: #9a8d7e    (muted, labels)

Accent:
  --accent: #c47a28          (burnt amber)
  --accent-hover: #b06a1e
  --accent-soft: rgba(196, 122, 40, 0.07)

Semantic:
  --green: #4a8a22     (active)
  --yellow: #d4a030    (idle)
  --red: #c44028       (error/kill)
```

### Dark Mode

```
Surfaces:
  --bg-0: #1c1814
  --bg-1: #16130f
  --bg-2: #231e19
  --bg-3: #2c2520

Terminal:
  --terminal-bg: #110f0c
  --terminal-fg: #d0c4b0
  --terminal-dim: #9a8a72
  --terminal-muted: #7a6d5a

Borders:
  --border: #2a2420
  --border-subtle: #231e19

Text:
  --text-0: #e8ddd0
  --text-1: #d0c4b0
  --text-2: #9a8d7e
  --text-3: #6a5d4e

Accent:
  --accent: #e0933a          (slightly brighter for dark-bg contrast)
  --accent-hover: #eba04a
  --accent-soft: rgba(224, 147, 58, 0.08)

Semantic:
  --green: #6abf4a
  --yellow: #d4a030
  --red: #e04a3a
```

### Legacy "Cold Dark" Theme

The current cold-navy palette (`--bg-0: #07090d` through `--accent: #5aa6ff`) is preserved as a third theme option. The existing `:root` values move behind a `[data-theme="cold-dark"]` selector. New tokens introduced by this spec (e.g. `--terminal-bg`, `--terminal-fg`) get cold-dark values mapped from the existing palette (e.g. `--terminal-bg: var(--bg-0)`, `--terminal-fg: #c4ccd6`).

## Theme System

Themes are implemented via CSS custom properties on the `:root` element, switched by a `data-theme` attribute on `<html>`.

- `data-theme="light"` (default) — Sand & Stone light
- `data-theme="dark"` — Sand & Stone dark  
- `data-theme="cold-dark"` — legacy cold-navy theme

The active theme is persisted in `~/.claude-tui/config.json` under `theme.mode` and loaded at startup by the main process, which sets the attribute before the renderer paints. A "Switch theme" command in the command palette (`Ctrl+Shift+P`) cycles through the three options and persists the choice.

The `config.json` `theme` object already exists (it has `fontSize`, `fontFamily`, `background`, `foreground`). The new `theme.mode` field coexists; the per-field overrides continue to work and take precedence over the theme defaults (so a user can be on "light" but override `fontFamily`).

xterm.js terminal colors are set programmatically via the `ITheme` option on the `Terminal` constructor. When the theme changes, each `TerminalPane` receives the new xterm theme via props/context and calls `terminal.options.theme = { ... }`.

## Layout Changes

### Sidebar

- **No hard border** — drop `border-right`. The sidebar uses `--bg-1` against the main area's `--bg-0`, creating a subtle tone shift.
- **Brand header** — keep `◈ ClaudeTUI`, restyle to match warm palette. No border-bottom, just spacing.
- **Section headers** — `WORKSPACES`, `SESSIONS` — same uppercase labels, warm muted color.
- **Session items** — rounded capsule shape (10px radius), selected state uses `--accent-soft` background. No left-edge bar indicator. Activity line stays as second row.
- **Action buttons** — replace keycap-styled shortcut hints with simple text buttons: `+ New session`. No `Ctrl+N` badge. Kill session stays as a simple text action below it. Keyboard shortcuts still work — they're just not advertised in the sidebar.
- **Overview button** — stays, shown on hover only (already the case).

### Tab Bar → Pill Header

- **No background fill or gradient** — the pill area sits on the main `--bg-0` surface.
- **No bottom border** — no separator between tabs and terminal.
- **Active tab** — filled pill. In light mode: dark fill (`#2a2420`), light text. In dark mode: light fill (`#e8ddd0`), dark text. The pill inverts naturally. Status dot inside.
- **Inactive tab** — ghost text, no background. Status dot.
- **Close button** — hidden by default, shown on hover.
- **New terminal button** — `+` in the same style as inactive tab text.
- **No divider lines** between tabs.
- **Horizontal overflow** — scrolls, same as current. `scrollbar-width: none` to hide the scrollbar.

### Terminal Viewport

- **Inset card** — margin on left, right, and bottom (e.g. `0 12px 12px`). Rounded corners (12px).
- **Light border** in light mode (`--border`), subtle border in dark mode.
- **Background matches terminal theme** — light terminal on light mode, dark on dark.
- **No padding change** to the terminal content itself — xterm.js handles its own padding.

### Status Bar

**Removed.** The information it showed (active session/terminal, shortcut hints) is redundant with the sidebar and tab bar or is being removed (shortcut hints). Transient status (build progress, connection state) uses toasts via `NotificationService.notify`.

### Empty State

Restyle the empty state (no sessions) to match the warm palette. Keep the centered layout, drop the radial gradient glow, use the same clean text styling. Shortcut hints grid either removed or converted to simple text.

## Panel System → Companion Windows

### Architecture Change

Replace the in-app `PanelDrawer` with Electron `BrowserWindow` children. The main window becomes purely: sidebar + pill tabs + terminal viewports.

**Default behavior (tabbed companion window):**
- First `show_panel` call creates a companion `BrowserWindow` (minimal frame, positioned to the right of the main window, sized to ~40% of screen width).
- Subsequent `show_panel` calls add tabs to the same companion window.
- The companion window has its own simple tab bar for switching between panels.
- Closing the companion window (or pressing Escape) dismisses all panels.
- When all panels are hidden/closed, the companion window closes.

**Separate window opt-in:**
- `show_panel` gains an optional `separate_window: true` parameter.
- When set, the panel opens in its own independent `BrowserWindow` instead of a tab in the companion.
- Use case: side-by-side viewing (e.g. a diff alongside a markdown spec).

**Form panels:**
- `show_form` still blocks the MCP call until the user submits.
- The form renders in the companion window (or its own window).
- Submission sends the data back to the main process via IPC, which resolves the pending promise in `PanelService`.

### Component Reuse

All existing panel components (`DiffPanel`, `FormPanel`, `MarkdownPanel`, `TablePanel`, `ChartPanel`, etc.) are reused as-is. They currently render inside `PanelDrawer`; they will render inside the companion window's content area instead. The routing logic (`PanelContent` switch in `PanelDrawer.tsx`) moves to the companion window's renderer.

The companion window gets its own small entry point (HTML + React root) that:
1. Receives panel state via IPC from the main process.
2. Renders the tab bar + active panel component.
3. Sends form submissions and close events back via IPC.

### What Gets Removed

- `PanelDrawer.tsx` — the sliding drawer component. Replaced by the companion window.
- `.panel-drawer`, `.panel-drawer-right`, `.panel-drawer-bottom` CSS — all drawer styles.
- `workspace-body` flex layout that accommodated the drawer — main area simplifies.
- Drawer collapse/expand toggle (`Ctrl+P` / `toggle_panel_drawer` MCP tool) — no longer meaningful. `Ctrl+P` can be repurposed or removed.
- The `onUiDrawer` preload listener and `UiService.toggleDrawer`.

### What Stays

- `PanelService` — still manages panel state (list of open panels, form promises). Just targets companion windows instead of IPC to the main renderer.
- All `show_panel` / `update_panel` / `hide_panel` / `hide_all_panels` / `list_panels` MCP tools — same interface, different rendering target.
- `show_form` blocking behavior — unchanged.
- All panel component files in `src/components/panels/` — unchanged.

## Files Affected

### New Files

| File | Purpose |
|------|---------|
| `src/companion/index.html` | Companion window HTML entry |
| `src/companion/Companion.tsx` | Companion window React root — tab bar + panel routing |
| `src/companion/companion.css` | Companion window styles (themed, matches main) |
| `electron/services/companion.ts` | `CompanionService` — manage companion `BrowserWindow` lifecycle, IPC bridge for panel state |

### Modified Files

| File | Change |
|------|--------|
| `src/App.css` | Replace `:root` color tokens with themed versions; remove gradients; update radii/spacing; remove status bar, drawer, and gradient styles; add pill tab styles |
| `src/App.tsx` | Remove `PanelDrawer` usage, status bar, drawer state/toggle; simplify layout to sidebar + tabs + terminal |
| `src/components/Sidebar.tsx` | Restyle: drop border, remove keycap hints, clean action buttons |
| `src/components/TabBar.tsx` | Restyle: pill tabs, no background bar, no dividers |
| `src/components/StatusBar.tsx` | Remove (file can be deleted or kept for legacy theme) |
| `src/components/TerminalPane.tsx` | Accept theme colors, pass to xterm.js |
| `electron/services/panels.ts` | Route panel show/hide to `CompanionService` instead of main window IPC |
| `electron/preload.ts` | Remove drawer-related listeners; add companion window IPC |
| `electron/ipc.ts` | Wire `CompanionService`; remove drawer toggle handler |
| `electron/mcp/tools.ts` | Add `separate_window` param to `show_panel`; remove `toggle_panel_drawer` |
| `electron/config.ts` | Read `theme.mode`, expose getter/setter |
| `electron/main.ts` | Set `data-theme` attribute on window creation; instantiate `CompanionService` |
| `electron.vite.config.ts` | Add companion window as a second renderer entry |
| `CLAUDE.md` | Update architecture diagram, panel system docs, remove status bar references |

### Removed

| File | Reason |
|------|--------|
| `src/components/PanelDrawer.tsx` | Replaced by companion window |
| `src/components/StatusBar.tsx` | Status bar removed |

## Theming Implementation Detail

CSS custom properties under `:root` provide the light defaults. Dark mode overrides via `[data-theme="dark"]`, cold-dark via `[data-theme="cold-dark"]`.

```css
:root, [data-theme="light"] {
  --bg-0: #f8f4ed;
  --bg-1: #f1ece3;
  /* ... light palette ... */
}

[data-theme="dark"] {
  --bg-0: #1c1814;
  --bg-1: #16130f;
  /* ... dark palette ... */
}

[data-theme="cold-dark"] {
  --bg-0: #07090d;
  --bg-1: #0b0e14;
  /* ... existing cold palette ... */
}
```

Theme switching: `document.documentElement.setAttribute("data-theme", mode)`. Persisted via config. The companion window inherits the same attribute.

## Scope Boundaries

**In scope:**
- Full recolor and layout restyle of the main window
- Theme system (light/dark/cold-dark) with persistence
- Companion window for panels (replacing drawer)
- Removing status bar
- xterm.js theme integration

**Out of scope (future work):**
- Theme editor UI / custom user themes beyond the three presets
- Sidebar resizing / collapsible icon rail
- Animation/transition polish (can be layered on after the structural changes land)
- Changing panel component internals (they render the same content, just in a new container)
- Touch/mobile considerations

## Build Phases

1. **Theme system + recolor** — CSS custom properties, light/dark/cold-dark palettes, theme toggle, xterm.js theme wiring. The app looks different but the layout is unchanged.
2. **Layout reshape** — pill tabs, seamless sidebar, terminal card, remove status bar, remove gradients, update spacing/radii. Structural CSS + component markup changes.
3. **Companion window** — new `CompanionService`, companion renderer entry, migrate panel routing from `PanelDrawer` to companion, remove drawer. The biggest architectural change.
4. **Polish + cleanup** — empty state restyle, toast restyle, command palette restyle, shortcuts overlay restyle, drop zone restyle. All the secondary UI surfaces.
