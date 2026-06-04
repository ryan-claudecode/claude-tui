# Rich Panel System — Implementation Plan

> **For agentic workers:** This plan is designed for autonomous multi-hour execution. Work through phases sequentially. Each phase produces a buildable, testable checkpoint. Commit after each task. If blocked, document the blocker and move to the next task.

**Goal:** Give Claude the ability to render rich UI panels (diffs, forms, images, markdown, tables) alongside terminal sessions. Claude invokes these via MCP tools. Users can also drag-drop images into the app.

**Architecture:** New `PanelService` in the service layer. New React panel components rendered in a sliding drawer. New MCP tools to show/hide/update panels. Panel state flows: Claude → MCP tool → PanelService → IPC → React drawer.

**Spec:** `docs/superpowers/specs/2026-06-03-mcp-server-design.md`

---

## Phase 0: Testing Infrastructure (must complete first)

Claude needs to verify its own work visually. Add MCP tools + Electron APIs for self-testing.

### Task 0.1: Screenshot MCP tool

**Files:**
- Modify: `electron/services/sessions.ts` — add `captureScreenshot()` method using `mainWin.webContents.capturePage()`
- Modify: `electron/mcp/tools.ts` — add `take_screenshot` tool
- Modify: `electron/ipc.ts` — add screenshot IPC handler

**Implementation:**

In `SessionService` (or better, create a new `electron/services/app.ts` for app-level operations):

```typescript
// electron/services/app.ts
import { BrowserWindow } from "electron"

export class AppService {
  private mainWin: BrowserWindow | null = null

  setMainWindow(win: BrowserWindow) {
    this.mainWin = win
  }

  async captureScreenshot(): Promise<string> {
    if (!this.mainWin) throw new Error("No window")
    const image = await this.mainWin.webContents.capturePage()
    return image.toPNG().toString("base64")
  }

  getAppState(): object {
    // Return current UI state for testing verification
    return {
      windowSize: this.mainWin?.getBounds(),
      isVisible: this.mainWin?.isVisible(),
    }
  }
}
```

MCP tool:
```typescript
server.tool("take_screenshot", "Capture a screenshot of ClaudeTUI window", {}, async () => {
  const base64 = await appService.captureScreenshot()
  return { content: [{ type: "image", data: base64, mimeType: "image/png" }] }
})

server.tool("get_app_state", "Get current ClaudeTUI app state", {}, async () => {
  const state = {
    ...appService.getAppState(),
    sessions: sessions.list(),
    workspaces: workspaces.list(),
  }
  return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] }
})
```

- [ ] Create `electron/services/app.ts` with AppService
- [ ] Add `take_screenshot` and `get_app_state` MCP tools
- [ ] Add AppService to IPC setup and MCP server initialization
- [ ] Build and verify: `npx electron-vite build`
- [ ] Commit: `feat: add screenshot and app state MCP tools`

### Task 0.2: Build verification tool

Add an MCP tool that Claude can call to build the project and check for errors.

```typescript
server.tool("run_build", "Build the ClaudeTUI project and return results", {}, async () => {
  const { execSync } = await import("child_process")
  try {
    const output = execSync("npx electron-vite build", { cwd: projectRoot, encoding: "utf8", timeout: 30000 })
    return { content: [{ type: "text", text: `BUILD SUCCESS\n${output}` }] }
  } catch (e: any) {
    return { content: [{ type: "text", text: `BUILD FAILED\n${e.stdout}\n${e.stderr}` }] }
  }
})
```

- [ ] Add `run_build` MCP tool
- [ ] Add project root path to AppService
- [ ] Build and verify
- [ ] Commit: `feat: add build verification MCP tool`

---

## Phase 1: Panel System Foundation

Build the drawer/panel container and the service that manages panel state. No specific panel types yet — just the infrastructure.

### Task 1.1: PanelService

**Files:**
- Create: `electron/services/panels.ts`

```typescript
export interface PanelState {
  id: string
  type: string          // "diff" | "form" | "image" | "markdown" | "table"
  position: "right" | "bottom"  // drawer position
  width?: number        // percentage for right drawer
  height?: number       // percentage for bottom drawer
  props: Record<string, any>   // type-specific data
  visible: boolean
}

export class PanelService {
  private panels = new Map<string, PanelState>()
  private mainWin: BrowserWindow | null = null
  private nextId = 1

  setMainWindow(win: BrowserWindow) { ... }

  show(type: string, props: Record<string, any>, position?: string): PanelState { ... }
  update(id: string, props: Record<string, any>): boolean { ... }
  hide(id: string): boolean { ... }
  hideAll(): void { ... }
  list(): PanelState[] { ... }
}
```

Each method sends to renderer: `panel:show`, `panel:update`, `panel:hide`, `panel:hide-all`.

- [ ] Create `electron/services/panels.ts` with PanelService class
- [ ] Add PanelService to IPC setup (electron/ipc.ts) — add panel IPC handlers
- [ ] Add PanelService to MCP server initialization
- [ ] Add to preload: `onPanelShow`, `onPanelUpdate`, `onPanelHide`, `onPanelHideAll`
- [ ] Build and verify
- [ ] Commit: `feat: add PanelService for managing rich UI panels`

### Task 1.2: MCP tools for panels

**Files:**
- Modify: `electron/mcp/tools.ts`

```typescript
server.tool("show_panel", "Show a rich UI panel in ClaudeTUI", {
  type: z.enum(["diff", "form", "image", "markdown", "table"]).describe("Panel type"),
  props: z.record(z.any()).describe("Panel-specific data"),
  position: z.enum(["right", "bottom"]).optional().describe("Drawer position"),
}, async ({ type, props, position }) => {
  const panel = panels.show(type, props, position)
  return { content: [{ type: "text", text: JSON.stringify(panel) }] }
})

server.tool("update_panel", "Update an existing panel's content", {
  id: z.string().describe("Panel ID"),
  props: z.record(z.any()).describe("Updated properties"),
}, async ({ id, props }) => {
  panels.update(id, props)
  return { content: [{ type: "text", text: "Panel updated" }] }
})

server.tool("hide_panel", "Hide a panel", {
  id: z.string().describe("Panel ID"),
}, async ({ id }) => {
  panels.hide(id)
  return { content: [{ type: "text", text: "Panel hidden" }] }
})

server.tool("hide_all_panels", "Hide all panels", {}, async () => {
  panels.hideAll()
  return { content: [{ type: "text", text: "All panels hidden" }] }
})
```

- [ ] Add panel MCP tools (show_panel, update_panel, hide_panel, hide_all_panels)
- [ ] Build and verify
- [ ] Commit: `feat: add panel MCP tools`

### Task 1.3: React Panel Drawer

**Files:**
- Create: `src/components/PanelDrawer.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.css`

The drawer slides in from the right (or bottom). It renders the appropriate panel component based on `type`. It has a close button and a resize handle.

```tsx
// src/components/PanelDrawer.tsx
interface PanelState {
  id: string
  type: string
  position: "right" | "bottom"
  props: Record<string, any>
  visible: boolean
}

interface Props {
  panels: PanelState[]
  onClose: (id: string) => void
}

export default function PanelDrawer({ panels, onClose }: Props) {
  const visiblePanels = panels.filter(p => p.visible)
  if (visiblePanels.length === 0) return null

  const panel = visiblePanels[visiblePanels.length - 1] // show latest

  return (
    <div className={`panel-drawer panel-drawer-${panel.position}`}>
      <div className="panel-header">
        <span className="panel-title">{panel.type}</span>
        <button className="panel-close" onClick={() => onClose(panel.id)}>×</button>
      </div>
      <div className="panel-body">
        <PanelContent type={panel.type} props={panel.props} />
      </div>
    </div>
  )
}

function PanelContent({ type, props }: { type: string; props: any }) {
  switch (type) {
    case "diff": return <DiffPanel {...props} />
    case "form": return <FormPanel {...props} />
    case "image": return <ImagePanel {...props} />
    case "markdown": return <MarkdownPanel {...props} />
    case "table": return <TablePanel {...props} />
    default: return <pre>{JSON.stringify(props, null, 2)}</pre>
  }
}
```

Wire into App.tsx:
- Listen for `panel:show`, `panel:update`, `panel:hide` events from main
- Track `panels` state array
- Render `<PanelDrawer>` alongside the terminal container

CSS: Drawer slides in from the right, takes 40% width by default. Has a resize handle. Dark theme matching the app.

- [ ] Create `src/components/PanelDrawer.tsx` with drawer container and type switch
- [ ] Create placeholder panel components (DiffPanel, FormPanel, ImagePanel, MarkdownPanel, TablePanel) that just render JSON for now
- [ ] Add panel state management to App.tsx (listen for IPC events)
- [ ] Add drawer CSS (slide-in animation, resize handle, header, close button)
- [ ] Update Window.api type for panel events
- [ ] Build and verify
- [ ] Commit: `feat: add panel drawer UI with type routing`

---

## Phase 2: Panel Components

Build each panel type as a React component. Each receives `props` from the MCP tool call.

### Task 2.1: Diff Viewer

**Files:**
- Create: `src/components/panels/DiffPanel.tsx`
- Install: a diff library (e.g., `diff2html` or build a simple side-by-side viewer)

MCP tool usage by Claude:
```
show_panel({
  type: "diff",
  props: {
    files: [
      {
        path: "src/app.ts",
        oldContent: "...",
        newContent: "...",
      }
    ]
  },
  position: "right"
})
```

The diff panel shows:
- File tabs (if multiple files)
- Side-by-side or unified diff view
- Syntax highlighting (use a lightweight highlighter or CSS classes)
- Line numbers
- Added/removed line highlighting (green/red backgrounds)

- [ ] Install diff rendering dependency (`diff` npm package for computing diffs)
- [ ] Create `src/components/panels/DiffPanel.tsx`
- [ ] Implement unified diff view with line numbers, add/remove highlighting
- [ ] Add file tabs for multi-file diffs
- [ ] Style with dark theme
- [ ] Build and verify
- [ ] Test: use `show_panel` MCP tool with sample diff data
- [ ] Commit: `feat: add diff viewer panel`

### Task 2.2: Form Panel

**Files:**
- Create: `src/components/panels/FormPanel.tsx`

MCP tool usage by Claude:
```
show_panel({
  type: "form",
  props: {
    title: "Select files to include",
    fields: [
      { name: "strategy", type: "select", label: "Migration strategy", options: ["incremental", "big-bang", "parallel"] },
      { name: "files", type: "checklist", label: "Files to include", items: ["app.ts", "config.ts", "index.ts"] },
      { name: "message", type: "text", label: "Commit message" },
      { name: "dryRun", type: "toggle", label: "Dry run" },
    ],
    submitLabel: "Confirm"
  }
})
```

Supported field types:
- `text` — single line input
- `textarea` — multi-line input
- `select` — dropdown
- `checklist` — checkbox list
- `toggle` — on/off switch
- `number` — number input

When submitted, the form data flows back to Claude via MCP response. This requires a **callback mechanism**: the `show_panel` MCP tool waits for user submission, then returns the form data.

Implementation: The MCP tool call stays open (pending promise). When the user submits, the renderer sends form data to main via IPC, main resolves the promise, and the MCP tool returns the data to Claude.

- [ ] Create `src/components/panels/FormPanel.tsx` with field type components
- [ ] Implement all field types (text, textarea, select, checklist, toggle, number)
- [ ] Add submit/cancel buttons
- [ ] Wire form submission: renderer → IPC → resolves MCP tool promise → returns to Claude
- [ ] Add `panel:form-submit` IPC channel
- [ ] Add form callback handling in PanelService
- [ ] Style all form fields with dark theme
- [ ] Build and verify
- [ ] Commit: `feat: add form panel with dynamic fields and MCP callback`

### Task 2.3: Image Panel

**Files:**
- Create: `src/components/panels/ImagePanel.tsx`

MCP tool usage:
```
show_panel({
  type: "image",
  props: {
    src: "/path/to/image.png",    // file path
    // OR
    base64: "iVBOR...",           // base64 data
    alt: "Screenshot of the UI"
  }
})
```

Features:
- Display image from file path or base64
- Zoom (scroll wheel)
- Pan (click + drag)
- Fit to panel button

- [ ] Create `src/components/panels/ImagePanel.tsx`
- [ ] Support file path and base64 sources
- [ ] Add zoom (wheel) and pan (drag) controls
- [ ] Add "fit to panel" button
- [ ] Style with dark background
- [ ] Build and verify
- [ ] Commit: `feat: add image panel with zoom and pan`

### Task 2.4: Markdown Panel

**Files:**
- Create: `src/components/panels/MarkdownPanel.tsx`
- Install: `marked` or `react-markdown` for rendering

MCP tool usage:
```
show_panel({
  type: "markdown",
  props: {
    content: "# Results\n\n| Test | Status |\n|------|--------|\n| auth | ✅ |\n| db | ❌ |"
  }
})
```

- [ ] Install markdown rendering dependency
- [ ] Create `src/components/panels/MarkdownPanel.tsx`
- [ ] Render markdown with tables, code blocks, headings, lists
- [ ] Style code blocks with syntax highlighting (or monospace + background)
- [ ] Dark theme
- [ ] Build and verify
- [ ] Commit: `feat: add markdown panel`

### Task 2.5: Table Panel

**Files:**
- Create: `src/components/panels/TablePanel.tsx`

MCP tool usage:
```
show_panel({
  type: "table",
  props: {
    columns: ["File", "Status", "Lines Changed"],
    rows: [
      ["app.ts", "modified", "42"],
      ["config.ts", "added", "15"],
    ],
    sortable: true
  }
})
```

- [ ] Create `src/components/panels/TablePanel.tsx`
- [ ] Render sortable table with column headers
- [ ] Click column header to sort
- [ ] Stripe alternate rows
- [ ] Dark theme
- [ ] Build and verify
- [ ] Commit: `feat: add table panel with sorting`

---

## Phase 3: Drag and Drop

### Task 3.1: Image drag-and-drop zone

**Files:**
- Create: `src/components/DropZone.tsx`
- Modify: `src/App.tsx`
- Modify: `electron/services/app.ts`

When an image is dragged onto the app:
1. Show a drop overlay with "Drop image to share with Claude"
2. On drop, read the image file
3. Show it in an image panel
4. Send the image data to the active Claude session via MCP (or inject the path into the PTY)

Implementation: Electron's drag-and-drop API + React's onDragOver/onDrop events.

For injecting into Claude: Two options:
- A) Write the image to a temp file and inject the path into the PTY as text
- B) Use an MCP notification/resource to make the image available to Claude

Option A is simpler and works immediately.

- [ ] Create `src/components/DropZone.tsx` (overlay shown during drag)
- [ ] Handle file drop: read image, show preview in image panel
- [ ] Inject image path into active session's PTY
- [ ] Add drop zone CSS (overlay, border animation)
- [ ] Build and verify
- [ ] Commit: `feat: add drag-and-drop image support`

---

## Phase 4: Integration and Polish

### Task 4.1: Update CLAUDE.md

- [ ] Add panel system documentation to CLAUDE.md
- [ ] Document new MCP tools (show_panel, update_panel, hide_panel, take_screenshot, etc.)
- [ ] Add "How to add a new panel type" guide
- [ ] Commit: `docs: update CLAUDE.md with panel system`

### Task 4.2: Panel keyboard shortcuts

- [ ] Add Ctrl+P to toggle panel drawer
- [ ] Add Escape to close active panel
- [ ] Add panel navigation if multiple panels are open
- [ ] Commit: `feat: add panel keyboard shortcuts`

### Task 4.3: Final integration test

- [ ] Launch app, create session
- [ ] Test each panel type via MCP tools
- [ ] Test drag-and-drop
- [ ] Test screenshot tool
- [ ] Verify all keyboard shortcuts work
- [ ] Fix any issues found
- [ ] Commit: `fix: integration test fixes`

### Task 4.4: Push to GitHub

- [ ] Push all changes
- [ ] Verify repo is clean

---

## Phase 5: Creative Feature Exploration

**When to start:** Only after Phases 0-4 are complete and all changes are pushed.

**Goal:** You've built the panel system. Now think about what would make ClaudeTUI a genuinely competitive product — features that no other terminal multiplexer or AI coding tool offers. Be creative. Build what excites you.

**Directions to explore (pick what resonates, or invent your own):**

- **Interactive diff reviews** — Diff panel where users can click a specific line/hunk and tell Claude "change this part" or "revert this." Claude gets the selection context via MCP.
- **Containerized test runners** — A panel that shows test results live, lets Claude re-run tests, shows coverage. Integrate with the terminal session's test framework.
- **Session templates** — Pre-configured session types ("frontend dev", "debugging", "code review") that auto-set prompts, working directories, and panel layouts.
- **Context injection** — Drag files, URLs, images onto a session to inject them as context. Claude sees them via MCP resources.
- **Conversation timeline** — A panel that shows the conversation history across sessions, searchable. Useful for reviewing what Claude did while you were away.
- **Git integration panel** — Show branch status, staged files, commit history. Claude can stage/unstage, create commits, push — all through the panel.
- **Terminal multiplexer features** — Session groups, saved layouts, session persistence across app restarts.
- **Notification system** — Toast notifications when Claude finishes a task, needs input, or encounters an error in a background session.
- **Command palette** — Ctrl+Shift+P opens a searchable command palette (like VS Code) for all app actions.

**Rules:**
- Each feature must follow the 4-step pattern (service → IPC → MCP tool → preload/UI)
- Commit after each feature
- Update CLAUDE.md with any new tools/features
- Build and verify after each commit
- Push to GitHub when done

---

## Execution Notes (for autonomous agents)

### Build verification
After EVERY commit, run `npx electron-vite build`. If it fails, fix the error before moving on. Never commit broken code.

### Testing strategy
- After Phase 0: use `take_screenshot` and `get_app_state` to verify changes
- After each panel component: launch the app with `npm start`, call `show_panel` via the MCP tools, take a screenshot to verify rendering
- If visual verification isn't possible, at minimum verify the build passes and the component mounts without errors

### If blocked
- Document the blocker in a comment at the top of this file
- Skip to the next task if possible
- If the blocker affects downstream tasks, document which tasks are affected

### Dependencies between phases
- Phase 0 must complete before any testing can happen
- Phase 1 must complete before Phase 2 (panel components need the drawer)
- Phase 2 tasks are independent of each other (can be done in any order)
- Phase 3 depends on Phase 2.3 (image panel) but not other Phase 2 tasks
- Phase 4 depends on all prior phases

### Commit frequently
Commit after every completed task. This provides rollback points.

### External dependencies to install
- `diff` — for computing file diffs (Phase 2.1)
- `react-markdown` or `marked` — for markdown rendering (Phase 2.4)
- Install with `npm install <package> --legacy-peer-deps`

### Visual testing workflow
The app must be running for screenshot/state tools to work. To test visually:
1. Build: `npx electron-vite build`
2. Launch: `npx electron .` (runs in background)
3. Use MCP tools via: `claude --print --dangerously-skip-permissions --mcp-config /tmp/claudetui/mcp-config.json -p "call take_screenshot and describe what you see"`
4. Kill when done: `taskkill //F //IM electron.exe` (Windows) or `pkill -f electron` (macOS/Linux)

### Overnight autonomous run command
```bash
cd ~/projects/claude-tui-app && claude --dangerously-skip-permissions --model claude-opus-4-8 "Read the implementation plan at docs/superpowers/plans/2026-06-03-rich-panels.md. Phase 0 is already complete. Start from Phase 1 and work through every task sequentially. After each task: build, commit, and push. Use take_screenshot and get_app_state MCP tools to verify visual changes when the app is running. If you finish all 4 phases, move to Phase 5 and build creative features. Keep working until you run out of ideas or hit a blocker you can't resolve."
```
