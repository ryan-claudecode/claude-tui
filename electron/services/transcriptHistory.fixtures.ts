/**
 * BO-12 — REAL captured on-disk transcript lines, lifted verbatim from a headless
 * `claude -p` run's `~/.claude/projects/<encoded-cwd>/<id>.jsonl`
 * (the bo10 Stop/abort live spike — see docs/spikes/bo11-stop-abort.md). Used to
 * unit-test the JSONL → StreamEvent mapper (`parseTranscriptLine`) + the reader
 * against the SHAPE Claude Code actually writes, not an invented one.
 *
 * Key facts these lines encode (each load-bearing for the rehydrate):
 *  - The on-disk format is NOT the live stream-json format: there are NO
 *    `stream_event` partial-delta lines and NO top-level `result` lines. Assistant
 *    prose lives in an `assistant` line's `message.content[]` `text` block; each
 *    content block (thinking / text / tool_use) is written on its OWN line.
 *  - A `user` line carries EITHER the user's own `text` OR a `tool_result`.
 *  - Metadata lines (`queue-operation`, `attachment`, `system`, `last-prompt`, …)
 *    are interleaved and must be DROPPED, not surfaced as raw blocks.
 *  - The last assistant turn before a Stop is a `tool_use` whose `tool_result` has
 *    `is_error:true` ("agent-exited") — so a correct fold SETTLES the tool to
 *    `error`, never leaving it perpetually `running`.
 *
 * The giant base64 `thinking.signature` is trimmed (…) purely for readability; no
 * field the mapper reads is altered.
 */

/** The Claude Code conversation id (file basename) of the captured transcript. */
export const FIXTURE_CC_ID = "690a8991-ae7f-436d-94d1-732100ba74a8"

/** The cwd the captured session ran in (drives the encoded project-dir name). */
export const FIXTURE_CWD = "C:\\Users\\ryguy\\AppData\\Local\\Temp\\bo10-live-ByCajV"

/** Real captured lines, in on-disk order. */
export const REAL_TRANSCRIPT_LINES: string[] = [
  `{"parentUuid":"cb01c3ab-6120-44b9-8a18-9f18e1eef05c","isSidechain":false,"promptId":"28568232-9c4c-4e73-8a00-be3568bc5a9b","type":"user","message":{"role":"user","content":[{"type":"text","text":"Please remember this number for the rest of our conversation: 42. Reply with just: noted."}]},"uuid":"7e6181a1-c1ce-4c45-ab23-59286984a81f","timestamp":"2026-06-15T22:36:01.946Z","permissionMode":"default","promptSource":"sdk","userType":"external","entrypoint":"sdk-cli","cwd":"C:\\\\Users\\\\ryguy\\\\AppData\\\\Local\\\\Temp\\\\bo10-live-ByCajV","sessionId":"690a8991-ae7f-436d-94d1-732100ba74a8","version":"2.1.170","gitBranch":"HEAD"}`,
  `{"parentUuid":"f04f18bc-1dd3-4904-bbf1-1281ea88ffdb","isSidechain":false,"message":{"model":"claude-opus-4-8","id":"msg_017fVtthUW8o1kiDG8C1B3aj","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"The user wants me to remember 42.","signature":"ErwECmMIDhgCKkBpDYmXUmXE..."}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":11091,"cache_creation_input_tokens":2059,"cache_read_input_tokens":20211,"output_tokens":120,"service_tier":"standard"},"diagnostics":null},"requestId":"req_011Cc5qvnKpq7MWrXkoc5FQt","type":"assistant","uuid":"d0c46a86-86d8-404c-b47f-bf2e73edbb78","timestamp":"2026-06-15T22:36:05.091Z","userType":"external","entrypoint":"sdk-cli","cwd":"C:\\\\Users\\\\ryguy\\\\AppData\\\\Local\\\\Temp\\\\bo10-live-ByCajV","sessionId":"690a8991-ae7f-436d-94d1-732100ba74a8","version":"2.1.170","gitBranch":"HEAD"}`,
  `{"parentUuid":"d0c46a86-86d8-404c-b47f-bf2e73edbb78","isSidechain":false,"message":{"model":"claude-opus-4-8","id":"msg_017fVtthUW8o1kiDG8C1B3aj","type":"message","role":"assistant","content":[{"type":"text","text":"noted."}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":11091,"output_tokens":120,"service_tier":"standard"},"diagnostics":null},"requestId":"req_011Cc5qvnKpq7MWrXkoc5FQt","type":"assistant","uuid":"7941fdee-01e9-4164-b0c4-e4c521054b52","timestamp":"2026-06-15T22:36:05.091Z","userType":"external","entrypoint":"sdk-cli","cwd":"C:\\\\Users\\\\ryguy\\\\AppData\\\\Local\\\\Temp\\\\bo10-live-ByCajV","sessionId":"690a8991-ae7f-436d-94d1-732100ba74a8","version":"2.1.170","gitBranch":"HEAD"}`,
  `{"type":"queue-operation","operation":"enqueue","timestamp":"2026-06-15T22:36:01.933Z","sessionId":"690a8991-ae7f-436d-94d1-732100ba74a8"}`,
  `{"parentUuid":"f2118782-e774-4450-ae55-5709ce5f450a","isSidechain":false,"message":{"model":"claude-opus-4-8","id":"msg_01EvVEDUEM331Rjh4GFrbeTN","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01R8hpnP5UDCM5z5uePHxhgF","name":"Write","input":{"file_path":"C:/Users/ryguy/AppData/Local/Temp/bo10-live-ByCajV/should-not-exist.txt","content":"READY"},"caller":{"type":"direct"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":4452,"output_tokens":566,"service_tier":"standard"},"diagnostics":null},"requestId":"req_011Cc5qw2Se6xaVxo9CSx29f","type":"assistant","uuid":"9c293b9b-e27e-4a73-8dbc-214ec4ab81c4","timestamp":"2026-06-15T22:36:13.382Z","userType":"external","entrypoint":"sdk-cli","cwd":"C:\\\\Users\\\\ryguy\\\\AppData\\\\Local\\\\Temp\\\\bo10-live-ByCajV","sessionId":"690a8991-ae7f-436d-94d1-732100ba74a8","version":"2.1.170","gitBranch":"HEAD"}`,
  `{"parentUuid":"9c293b9b-e27e-4a73-8dbc-214ec4ab81c4","isSidechain":false,"promptId":"cbb9bedb-9a0f-4f31-977c-16e0139a312e","type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"agent-exited","is_error":true,"tool_use_id":"toolu_01R8hpnP5UDCM5z5uePHxhgF"}]},"uuid":"6b72a502-44de-4865-8a50-e09a98082bcb","timestamp":"2026-06-15T22:36:13.412Z","toolUseResult":"Error: agent-exited","sourceToolAssistantUUID":"9c293b9b-e27e-4a73-8dbc-214ec4ab81c4","userType":"external","entrypoint":"sdk-cli","cwd":"C:\\\\Users\\\\ryguy\\\\AppData\\\\Local\\\\Temp\\\\bo10-live-ByCajV","sessionId":"690a8991-ae7f-436d-94d1-732100ba74a8","version":"2.1.170","gitBranch":"HEAD"}`,
]

/**
 * A `isSidechain:true` line (a Task-tool subagent's internal turn) — must be
 * DROPPED so a subagent's chatter never pollutes the main conversation view.
 */
export const SIDECHAIN_LINE =
  `{"parentUuid":"x","isSidechain":true,"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"subagent internal reasoning"}]},"uuid":"side-1","sessionId":"690a8991-ae7f-436d-94d1-732100ba74a8"}`

/**
 * An `isMeta:true` line (a synthetic system-injected user message, e.g. a caveat
 * or command echo) — must be DROPPED, it is not a real conversational turn.
 */
export const META_LINE =
  `{"isMeta":true,"type":"user","message":{"role":"user","content":[{"type":"text","text":"Caveat: the messages below were generated by the user while running a local command."}]},"uuid":"meta-1","sessionId":"690a8991-ae7f-436d-94d1-732100ba74a8"}`

/** A truncated/partial trailing line (a half-flushed write) — must NOT throw. */
export const PARTIAL_LAST_LINE = `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","te`

/**
 * The full fixture file body: the real lines, then a sidechain + meta line (both
 * dropped), then a partial trailing line with NO terminating newline.
 */
export const REAL_TRANSCRIPT_JSONL: string =
  [...REAL_TRANSCRIPT_LINES, SIDECHAIN_LINE, META_LINE].join("\n") +
  "\n" +
  PARTIAL_LAST_LINE
