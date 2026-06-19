# ClaudeTUI

**A desktop workbench for running many Claude Code sessions at once — where the work is durable and the agents are first-class citizens of the UI.**

ClaudeTUI is not just a place to open Claude Code terminals. It's built on one idea: when
you run agents for hours, the *work* should outlive any single context window, and the
agents should be able to *show* you what they're doing — render a diff, raise a question,
post a dashboard — instead of burying it in scrollback.

> Electron · React · xterm.js · node-pty · MCP. Cross-platform (Windows-first today).

---

## Why it exists

Most "run Claude in a nice window" tools treat a session as disposable and the human as the
only one driving. ClaudeTUI inverts both:

- **Continuity — work outlives the session.** Every work session is a durable container
  that accumulates findings, corrections, and a running summary. Conversations resume after
  a restart (`--resume`), terminals can hand off when their context fills, and a session's
  whole life is reviewable as a timeline. The terminal is disposable; the work is not.
- **Bidirectionality — agents drive the app back.** Through the MCP server, a Claude session
  can render a panel (diff, chart, kanban, mission dashboard), block on a form, raise a
  toast, or put itself on your attention queue. The companion window is the agents' canvas.
- **Orchestration — missions that survive.** A *mission* is a durable, on-disk goal: a
  Conductor session decomposes it, dispatches worker sessions, and a code-level supervisor
  keeps it alive across crashes, context limits, and usage limits. Code guarantees
  continuity; Claude provides the intelligence.

## Highlights

- **"NEEDS YOU" attention queue** — one ordered list of every session waiting on you
  (blocked on a form, asking a question, finished, or erroring), with desktop notifications
  when you're in another window. `Ctrl+J` jumps to the most urgent.
- **Missions** — a first-class sidebar surface with live progress, dispatched workers, and a
  bird's-eye dashboard. Start one with the `+`; it keeps running while you're away.
- **Worktree-isolated workers** — opt a mission into isolation and each worker runs in its
  own git worktree. When a task finishes you review its diff in a panel and **approve to
  merge** or reject — parallel agents never step on each other, and nothing lands unseen.
- **Rich panels** — agents render diffs, charts, kanban boards, timelines, code, logs, and
  live dashboards in a companion window. A main-window indicator tells you when one opens.
- **Session timeline** — replay a session's life: spawns, notes, corrections, summaries,
  handoffs.
- **Three warm themes** (Sand & Stone light/dark + a cold-dark) and a frameless,
  distraction-free shell.

## Install & run

Requires Node.js 18+, git, and the [Claude Code CLI](https://claude.com/claude-code) on your
PATH.

```bash
git clone <this repo>
cd claude-tui-app
npm install
npm run dev      # build + launch
```

Other scripts:

```bash
npm run build    # build only
npm start        # launch a prior build
npm test         # unit tests (Vitest)
npm run e2e      # hermetic Playwright smoke test of the built app
```

### Packaging (Windows)

```bash
npm run package            # unsigned, unpacked build → dist/win-unpacked/ClaudeTUI.exe
npm run package:installer  # NSIS installer (downloads NSIS resources on first run)
```

Code signing and auto-update need your own certificate and a release host — see the
"Packaging" and "Auto-update" notes in [CLAUDE.md](./CLAUDE.md). macOS packaging is a future
item (the Cmd-key mapping is already in place).

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd+N` | New session |
| `Ctrl/Cmd+T` | New terminal in active session |
| `Ctrl/Cmd+W` | Close active terminal |
| `Ctrl/Cmd+K` | Kill active session |
| `Ctrl/Cmd+J` | Jump to top "NEEDS YOU" entry |
| `Ctrl/Cmd+Shift+H` | Retire & continue (handoff) |
| `Ctrl/Cmd+\` | Toggle split panes |
| `Ctrl/Cmd+1–9` / `Alt+1–9` | Switch session / terminal |
| `Ctrl/Cmd+Shift+P` | Command palette |
| `Ctrl/Cmd+Shift+F` | Search session history |
| `Ctrl/Cmd+Shift+Z` | Focus mode |
| `Ctrl/Cmd+/` | Shortcuts overlay |

(On macOS the modifier is `Cmd`; elsewhere `Ctrl`.)

## How it's built

A thin-adapters-over-a-service-core architecture: a service layer is the source of truth,
with IPC handlers and MCP tools as one-line wrappers on top, and React renderers (a main
window + a companion panel window) as views. See [CLAUDE.md](./CLAUDE.md) for the full
architecture, the MCP tool surface, and how to add features.

## Status

Actively developed. The core (sessions, attention queue, missions, worktree workers, panels,
timeline) is in place and unit + e2e tested. Distribution (signed installers, auto-update)
is scaffolded and awaits hosting/signing setup.

## Screenshots

_Screenshots to be added._ Run `npm run dev` to see the live app — sidebar with the
"NEEDS YOU" and "MISSIONS" sections, pill-tab terminals, and the companion panel window.

---

Built with [Claude Code](https://claude.com/claude-code).
