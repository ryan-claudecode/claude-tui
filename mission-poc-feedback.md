# Mission POC — Conductor Feedback

Mission: `mission-1780596118611-slsffv`
Goal: "proof of concept. want to create 1-2 max turns creating a temp.txt and appending to it so i can verify e2e missions feature"
Result: **done** — full e2e flow worked (plan → dispatch → await → review → resolve → finish) with two real worker sessions.

## Final artifact
`temp.txt` (repo root):
```
created by mission POC
line 2: appended by mission POC
```

## Findings

### 1. `mission_await` returns prematurely on a freshly-spawned worker
On the **first** await for each newly-dispatched worker, `mission_await` returned `idle: true, timedOut: false` immediately — but the worker hadn't done anything yet. The output was just the Claude Code welcome screen.

- **Root cause:** a freshly-spawned session sits "idle" (no terminal output) at its welcome prompt *before* it has ingested the injected task prompt. The idle-detector can't distinguish "booted but hasn't started" from "finished the work."
- **Impact:** Task 1 happened to land (file got created) but Task 2 required a **second** `mission_await` call before the append actually ran. A naive hands-off Conductor that resolves on the first await would mark tasks done before the work exists.
- **Suggested fix:** in the dispatch→await path, don't treat the first idle as completion until the worker has produced at least some post-prompt output (i.e. it transitioned active → idle). Inject the prompt, wait for the *first active* signal, then wait for idle. The CLAUDE.md note on `wait_for_session_idle` already mentions injecting input resets the quiet clock — `mission_await` should lean on that same mechanism so the startup race is closed.

### 2. Worker dropped part of the requested literal content
Task 1 prompt asked for the line `line 1: created by mission POC`; the worker wrote `created by mission POC` (dropped the `line 1:` prefix). Functionally fine for the POC, but worth noting that workers may paraphrase/clean literal strings unless the prompt is very explicit ("write these exact bytes, verbatim").

## Note
`temp.txt` and this feedback file are throwaway verification artifacts — left uncommitted on purpose.
