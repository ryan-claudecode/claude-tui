/**
 * CAPP-125 — VERBATIM `result` events captured from a LIVE `claude -p` headless run
 * (claude v2.1.199, Windows, `--model haiku --dangerously-skip-permissions`,
 * stream-json in/out). Reproduce with the scratch capture harness: hold ONE process's
 * stdin open, send two user messages ("Reply with … apple", then "… banana"), waiting
 * for each turn's `result` on stdout; then `--resume` that session in a NEW process and
 * send a third ("… cherry").
 *
 * These objects are the `.raw` payload of the `result` StreamEvent (i.e. exactly what
 * `extractCost(event.raw)` reads). They are the ground truth behind the CAPP-125 fix.
 *
 * ═══ THE VERDICT (why the rail COST footer triangular-overcounted) ═══
 *
 * `total_cost_usd` is **CUMULATIVE per process** — turn 2 carries turn 1 + turn 2:
 *     turn1 total_cost_usd = 0.013738
 *     turn2 total_cost_usd = 0.0263881   (= 0.013738 + turn2's own ~0.012650)
 * `modelUsage.*` is likewise cumulative (turn2 outputTokens 564 = 458 + 106;
 * cacheReadInputTokens 54781 = 25160 + 29621). So summing each turn's `total_cost_usd`
 * as if it were per-turn is a triangular overcount (Σ of the running cumulatives).
 *
 * The TOP-LEVEL `usage` object is **PER-TURN** (the MIRROR of cost):
 *     turn1 usage.output_tokens = 458
 *     turn2 usage.output_tokens = 106   (this turn only — NOT the cumulative 564)
 *     turn2 usage.input_tokens  = 10    (this turn only — NOT 20)
 * So `ResultCost.totalTokens` (built from top-level `usage`) is already per-turn and a
 * plain sum of it across turns is correct — only the COST needed a cumulative→delta fix.
 *
 * `--resume` in a FRESH process RESETS the cumulative counter (does NOT carry history):
 *     resume-turn1 total_cost_usd = 0.0053555   (its own turn only, < 0.0263881)
 * → the per-turn delta logic must treat a `current < previous` drop as a reset and let
 *   that turn contribute its own `current` (never a negative delta).
 *
 * DO NOT hand-edit; regenerate from a fresh capture if Claude Code drifts.
 */

/** PROCESS 1, turn 1 — the process's FIRST result. total_cost_usd is this turn's cost. */
export const P1_TURN1_RESULT_RAW = {
  type: "result",
  subtype: "success",
  is_error: false,
  api_error_status: null,
  duration_ms: 6956,
  duration_api_ms: 6757,
  ttft_ms: 6821,
  ttft_stream_ms: 1149,
  time_to_request_ms: 84,
  num_turns: 1,
  result: "apple",
  stop_reason: "end_turn",
  session_id: "986bd646-37a4-4454-ab60-ed17e341cbf3",
  total_cost_usd: 0.013738,
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 4461,
    cache_read_input_tokens: 25160,
    output_tokens: 458,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard",
    cache_creation: { ephemeral_1h_input_tokens: 4461, ephemeral_5m_input_tokens: 0 },
    inference_geo: "not_available",
    iterations: [
      {
        input_tokens: 10,
        output_tokens: 458,
        cache_read_input_tokens: 25160,
        cache_creation_input_tokens: 4461,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 4461 },
        type: "message",
      },
    ],
    speed: "standard",
  },
  modelUsage: {
    "claude-haiku-4-5-20251001": {
      inputTokens: 10,
      outputTokens: 458,
      cacheReadInputTokens: 25160,
      cacheCreationInputTokens: 4461,
      webSearchRequests: 0,
      costUSD: 0.013738,
      contextWindow: 200000,
      maxOutputTokens: 32000,
    },
  },
  permission_denials: [],
  terminal_reason: "completed",
  fast_mode_state: "off",
  uuid: "fb9843a7-66f2-48a6-9443-9185be9fb5ae",
} as const

/** PROCESS 1, turn 2 — SAME process. total_cost_usd 0.0263881 = turn1 + turn2 (CUMULATIVE),
 *  while top-level usage.output_tokens 106 is this turn ALONE (PER-TURN). */
export const P1_TURN2_RESULT_RAW = {
  type: "result",
  subtype: "success",
  is_error: false,
  api_error_status: null,
  duration_ms: 1860,
  duration_api_ms: 8468,
  ttft_ms: 1708,
  ttft_stream_ms: 711,
  time_to_request_ms: 15,
  num_turns: 1,
  result: "banana",
  stop_reason: "end_turn",
  session_id: "986bd646-37a4-4454-ab60-ed17e341cbf3",
  total_cost_usd: 0.0263881,
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 4574,
    cache_read_input_tokens: 29621,
    output_tokens: 106,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard",
    cache_creation: { ephemeral_1h_input_tokens: 4574, ephemeral_5m_input_tokens: 0 },
    inference_geo: "not_available",
    iterations: [
      {
        input_tokens: 10,
        output_tokens: 106,
        cache_read_input_tokens: 29621,
        cache_creation_input_tokens: 4574,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 4574 },
        type: "message",
      },
    ],
    speed: "standard",
  },
  modelUsage: {
    "claude-haiku-4-5-20251001": {
      inputTokens: 20,
      outputTokens: 564,
      cacheReadInputTokens: 54781,
      cacheCreationInputTokens: 9035,
      webSearchRequests: 0,
      costUSD: 0.0263881,
      contextWindow: 200000,
      maxOutputTokens: 32000,
    },
  },
  permission_denials: [],
  terminal_reason: "completed",
  fast_mode_state: "off",
  uuid: "c7033651-af98-4a1e-8321-c76419cebdce",
} as const

/** PROCESS 2, resume turn 1 — a FRESH process via `--resume`. total_cost_usd 0.0053555
 *  is this turn ALONE (< the prior process's 0.0263881) → the counter RESET. */
export const P2_RESUME_RESULT_RAW = {
  type: "result",
  subtype: "success",
  is_error: false,
  api_error_status: null,
  duration_ms: 1399,
  duration_api_ms: 1154,
  ttft_ms: 1246,
  ttft_stream_ms: 924,
  time_to_request_ms: 130,
  num_turns: 1,
  result: "cherry",
  stop_reason: "end_turn",
  session_id: "986bd646-37a4-4454-ab60-ed17e341cbf3",
  total_cost_usd: 0.005355500000000001,
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 848,
    cache_read_input_tokens: 34195,
    output_tokens: 46,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard",
    cache_creation: { ephemeral_1h_input_tokens: 848, ephemeral_5m_input_tokens: 0 },
    inference_geo: "not_available",
    iterations: [
      {
        input_tokens: 10,
        output_tokens: 46,
        cache_read_input_tokens: 34195,
        cache_creation_input_tokens: 848,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 848 },
        type: "message",
      },
    ],
    speed: "standard",
  },
  modelUsage: {
    "claude-haiku-4-5-20251001": {
      inputTokens: 10,
      outputTokens: 46,
      cacheReadInputTokens: 34195,
      cacheCreationInputTokens: 848,
      webSearchRequests: 0,
      costUSD: 0.005355500000000001,
      contextWindow: 200000,
      maxOutputTokens: 32000,
    },
  },
  permission_denials: [],
  terminal_reason: "completed",
  fast_mode_state: "off",
  uuid: "656fe27a-aed0-4bf9-88bb-0b891a2c2aeb",
} as const
