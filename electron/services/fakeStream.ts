/**
 * BO-4b — a hermetic, test-only fake for the HEADLESS stream-json transport.
 *
 * The e2e smoke (and any future structured-UI test) needs to exercise the REAL
 * renderer + main process WITHOUT spawning a real `claude` (the e2e hermetic
 * invariant — see e2e/smoke.spec.ts). This module provides a {@link SpawnProc}
 * (the same seam `realSpawnProc` fills) that drives a canned stream instead of a
 * child process. It is wired as the env-gated DEFAULT in TerminalService's
 * constructor: when `CLAUDETUI_FAKE_STREAM=1`, `createHeadless` spawns this fake.
 * Production (env unset) is byte-for-byte unchanged.
 *
 * Faithfulness matters: it models the one behavior that drives the BO-4b bug —
 * `claude -p --input-format stream-json` emits NOTHING until the first user
 * message lands on stdin. So the fake stays silent on spawn (no `init`), and only
 * on the first `write()` does it emit a scripted `init` → streamed assistant text
 * deltas → `result`. That lets a test prove the full human→agent→render loop
 * (composer → stdin sink → stream → AgentView) AND that a fresh structured
 * terminal is parked idle (no events ⇒ no active burst) until the user types.
 *
 * The emitted lines are EXACTLY the wire shapes the real parser (streamEvents.ts)
 * consumes — the fake feeds raw NDJSON through `proc.onStdout`, so the whole
 * parse → reduce → render pipeline is exercised, not bypassed.
 */
import type { ProcLike, SpawnProc, SpawnProcOptions } from "./terminals"

/**
 * The canned reply the fake streams back, split into deltas to exercise the
 * reducer's coalescing AND (BO-8) the inline markdown renderer. It is a small
 * GFM document — heading, bold, inline code, list, fenced code block, table, link
 * — so the structured e2e can assert the reply renders as FORMATTED markup, not
 * raw text. The deltas are deliberately split so a boundary lands mid-unclosed-bold
 * AND right after an OPEN ``` fence: the renderer must tolerate that partial state
 * between deltas without throwing/flicker (streaming-safe). Still contains the
 * recognizable "fake agent" text the older smoke assertions key on, and
 * REPLY_TEXT === the deltas joined, so the turn-complete `result` echoes the
 * streamed assistant text and the dedup keeps a single rendered reply.
 */
const REPLY_DELTAS = [
  "# Fake agent reply\n\nHello from the **fake ",
  "agent**. Here is some `inline` code and a list:\n\n- first\n- second\n\n```js\n",
  "const x = 1\n```\n\n| key | value |\n| --- | ----- |\n| a   | 1     |\n\n",
  "See [the docs](https://example.com).\n",
] as const
/** EXPORTED (CAPP-119 review, finding 4) so the unit suite can PIN that this canned
 *  reply passes `assistantExpandUseful` — the CAPP-111 e2e clicks the settled
 *  assistant block's expand button, which only renders because this text carries a
 *  fenced code block. The pin fails FIRST (fast, in vitest) if the fixture and the
 *  usefulness gate ever drift apart. */
export const REPLY_TEXT = REPLY_DELTAS.join("")

/**
 * CAPP-49 — test-only opt-in: a user message containing this sentinel keeps the turn
 * OPEN (the agent stays "working") instead of streaming to a `result`. Real
 * `claude -p` has no such knob; it exists purely so a split-pane e2e can observe a
 * SUSTAINED busy/Stop state (a normal fake turn flips idle ~1.5s after its burst,
 * which is too racy to assert against). The held turn emits `init` + one delta to go
 * active, then a heartbeat delta faster than the 1.5s idle timer until the proc is
 * killed (Stop/interrupt/model-switch/close all kill it, clearing the heartbeat).
 */
const HOLD_SENTINEL = "__HOLD_TURN__"

/**
 * CAPP-39 gate ② — test-only opt-in: a user message containing this sentinel makes
 * the fake replay the LIVE UNAUTHENTICATED shape — init FIRST (apiKeySource:"none",
 * which a healthy session also reports), then an assistant with
 * error:"authentication_failed" and a result with is_error:true + "Not logged in".
 * This drives the parser's post-init auth detection (NOT the exit-before-init synth,
 * since init fires) so an e2e can assert the actionable Sign-in block renders.
 */
const AUTH_FAIL_SENTINEL = "__AUTH_FAIL__"

/**
 * CAPP-111 (S4) — test-only opt-in: a user message containing this sentinel makes
 * the fake emit a turn that includes TOOL blocks (an Edit + a Bash tool_use, each
 * with its tool_result), so the structured e2e can assert the per-block expand
 * button renders ICON-ONLY (compact) on the dense tool rows. Real `claude -p` has
 * no such knob; it exists purely so a hermetic test can render a multi-tool
 * transcript without a real claude.
 */
const TOOLS_SENTINEL = "__TOOLS_TURN__"

/** Build one NDJSON line (no trailing newline — the caller adds it). */
function line(obj: unknown): string {
  return JSON.stringify(obj)
}

/**
 * A SpawnProc that returns a {@link ProcLike} backed by a scripted stream rather
 * than a real process. Each spawn gets its own closures, so concurrent fake
 * terminals don't interfere.
 */
export const fakeStreamProc: SpawnProc = (
  _file: string,
  _args: string[],
  options: SpawnProcOptions,
): ProcLike => {
  let onStdout: ((data: string) => void) | null = null
  let onExit: ((e: { code: number | null }) => void) | null = null
  let alive = true
  // CAPP-49 — the heartbeat timer for a held (open) turn; cleared on kill.
  let holdTimer: ReturnType<typeof setInterval> | null = null
  // Use a monotonically increasing fake pid that's positive (the real ProcLike
  // contract is pid >= 0 for a live proc).
  const pid = 1_000_000 + Math.floor(performance.now())

  const emit = (s: string) => {
    if (alive && onStdout) onStdout(s)
  }

  // Stream the scripted turn asynchronously, mimicking real streaming cadence so
  // the renderer applies deltas incrementally (and the active→idle dot moves).
  const streamReply = () => {
    // 1) init — proves the session booted (sets sawInit, so no synthetic
    //    needs_auth on exit).
    emit(
      line({
        type: "system",
        subtype: "init",
        session_id: "fake-session",
        cwd: options.cwd,
        model: "fake-model",
        tools: [],
        mcp_servers: [],
        // BO-7 — sample catalog so the e2e can exercise the `/`-command picker
        // against a LIVE init (not a hardcoded list). `config` is a native-mapped
        // built-in; `chrome-live`/`deep-research` mirror real skills.
        slash_commands: ["clear", "compact", "config", "resume"],
        skills: ["chrome-live", "deep-research"],
        apiKeySource: "none",
      }) + "\n",
    )
    // 2) streamed assistant text deltas.
    for (const text of REPLY_DELTAS) {
      emit(
        line({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text } },
        }) + "\n",
      )
    }
    // 3) result — turn complete (parks the terminal idle). Carries a cost/usage block
    //    (real `claude -p` results do) so the Agent Rail v1 COST footer can sum a
    //    non-zero session total in the e2e — the rail reads ResultCost off this shape.
    emit(
      line({
        type: "result",
        subtype: "success",
        is_error: false,
        result: REPLY_TEXT,
        total_cost_usd: 0.0123,
        duration_ms: 1234,
        num_turns: 1,
        usage: {
          input_tokens: 1200,
          output_tokens: 340,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 5000,
        },
      }) + "\n",
    )
  }

  /** CAPP-49 — stream a turn that NEVER completes: init + one delta to go active,
   *  then an empty-text heartbeat delta every 300ms (well under the 1.5s idle timer)
   *  so the terminal stays busy until killed. */
  const streamHeld = () => {
    emit(
      line({
        type: "system",
        subtype: "init",
        session_id: "fake-session",
        cwd: options.cwd,
        model: "fake-model",
        tools: [],
        mcp_servers: [],
        slash_commands: ["clear", "compact", "config", "resume"],
        skills: ["chrome-live", "deep-research"],
        apiKeySource: "none",
      }) + "\n",
    )
    emit(
      line({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Working… " } },
      }) + "\n",
    )
    holdTimer = setInterval(() => {
      emit(
        line({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "" } },
        }) + "\n",
      )
    }, 300)
  }

  /** CAPP-111 — a turn carrying TWO tool calls (Edit + Bash), each correlated with
   *  its tool_result, then a short assistant text + result. The reducer folds the
   *  tool_use/tool_result pairs into `tool` blocks so the e2e can assert the compact
   *  (icon-only) expand button on the dense tool rows. */
  const streamTools = () => {
    emit(
      line({
        type: "system",
        subtype: "init",
        session_id: "fake-session",
        cwd: options.cwd,
        model: "fake-model",
        tools: [],
        mcp_servers: [],
        slash_commands: ["clear", "compact", "config", "resume"],
        skills: ["chrome-live", "deep-research"],
        apiKeySource: "none",
      }) + "\n",
    )
    // An assistant message bundling two tool_use blocks (Edit → diff panel, Bash →
    // markdown panel) — the shapes streamEvents.ts fans out into one `tool` block each.
    emit(
      line({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-edit-1",
              name: "Edit",
              input: { file_path: "src/x.ts", old_string: "foo", new_string: "bar" },
            },
            { type: "tool_use", id: "tool-bash-1", name: "Bash", input: { command: "ls -la" } },
          ],
        },
      }) + "\n",
    )
    // The correlated tool_results (a `user` message), flipping each tool to done.
    emit(
      line({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool-edit-1", content: "edited" },
            { type: "tool_result", tool_use_id: "tool-bash-1", content: "x.ts\ny.ts" },
          ],
        },
      }) + "\n",
    )
    emit(
      line({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Done with the tools." } },
      }) + "\n",
    )
    emit(
      line({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Done with the tools.",
        total_cost_usd: 0.001,
        duration_ms: 100,
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }) + "\n",
    )
  }

  /** CAPP-39 gate ② — replay the live UNAUTH shape: init (apiKeySource:"none") FIRES
   *  first, then the explicit auth-failure assistant + result. */
  const streamAuthFail = () => {
    emit(
      line({
        type: "system",
        subtype: "init",
        session_id: "fake-session",
        cwd: options.cwd,
        model: "fake-model",
        tools: [],
        mcp_servers: [],
        slash_commands: ["clear", "compact", "config", "resume"],
        skills: ["chrome-live", "deep-research"],
        // The false-positive trap: a HEALTHY subscription login reports this too.
        apiKeySource: "none",
      }) + "\n",
    )
    emit(
      line({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Not logged in · Please run /login" }],
        },
        error: "authentication_failed",
      }) + "\n",
    )
    emit(
      line({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Not logged in · Please run /login",
      }) + "\n",
    )
  }

  return {
    get pid() {
      return pid
    },
    onStdout: (cb) => {
      onStdout = cb
    },
    onStderr: () => {
      // The fake never writes to stderr.
    },
    onExit: (cb) => {
      onExit = cb
    },
    write: (data: string) => {
      if (!alive) return
      // Faithful to real `claude -p`: nothing is emitted until the FIRST user
      // message arrives. Subsequent messages re-run the scripted turn. Defer to a
      // macrotask so the emit happens after the current call stack (the
      // sendAgentMessage → markActive path) settles, mimicking async stdout.
      // CAPP-49 — a message carrying the hold sentinel keeps the turn open (busy).
      // CAPP-39 — the auth-fail sentinel replays the live unauthenticated shape.
      const turn = data.includes(AUTH_FAIL_SENTINEL)
        ? streamAuthFail
        : data.includes(TOOLS_SENTINEL)
          ? streamTools
          : data.includes(HOLD_SENTINEL)
            ? streamHeld
            : streamReply
      setTimeout(turn, 0)
    },
    kill: () => {
      if (!alive) return
      alive = false
      if (holdTimer) {
        clearInterval(holdTimer)
        holdTimer = null
      }
      // Mirror a clean child exit so any onExit consumer runs its normal path.
      setTimeout(() => onExit?.({ code: 0 }), 0)
    },
  }
}
