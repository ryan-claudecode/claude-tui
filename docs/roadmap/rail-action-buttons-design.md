# Agent-generated rail action buttons — design (CAPP-104)

> Owner ask (2026-06-28): when the agent sees fit — or on request — it can add a BUTTON that
> persists with the session and/or workspace; the user clicks it to trigger a repeatable action.
> Identity fit: pillar 1 (agents render durable affordances back into the app) — the rail's
> first two-way surface.

## The action model (the safety decision)

A button's action is a **prompt dispatched to a Claude session** — never raw shell, never an
app-privileged operation. Clicking "Run e2e suite" sends its stored prompt into a terminal of
the owning session, where the normal agent (with the user watching, under the session's normal
permission posture) does the work. This keeps the trust thesis intact: the button adds zero
capability an agent didn't already have; it only makes a *user-initiated* repeat cheap.
`confirm: true` buttons interpose a two-step inline confirm (the CAPP-115-hardened pattern:
keyed state, never leaks across targets).

## Data model + service

`ActionButton { id, label (≤24 chars, visible text — words over icons), prompt, scope:
"session" | "workspace", ownerId, confirm?: boolean, createdBy: "agent" | "user", createdAt }`.

**`ActionButtonService`** (new, small): one file per owner — `~/.claude-tui/action-buttons/
session-<id>.json` / `workspace-<id>.json` (untagged = the `UNTAGGED` stem, same sentinel
convention as workspace memory). Deliberately NOT inside the workspace-memory record: memory is
knowledge, buttons are affordances — different lifecycles (buttons die with their session file;
promoted knowledge doesn't). CRUD + `onChanged` seam → `actionbuttons:updated` push. Session
buttons are deleted when the session is killed; workspace buttons live until removed.

## Surfaces

- **MCP** (identity-bound to the CALLER's owning session / its workspace, never `getActiveId`):
  `add_action_button` (label, prompt, scope, confirm?), `list_action_buttons`,
  `remove_action_button`. Cap: 8 per owner (the rail is a glance surface, not a launcher grid);
  adding beyond the cap fails with a clear message telling the agent to remove one first.
- **Rail**: a `BUTTONS` group in the Agent Rail (below KNOWS): one compact text button per row
  (visible label; a small conventional ✕ beside each for remove — with confirm), scoped to the
  active terminal's session ∪ its workspace. Tier-1 blocking gates stay banned from the rail —
  buttons are affordances, never gates.
- **Dispatch on click**: send the prompt to the owning session's most recent LIVE structured
  terminal via the stdin sink (the composer path); if none is alive, spawn a fresh terminal in
  that session first (the resume/primer machinery makes it context-aware for free). Toast on
  dispatch ("Sent 'Run e2e suite' to terraformer").

## Phasing

**AB-1 (one dispatch):** service + persistence + MCP tools + SERVER_INSTRUCTIONS line + the
rail BUTTONS group + click-dispatch + remove. Tests: service CRUD/cap/scope, identity binding,
dispatch-target resolution (live terminal vs fresh spawn) via fakes, rail render visible-at-rest.
**AB-2 (later):** user-authored buttons from the UI, per-button icons, cross-session broadcast
actions, parameterized prompts (ask-before-fill via ask_user).
