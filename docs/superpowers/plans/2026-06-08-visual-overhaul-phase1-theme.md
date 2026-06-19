# Visual Overhaul Phase 1: Theme System + Recolor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded cold-dark palette with a CSS-custom-property theme system supporting three modes (Sand & Stone light, Sand & Stone dark, legacy cold-dark), defaulting to light. Wire xterm.js to follow the active theme. The app looks different but layout is unchanged.

**Architecture:** All three palettes are defined as CSS custom property blocks switched by `[data-theme]` on `<html>`. The main process reads `theme.mode` from config, passes it to the renderer at load time, and writes changes back. `TerminalPane` maps the CSS palette to xterm.js `ITheme`. A "Switch theme" command is added to the command palette.

**Tech Stack:** CSS custom properties, Electron IPC, React context, xterm.js ITheme, vitest (node env for config tests).

**Testing approach:** Config changes get a node-level unit test. CSS/renderer changes are verified by `npm run typecheck` + `npm run build`. Visual verification via `take_screenshot` / running the app.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/App.css` | Design token definitions — three `[data-theme]` blocks | Modify (lines 1-68) |
| `electron/config.ts` | Read/write `theme.mode` from `~/.claude-tui/config.json` | Modify |
| `electron/config.test.ts` | Unit tests for config read/write | Create |
| `electron/main.ts` | Load theme mode, pass to renderer via webPreferences | Modify |
| `electron/ipc.ts` | Add `config:set-theme` handler | Modify |
| `electron/preload.ts` | Add `setTheme` + `getTheme` bridge | Modify |
| `src/App.tsx` | Initialize theme on mount, add theme switch to command palette | Modify |
| `src/components/TerminalPane.tsx` | Map active theme to xterm.js `ITheme` | Modify |
| `src/components/SplitView.tsx` | Pass theme mapping to child `TerminalPane`s | Modify |
| `src/lib/xtermThemes.ts` | xterm.js ITheme objects for each theme mode | Create |

---

## Task 1: Define the three CSS palettes

**Files:**
- Modify: `src/App.css` (lines 1-68)

- [ ] **Step 1: Replace the `:root` block with three themed blocks**

In `src/App.css`, replace everything from line 1 through line 68 (the closing `}` of `:root`) with:

```css
/* ============================================================
   ClaudeTUI — Design System
   Three themes: light (Sand & Stone), dark (Sand & Stone), cold-dark (legacy).
   Switched via data-theme attribute on <html>.
   ============================================================ */

:root, [data-theme="light"] {
  /* Surfaces — warm linen */
  --bg-0: #f8f4ed;
  --bg-1: #f1ece3;
  --bg-2: #e8e0d4;
  --bg-3: #ded5c8;
  --bg-4: #d4cbbe;
  --bg-5: #cac0b2;

  /* Terminal */
  --terminal-bg: #faf7f2;
  --terminal-fg: #3a3028;
  --terminal-dim: #6a5d4e;
  --terminal-muted: #9a8d7e;

  /* Borders */
  --border: #e0d8cc;
  --border-strong: #d4cbbe;
  --border-subtle: #e8e0d4;

  /* Text */
  --text-0: #2a2420;
  --text-1: #3a3028;
  --text-2: #6a5d4e;
  --text-3: #9a8d7e;
  --text-4: #b8ad9e;

  /* Accents */
  --accent: #c47a28;
  --accent-bright: #d4892e;
  --accent-dim: #b06a1e;
  --accent-glow: rgba(196, 122, 40, 0.35);
  --accent-soft: rgba(196, 122, 40, 0.07);

  --green: #4a8a22;
  --green-soft: rgba(74, 138, 34, 0.10);
  --red: #c44028;
  --red-soft: rgba(196, 64, 40, 0.10);
  --yellow: #d4a030;
  --purple: #8a5cc0;

  /* Radii */
  --r-sm: 6px;
  --r: 10px;
  --r-lg: 14px;
  --r-xl: 18px;

  /* Spacing scale */
  --s-1: 4px;
  --s-2: 8px;
  --s-3: 12px;
  --s-4: 16px;
  --s-5: 24px;
  --s-6: 32px;

  /* Shadows — lighter for light mode */
  --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.06);
  --shadow-2: 0 4px 16px rgba(0, 0, 0, 0.08);
  --shadow-3: 0 12px 40px rgba(0, 0, 0, 0.12);
  --shadow-glow: 0 0 0 1px var(--accent-soft), 0 4px 20px rgba(196, 122, 40, 0.08);

  /* Motion */
  --ease: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --fast: 0.12s;
  --med: 0.2s;

  --mono: "Cascadia Code", "JetBrains Mono", ui-monospace, monospace;

  /* Pill tab active fill — inverts between modes */
  --tab-active-bg: #2a2420;
  --tab-active-fg: #f0ebe2;
}

[data-theme="dark"] {
  --bg-0: #1c1814;
  --bg-1: #16130f;
  --bg-2: #231e19;
  --bg-3: #2c2520;
  --bg-4: #362e28;
  --bg-5: #403830;

  --terminal-bg: #110f0c;
  --terminal-fg: #d0c4b0;
  --terminal-dim: #9a8a72;
  --terminal-muted: #7a6d5a;

  --border: #2a2420;
  --border-strong: #362e28;
  --border-subtle: #231e19;

  --text-0: #e8ddd0;
  --text-1: #d0c4b0;
  --text-2: #9a8d7e;
  --text-3: #6a5d4e;
  --text-4: #4a4038;

  --accent: #e0933a;
  --accent-bright: #eba04a;
  --accent-dim: #c47a28;
  --accent-glow: rgba(224, 147, 58, 0.35);
  --accent-soft: rgba(224, 147, 58, 0.08);

  --green: #6abf4a;
  --green-soft: rgba(106, 191, 74, 0.12);
  --red: #e04a3a;
  --red-soft: rgba(224, 74, 58, 0.12);
  --yellow: #d4a030;
  --purple: #b08adf;

  --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.4);
  --shadow-2: 0 4px 16px rgba(0, 0, 0, 0.45);
  --shadow-3: 0 12px 40px rgba(0, 0, 0, 0.55);
  --shadow-glow: 0 0 0 1px var(--accent-soft), 0 4px 20px rgba(224, 147, 58, 0.10);

  --tab-active-bg: #e8ddd0;
  --tab-active-fg: #1c1814;
}

[data-theme="cold-dark"] {
  --bg-0: #07090d;
  --bg-1: #0b0e14;
  --bg-2: #0f131b;
  --bg-3: #141922;
  --bg-4: #1b2230;
  --bg-5: #232c3d;

  --terminal-bg: #0d1117;
  --terminal-fg: #c9d1d9;
  --terminal-dim: #8b949e;
  --terminal-muted: #6a7480;

  --border: #222a36;
  --border-strong: #2d3845;
  --border-subtle: #1a212b;

  --text-0: #f3f7fc;
  --text-1: #c4ccd6;
  --text-2: #8b949e;
  --text-3: #6a7480;
  --text-4: #454d57;

  --accent: #5aa6ff;
  --accent-bright: #7cbaff;
  --accent-dim: #3d7fd6;
  --accent-glow: rgba(90, 166, 255, 0.35);
  --accent-soft: rgba(90, 166, 255, 0.10);

  --green: #44c45a;
  --green-soft: rgba(68, 196, 90, 0.14);
  --red: #ff5f57;
  --red-soft: rgba(255, 95, 87, 0.14);
  --yellow: #e3b341;
  --purple: #bd8cff;

  --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.4);
  --shadow-2: 0 4px 16px rgba(0, 0, 0, 0.45);
  --shadow-3: 0 12px 40px rgba(0, 0, 0, 0.55);
  --shadow-glow: 0 0 0 1px var(--accent-soft), 0 4px 20px rgba(90, 166, 255, 0.12);

  --tab-active-bg: #f3f7fc;
  --tab-active-fg: #0b0e14;
}
```

- [ ] **Step 2: Update the `body` background to use tokens (remove hardcoded gradients)**

In `src/App.css`, find the `body { background: ... }` rule (around line 87-91) and replace the radial gradients + hardcoded color with:

```css
body {
  background: var(--bg-0);
}
```

- [ ] **Step 3: Update `::selection` to use tokens**

Find the `::selection` rule (around line 93-96) and replace:

```css
::selection {
  background: var(--accent-glow);
  color: var(--text-0);
}
```

(This already uses vars, so verify and move on if already correct.)

- [ ] **Step 4: Update `backgroundColor` in `electron/main.ts`**

In `electron/main.ts`, change the hardcoded `backgroundColor`:

```typescript
    backgroundColor: "#f8f4ed",
```

(This is the flash-prevention color. It should match the default light theme `--bg-0`.)

- [ ] **Step 5: Verify typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/App.css electron/main.ts
git commit -m "feat: define three CSS theme palettes (light/dark/cold-dark)"
```

---

## Task 2: Config — read/write `theme.mode`

**Files:**
- Modify: `electron/config.ts`
- Create: `electron/config.test.ts`

- [ ] **Step 1: Write a failing test for `getThemeMode` / `setThemeMode`**

Create `electron/config.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest"
import { getThemeMode, setThemeMode, type ThemeMode } from "./config"
import * as fs from "node:fs"

vi.mock("node:fs")

describe("theme mode config", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("getThemeMode returns 'light' when config file is missing", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ENOENT")
    })
    expect(getThemeMode()).toBe("light")
  })

  it("getThemeMode returns stored theme.mode", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ theme: { mode: "dark" } })
    )
    expect(getThemeMode()).toBe("dark")
  })

  it("getThemeMode returns 'light' when theme.mode is missing", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ theme: { fontSize: 14 } })
    )
    expect(getThemeMode()).toBe("light")
  })

  it("setThemeMode writes theme.mode to config", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ theme: { fontSize: 14 } })
    )
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {})
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined as any)

    setThemeMode("cold-dark")

    expect(writeSpy).toHaveBeenCalledTimes(1)
    const written = JSON.parse(writeSpy.mock.calls[0][1] as string)
    expect(written.theme.mode).toBe("cold-dark")
    expect(written.theme.fontSize).toBe(14) // preserves other fields
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/config.test.ts`
Expected: FAIL — `getThemeMode` is not exported from `./config`.

- [ ] **Step 3: Add `getThemeMode` and `setThemeMode` to `electron/config.ts`**

Add these imports, type, and functions to `electron/config.ts`:

```typescript
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
```

(Replace the existing `import { readFileSync } from "node:fs"` line.)

Then add after the `loadConfig()` function:

```typescript
export type ThemeMode = "light" | "dark" | "cold-dark"

const VALID_THEMES: ThemeMode[] = ["light", "dark", "cold-dark"]

export function getThemeMode(): ThemeMode {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8")
    const data = JSON.parse(raw)
    const mode = data?.theme?.mode
    return VALID_THEMES.includes(mode) ? mode : "light"
  } catch {
    return "light"
  }
}

export function setThemeMode(mode: ThemeMode): void {
  let data: Record<string, any> = {}
  try {
    data = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"))
  } catch {
    // file missing or corrupt — start fresh
  }
  if (!data.theme) data.theme = {}
  data.theme.mode = mode
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), "utf-8")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Verify full gate**

Run: `npm run typecheck && npm test`
Expected: typecheck 0; all tests green.

- [ ] **Step 6: Commit**

```bash
git add electron/config.ts electron/config.test.ts
git commit -m "feat: add getThemeMode/setThemeMode to config"
```

---

## Task 3: IPC + preload — theme get/set bridge

**Files:**
- Modify: `electron/ipc.ts`
- Modify: `electron/preload.ts`

- [ ] **Step 1: Add IPC handlers in `electron/ipc.ts`**

In `electron/ipc.ts`, add these imports at the top (alongside the existing config import if any):

```typescript
import { getThemeMode, setThemeMode, type ThemeMode } from "./config"
```

Then add these handlers (near the other `config:` handler):

```typescript
  ipcMain.handle("config:get-theme", () => getThemeMode())
  ipcMain.handle("config:set-theme", (_e, mode: ThemeMode) => {
    setThemeMode(mode)
    // Broadcast to all windows so companion windows (future) stay in sync
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("theme:changed", mode)
    }
  })
```

Add `BrowserWindow` to the electron import if not already present.

- [ ] **Step 2: Add preload bridge in `electron/preload.ts`**

Add these entries to the `contextBridge.exposeInMainWorld("api", { ... })` object:

```typescript
  // Theme
  getTheme: () => ipcRenderer.invoke("config:get-theme"),
  setTheme: (mode: string) => ipcRenderer.invoke("config:set-theme", mode),
  onThemeChanged: (callback: (mode: string) => void) =>
    ipcRenderer.on("theme:changed", (_e, mode) => callback(mode)),
```

- [ ] **Step 3: Verify typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add electron/ipc.ts electron/preload.ts
git commit -m "feat: add theme get/set IPC bridge"
```

---

## Task 4: Renderer — initialize theme + command palette switch

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add `getTheme` / `setTheme` / `onThemeChanged` to the Window.api type**

In `src/App.tsx`, inside the `Window.api` interface declaration (around line 17-65), add:

```typescript
      // Theme
      getTheme: () => Promise<string>
      setTheme: (mode: string) => Promise<void>
      onThemeChanged: (callback: (mode: string) => void) => void
```

- [ ] **Step 2: Add theme state and initialization effect**

Near the top of the `App` component (with the other `useState` calls), add:

```typescript
  const [themeMode, setThemeMode] = useState<string>("light")
```

Then add a mount effect (near the other initialization effects):

```typescript
  // Load persisted theme on mount and apply it
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
```

- [ ] **Step 3: Add "Switch theme" to the command palette**

Find the `commands` array or `useMemo` that builds the command palette commands. Add a theme-cycling command:

```typescript
    {
      id: "switch-theme",
      label: `Switch theme (current: ${themeMode})`,
      action: () => {
        const modes = ["light", "dark", "cold-dark"]
        const next = modes[(modes.indexOf(themeMode) + 1) % modes.length]
        window.api.setTheme(next)
      },
    },
```

Add `themeMode` to the `useMemo` dependency array if it's a `useMemo`.

- [ ] **Step 4: Verify typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "feat: initialize theme from config + command palette theme switch"
```

---

## Task 5: xterm.js theme mapping

**Files:**
- Create: `src/lib/xtermThemes.ts`
- Modify: `src/components/TerminalPane.tsx`
- Modify: `src/components/SplitView.tsx`

- [ ] **Step 1: Create xterm theme definitions**

Create `src/lib/xtermThemes.ts`:

```typescript
import type { ITheme } from "@xterm/xterm"

export const xtermThemes: Record<string, ITheme> = {
  light: {
    background: "#faf7f2",
    foreground: "#3a3028",
    cursor: "#c47a28",
    cursorAccent: "#faf7f2",
    selectionBackground: "rgba(196, 122, 40, 0.18)",
    black: "#2a2420",
    red: "#c44028",
    green: "#4a8a22",
    yellow: "#d4a030",
    blue: "#4a78b0",
    magenta: "#8a5cc0",
    cyan: "#2a8a6a",
    white: "#e8e0d4",
    brightBlack: "#9a8d7e",
    brightRed: "#d45030",
    brightGreen: "#5aa832",
    brightYellow: "#e0b040",
    brightBlue: "#5a8ac0",
    brightMagenta: "#9a6cd0",
    brightCyan: "#3a9a7a",
    brightWhite: "#f8f4ed",
  },
  dark: {
    background: "#110f0c",
    foreground: "#d0c4b0",
    cursor: "#e0933a",
    cursorAccent: "#110f0c",
    selectionBackground: "rgba(224, 147, 58, 0.20)",
    black: "#110f0c",
    red: "#e04a3a",
    green: "#6abf4a",
    yellow: "#d4a030",
    blue: "#6a9ad0",
    magenta: "#b08adf",
    cyan: "#4aaf8a",
    white: "#d0c4b0",
    brightBlack: "#6a5d4e",
    brightRed: "#f06050",
    brightGreen: "#7ad05a",
    brightYellow: "#e8b848",
    brightBlue: "#7aaae0",
    brightMagenta: "#c09aef",
    brightCyan: "#5abf9a",
    brightWhite: "#e8ddd0",
  },
  "cold-dark": {
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
}
```

- [ ] **Step 2: Update `TerminalPane.tsx` to accept `themeMode` and use the map**

Replace the contents of `src/components/TerminalPane.tsx`:

```typescript
import { useEffect, useRef } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { xtermThemes } from "../lib/xtermThemes"
import "@xterm/xterm/css/xterm.css"

interface Props {
  sessionId: string
  active: boolean
  themeMode?: string
  fontFamily?: string
  fontSize?: number
}

export default function TerminalPane({ sessionId, active, themeMode, fontFamily, fontSize }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

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

  return (
    <div
      ref={containerRef}
      className={`terminal-pane ${active ? "active" : "hidden"}`}
    />
  )
}
```

- [ ] **Step 3: Update `SplitView.tsx` to pass `themeMode` instead of `theme`**

Read `src/components/SplitView.tsx` and change the `Props` interface and the `<TerminalPane>` calls: replace the `theme?: any` prop with `themeMode?: string`, and pass `themeMode={themeMode}` to each `TerminalPane`. Remove the `theme` passthrough.

- [ ] **Step 4: Update `App.tsx` call sites to pass `themeMode` instead of `theme`**

In `src/App.tsx`, find where `TerminalPane` and `SplitView` are rendered (around lines 662-682). Replace `theme={config?.theme}` with `themeMode={themeMode}`. Remove `fontFamily` and `fontSize` props only if they come from `config?.theme` — check the current code. The `themeMode` state variable was added in Task 4.

The `<SplitView>` call should change similarly — replace `theme={config?.theme}` with `themeMode={themeMode}`.

- [ ] **Step 5: Verify typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/xtermThemes.ts src/components/TerminalPane.tsx src/components/SplitView.tsx src/App.tsx
git commit -m "feat: wire xterm.js themes to match active theme mode"
```

---

## Task 6: Visual smoke test + final verification

**Files:** (none modified — verification only)

- [ ] **Step 1: Full gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck 0; all tests green; build OK.

- [ ] **Step 2: Launch and test theme switching**

Launch the app (`npm run dev` or `npm start`). Verify:

1. The app starts in light mode (warm cream surfaces, amber accents, light terminal).
2. Open the command palette (`Ctrl+Shift+P`), run "Switch theme" — app switches to dark mode (warm charcoal, light text, dark terminal).
3. Run "Switch theme" again — app switches to cold-dark (legacy blue-tinted dark theme).
4. Run "Switch theme" again — back to light.
5. Close and reopen the app — the last-chosen theme persists.

Use `take_screenshot` after each switch if running via MCP.

- [ ] **Step 3: Commit any fixups**

If any visual issues or type errors were found, fix and commit.

---

## Self-Review Notes

- **Spec coverage:** Phase 1 covers: three palettes (§ Color Palettes), theme system (§ Theme System), xterm.js integration (§ Theme System paragraph 4), config persistence (§ Theme System paragraph 2-3), command palette toggle (§ Theme System paragraph 2). Layout changes, companion window, status bar removal are Phase 2-4.
- **Placeholder scan:** All code blocks are complete. No TBD/TODO.
- **Type consistency:** `ThemeMode` = `"light" | "dark" | "cold-dark"` used consistently in config, IPC, and renderer. `themeMode` prop name used in `TerminalPane` and `SplitView`. `xtermThemes` record keys match `ThemeMode` values.
