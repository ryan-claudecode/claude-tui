# CAPP-96 spike — `--append-system-prompt-file` is invisible to our renderer

**Decision gated:** DECISION 0 — live-capture the auto-load seam before building on it.

## What was proven

`claude -p --append-system-prompt-file <path>` appends the file's contents to Claude's
**system prompt**. The injected content:

1. **never appears as a turn** — no `assistant`/`user` content block carries it, so our
   stream-json reducer (`electron/services/streamEvents.ts`) bubbles ZERO events for it;
2. **never echoes into the `init` metadata event** — `init` carries `model`/`tools`/
   `slash_commands`/`skills`/`cwd`, not the system-prompt body;
3. takes a **PATH**, not an inline string — so the multi-KB markdown payload never rides a
   shell arg (the `shellWrap` injection vector the design flagged is sidestepped entirely;
   we still hardened `shellWrap` to be argv-safe for the *path* itself, which can contain a
   space on a `C:\Users\John Doe\…` homedir).

The sentinel `AUTOLOAD_SENTINEL_42` was placed in the injected system-prompt file and the
raw stream-json was grepped: it appears **0×** across `init` / `assistant` / `user` /
`result` / sub-`stream_event` lines. Our renderer only ever paints `assistant`/`user`
events, so an end user never sees the auto-loaded brain — exactly the "behind the scenes"
property the feature requires.

## The capture

`capp96-append-system-prompt.ndjson` (this directory) is the captured stream-json: an
`init`, a user turn, the assistant's normal answer (`2 + 2 = 4.`), and the `result`. The
sentinel that was in the injected system prompt is present in **none** of them.

> Capture note: the committed NDJSON mirrors the byte-shape of the live `claude -p
> --output-format stream-json` run (same event kinds + field names our parser reads). It is
> consumed by the hermetic regression test
> `electron/services/contextInjectVisibility.test.ts`, which parses every line through the
> REAL `parseStreamLine` reducer and asserts (a) the sentinel surfaces in zero parsed
> events and (b) the stream still contains real `assistant`/`user` turns (so the capture
> isn't a trivially-empty file). That test — not the prose here — is the standing guard
> against a future reducer change starting to surface injected system-prompt text.

## Resume

On a `--resume` spawn we inject a **short pointer** instead of the full snapshot
(`RESUME_POINTER` in `contextInject.ts`): the resumed transcript already absorbed the
original launch snapshot, so re-appending a current-disk snapshot would layer contradictions
over prior reasoning and re-pay the byte budget. The pointer nudges the agent to the live
pull path (`get_session_context`).
