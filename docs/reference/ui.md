# UI: Themes, Window, Config, Keyboard Shortcuts

## Theme system

Three themes switched via `data-theme` attribute on `<html>`:

- `light` (default) — Sand & Stone warm cream/amber
- `dark` — Sand & Stone warm charcoal/amber
- `cold-dark` — legacy cold-navy/blue

CSS custom properties in `src/App.css` define each palette. Theme mode is persisted in `~/.claude-tui/config.json` under `theme.mode`. Switch via command palette (`Ctrl+Shift+P` → "Switch theme") or `window.api.setTheme(mode)`.

xterm.js terminal colors are defined in `src/lib/xtermThemes.ts` and applied reactively when the theme changes.

## Window

Frameless window (`frame: false`). Custom window controls (minimize/maximize/close) are inline in the TabBar component. The sidebar brand and tab bar empty space serve as drag regions (`-webkit-app-region: drag`). Interactive elements use `-webkit-app-region: no-drag`.

## Config

`~/.claude-tui/config.json`:

```json
{
  "workspaceScanPaths": ["~/workspaces/ws-*"],
  "defaultCommand": "claude",
  "defaultArgs": ["--dangerously-skip-permissions"],
  "theme": {
    "mode": "light",
    "fontSize": 14,
    "fontFamily": "Cascadia Code"
  }
}
```

`theme.mode` controls the CSS theme (`"light"` | `"dark"` | `"cold-dark"`). Per-field overrides (`fontSize`, `fontFamily`) take precedence over theme defaults.

**`models` (optional, CAPP-113)** — the never-stale model-picker block: `{ "default"?, "extra"?: string[], "hidden"?: string[], "xhigh"?: string[] }` — the no-code-edit MANUAL override path. `default` overrides the spawn-default for NEW terminals (an explicit `rendering.model` still wins); `extra`/`hidden` add/remove picker entries; `xhigh` additively marks models as xhigh-capable for ultracode gating. A model typed into the picker's statically-visible "Custom…" entry is persisted into `extra` after a successful switch and pushed live to open windows via `config:models-changed`. The headless `init` event's RESOLVED model id is captured per terminal (`resolvedModel`) and shown as the picker tooltip.

**Dynamic model discovery (CAPP-133)** — the picker is no longer limited to a hand-maintained list. `ModelCatalogService` (`electron/services/modelCatalog.ts`) fetches `GET /v1/models` and caches it to `~/.claude-tui/model-catalog.json`, so a model released *after* the build (e.g. `claude-opus-5`) is pickable with no code edit and no config edit. Full detail — auth, the three invariants, and the capability-over-heuristic rule — lives in `docs/reference/services.md` §ModelCatalogService.

Effective picker list = (`MODEL_ALIASES` → discovered ids → `extra`) − `hidden` (`resolveModelOptions` in `streamProtocol.ts`). Aliases stay first and are never removed by a failed fetch; `hidden` suppresses a discovered id exactly like a built-in. The `xhigh` gate (`modelSupportsXhigh`) consults the catalog FIRST — an exact id match is authoritative in both directions — and only falls back to the prefix heuristics for aliases, which the API never lists.

Other config keys are documented where their feature lives: `rendering.engine` (structured/xterm default — `docs/reference/structured-engine.md`), `attention.osNotifications` + `scheduler.maxConcurrent` (`docs/reference/services.md`), `stt.hotwords` (`docs/reference/services.md` §SttService), `permissions.skipApproval` (dev-only skip of the approve_tool gate).

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+N | New session |
| Ctrl+T | New terminal in active session |
| Ctrl+W | Close active terminal |
| Ctrl+K | Kill active session |
| Ctrl+Shift+H | Retire & continue (handoff) — fresh terminal resuming the conversation, retire old |
| Ctrl+\ | Toggle split panes |
| Ctrl+1-9 | Switch to session by index |
| Alt+1-9 | Switch to terminal by index |
| Ctrl+Shift+P | Command palette |
| Ctrl+Shift+F | Search session history |
| Ctrl+J | Jump to the top "NEEDS YOU" attention-queue entry |
| Ctrl+M | Toggle dictation (composer focused) |
| Ctrl+Shift+Z | Focus mode (hide sidebar + tab bar) |
| Ctrl+/ | Keyboard shortcuts overlay |
