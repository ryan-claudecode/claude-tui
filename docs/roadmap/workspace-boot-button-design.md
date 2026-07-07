# "Boot workspace" — per-workspace program launcher button (future goal)

> Owner ask (2026-07-06): each workspace can have a top-left **"Boot workspace"** button that
> Claude adds — one click launches the Windows apps/programs you typically use when working in
> that workspace. Example: a "Subnautica modding" workspace boots the game, UE4SS, a code
> editor, etc. all at once. Framed by the owner as "on par with the skills-as-action-buttons
> idea" ([rail-action-buttons-design.md](./rail-action-buttons-design.md), CAPP-104): the user
> asks Claude to capture a thing they do often as a clickable, repeatable action.

Status: **future goal, not scheduled.** Captured for value; needs a design pass + a named pull
signal before build (retrenchment rule — [retrenchment-plan-2026-07.md](./retrenchment-plan-2026-07.md)).

## Why it's valuable

A workspace already scopes *where Claude works* (cwd, sessions, memory — [workspaces-design.md](./workspaces-design.md)).
This extends it to scope *the environment you set up to work there*: the muscle-memory of opening
five apps in the right order becomes one click. It's the natural physical-world companion to the
in-app action buttons — same "Claude renders a durable affordance back into the app" identity
pillar, but pointed at the OS instead of at a Claude session.

## The hard part — it BREAKS the rail-action-button safety model

This is the whole design question, so state it up front. Rail action buttons (CAPP-104) made a
deliberate safety decision: **a button's action is a prompt dispatched to a Claude session, never
raw shell, never an app-privileged operation.** That kept the trust thesis intact — a button adds
zero capability an agent didn't already have.

"Boot workspace" is different in kind: launching `Subnautica.exe` / UE4SS / an editor is an
**OS-level process launch**, not a prompt. It crosses exactly the line AB-1 avoided. So this
feature cannot just reuse the ActionButton dispatch path — it needs its own trust story. That
story is the gating design work, not the UI.

Options to weigh (design pass, not decided):

- **Dispatch-through-Claude (safest, reuses AB):** the button sends a prompt to the workspace's
  session ("boot my Subnautica dev environment"); the agent runs the launches through the normal
  terminal under the session's permission posture, with the user watching. Zero new app privilege
  — identical trust posture to every other button. Downside: slower, less "one-click-and-done,"
  depends on a live/spawnable session and the agent choosing to comply.
- **App-owned launch script (fastest, new privilege):** the workspace stores a launch manifest
  (an ordered list of programs + args, or a script/skill reference) that the MAIN process executes
  directly on click. True one-click. Downside: the app now spawns arbitrary user-named executables
  outside any Claude turn — a real new capability that needs its own guardrails (explicit user
  authorship/confirmation of the manifest, visible listing of exactly what will launch, no silent
  agent-authored additions to the launch set without review).
- **Hybrid:** Claude *proposes* the manifest (it knows the workspace); the **user** reviews and
  approves it once; thereafter the app-owned launcher runs the approved set directly. Claude
  authors, the user ratifies, the app executes only the ratified list. Likely the right shape —
  it keeps the "Claude sets it up for you" value while the launch privilege is user-gated, not
  agent-gated.

## Sketch (to be firmed in the design pass)

- **Scope + storage:** workspace-scoped, one manifest per workspace (parallels the
  `workspace-<id>.json` convention already used by action buttons / memory). A manifest is an
  ordered list of `{ label, path, args?, cwd?, delayMs? }` launch steps.
- **Surface:** a single **"Boot workspace"** button top-left in the workspace header (near the
  switcher), visible at rest (no hover-reveal — standing UI rule). Absent until a manifest exists;
  Claude offers to create one on request.
- **Authoring:** Claude proposes the manifest (MCP), the user reviews the exact program list in a
  panel and approves; edits/removes are user actions. The launch set is never silently mutated.
- **Execution:** on click, the main process launches each step in order (with the optional
  inter-step delay for apps that must come up before the next). Per-step success/failure toasts;
  a failed step never blocks the rest.
- **Cross-platform:** Windows-first (the owner's case); the manifest is portable but paths aren't,
  so a manifest is inherently machine/OS-specific — treat it as local config, not synced state.

## Open questions for the design pass

1. Which trust option above (dispatch-through-Claude vs app-owned vs hybrid) — this is the gate.
2. Manifest authoring UX: a Form panel? Inline in the workspace switcher? How does the user see
   "exactly what will launch" before first boot?
3. Skill vs manifest: the owner mentioned "a script or skill Claude invokes." Is the action a
   flat program list (simple, inspectable) or an arbitrary script/skill (powerful, opaque)? The
   inspectability of a flat list is a big part of what makes the app-owned launch defensible.
4. Relationship to action buttons: separate feature, or "Boot workspace" is just a special
   built-in workspace-scoped action button with an OS-launch action type? (If the latter, the
   action-type union is where the new privilege — and its guardrails — gets introduced.)
