/**
 * Captured REAL Claude Code headless stream-json event lines (BO-1 de-risk).
 *
 * Produced by a live run on Windows of:
 *   claude -p --output-format stream-json --input-format stream-json  *     --include-partial-messages --verbose [--mcp-config <path>]
 *
 * These are the AUTHORITATIVE fixtures for the parser tests: the JSON shapes
 * here were emitted by a real binary, NOT invented. The INIT line had its long
 * tools[]/mcp_servers[]/slash_commands[] arrays trimmed for brevity (every key
 * and value TYPE is verbatim from the capture). THINKING_DELTA_WITH_TEXT reuses
 * the real thinking_delta envelope with a non-empty `thinking` value so a test
 * can assert text extraction (the live capture happened to stream empty thinking
 * placeholders). Everything else is byte-for-byte from stdout.
 *
 * DO NOT hand-edit; regenerate from a fresh capture if Claude Code drifts.
 */

export const INIT = "{\"type\":\"system\",\"subtype\":\"init\",\"cwd\":\"C:\\\\Users\\\\ryguy\\\\AppData\\\\Local\\\\Temp\\\\bo1-derisk\",\"session_id\":\"5a8fdaf7-541d-4a23-b212-62d81175cc3b\",\"tools\":[\"Task\",\"AskUserQuestion\",\"Bash\"],\"mcp_servers\":[{\"name\":\"claudetui\",\"status\":\"connected\"},{\"name\":\"plugin:atlassian:atlassian\",\"status\":\"needs-auth\"}],\"model\":\"claude-opus-4-8[1m]\",\"permissionMode\":\"default\",\"slash_commands\":[\"apiref-check\",\"chrome-live\"],\"apiKeySource\":\"none\",\"claude_code_version\":\"2.1.170\",\"output_style\":\"default\",\"agents\":[\"claude\",\"Explore\"],\"skills\":[\"apiref-check\",\"chrome-live\"],\"plugins\":[{\"name\":\"superpowers\",\"path\":\"C:\\\\Users\\\\ryguy\\\\.claude\\\\plugins\\\\cache\\\\claude-plugins-official\\\\superpowers\\\\5.1.0\",\"source\":\"superpowers@claude-plugins-official\"}],\"analytics_disabled\":false,\"product_feedback_disabled\":false,\"uuid\":\"014831d0-1a04-400f-b480-856f37f80659\",\"memory_paths\":{\"auto\":\"C:\\\\Users\\\\ryguy\\\\.claude\\\\projects\\\\C--Users-ryguy-AppData-Local-Temp-bo1-derisk\\\\memory\\\\\"},\"fast_mode_state\":\"off\"}"

export const ASSISTANT_TEXT_DELTA = "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"I'll find the echo MCP tool first.\"}},\"session_id\":\"7b9f679e-6f80-41ec-bd31-bac8e76c2e1c\",\"parent_tool_use_id\":null,\"uuid\":\"33061d83-6276-413e-af37-fee86ffe79cd\"}"

export const THINKING_DELTA = "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"\",\"estimated_tokens\":50}},\"session_id\":\"7b9f679e-6f80-41ec-bd31-bac8e76c2e1c\",\"parent_tool_use_id\":null,\"uuid\":\"5e0a9f69-6846-48a4-8251-47b38764b0c6\"}"

export const THINKING_DELTA_WITH_TEXT = "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"Let me find the echo MCP tool, then call it.\",\"estimated_tokens\":50}},\"session_id\":\"7b9f679e-6f80-41ec-bd31-bac8e76c2e1c\",\"parent_tool_use_id\":null,\"uuid\":\"5e0a9f69-6846-48a4-8251-47b38764b0c6\"}"

export const ASSISTANT_TOOL_USE = "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-4-8\",\"id\":\"msg_01QLZT4DZ37C58oQAavgYaPN\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_01Gq29CunqooAUkvro9BcfSC\",\"name\":\"ToolSearch\",\"input\":{\"query\":\"echo\",\"max_results\":5},\"caller\":{\"type\":\"direct\"}}],\"stop_reason\":null,\"stop_sequence\":null,\"stop_details\":null,\"usage\":{\"input_tokens\":8648,\"cache_creation_input_tokens\":2095,\"cache_read_input_tokens\":20713,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":2095},\"output_tokens\":2,\"service_tier\":\"standard\",\"inference_geo\":\"not_available\"},\"diagnostics\":null,\"context_management\":null},\"parent_tool_use_id\":null,\"session_id\":\"7b9f679e-6f80-41ec-bd31-bac8e76c2e1c\",\"uuid\":\"8acfc2c0-307e-48f7-a66c-f2db604abfd5\",\"request_id\":\"req_011Cc1wgr6anKEo2XbVMu2Gw\"}"

export const USER_TOOL_RESULT = "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_01Gq29CunqooAUkvro9BcfSC\",\"content\":[{\"type\":\"tool_reference\",\"tool_name\":\"Monitor\"}]}]},\"parent_tool_use_id\":null,\"session_id\":\"7b9f679e-6f80-41ec-bd31-bac8e76c2e1c\",\"uuid\":\"c310fb05-a6e2-4061-8335-ff6468362b31\",\"timestamp\":\"2026-06-13T21:09:15.447Z\",\"tool_use_result\":{\"matches\":[\"Monitor\"],\"query\":\"echo\",\"total_deferred_tools\":184}}"

export const RESULT = "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"api_error_status\":null,\"duration_ms\":1470,\"duration_api_ms\":1277,\"ttft_ms\":1285,\"ttft_stream_ms\":1219,\"time_to_request_ms\":70,\"num_turns\":1,\"result\":\"hi\",\"stop_reason\":\"end_turn\",\"session_id\":\"5a8fdaf7-541d-4a23-b212-62d81175cc3b\",\"total_cost_usd\":0.18570375000000003,\"usage\":{\"input_tokens\":8647,\"cache_creation_input_tokens\":22779,\"cache_read_input_tokens\":0,\"output_tokens\":4,\"server_tool_use\":{\"web_search_requests\":0,\"web_fetch_requests\":0},\"service_tier\":\"standard\",\"cache_creation\":{\"ephemeral_1h_input_tokens\":22779,\"ephemeral_5m_input_tokens\":0},\"inference_geo\":\"not_available\",\"iterations\":[{\"input_tokens\":8647,\"output_tokens\":4,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":22779,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":22779},\"type\":\"message\"}],\"speed\":\"standard\"},\"modelUsage\":{\"claude-opus-4-8[1m]\":{\"inputTokens\":8647,\"outputTokens\":4,\"cacheReadInputTokens\":0,\"cacheCreationInputTokens\":22779,\"webSearchRequests\":0,\"costUSD\":0.18570375000000003,\"contextWindow\":1000000,\"maxOutputTokens\":64000}},\"permission_denials\":[],\"terminal_reason\":\"completed\",\"fast_mode_state\":\"off\",\"uuid\":\"5d7f83c7-51d5-49d8-8fba-706c95fb0ae4\"}"

/**
 * CAPP-39 gate ② — the LIVE auth-failure shapes captured on an UNAUTHENTICATED
 * `claude -p` (claude.exe v2.1.170, piped stdio, stream-json, the app's flags). An
 * unauth session does NOT hang — it exits (code 1, ~3s) after emitting, in order:
 * init (apiKeySource:"none" — same as a HEALTHY subscription login!), a status
 * line, then the assistant + result below. The key insight: init FIRES even
 * unauthenticated, so the exit-before-init synth never triggers here; detection
 * must key on the explicit failure shape, NEVER on apiKeySource.
 *
 * AUTH_FAILURE_ASSISTANT — the assistant event whose TOP-LEVEL `error` is
 * "authentication_failed", carrying the "Not logged in" text. (Note: `error` is a
 * top-level sibling of `message`, not inside it.)
 */
export const AUTH_FAILURE_ASSISTANT =
  "{\"type\":\"assistant\",\"message\":{\"id\":\"msg_auth\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Not logged in · Please run /login\"}],\"stop_reason\":null,\"stop_sequence\":null},\"error\":\"authentication_failed\",\"parent_tool_use_id\":null,\"session_id\":\"auth-fail-session\",\"uuid\":\"a11ce000-0000-4000-8000-000000000001\"}"

/** AUTH_FAILURE_RESULT — the terminal result event, is_error:true, "Not logged in" text. */
export const AUTH_FAILURE_RESULT =
  "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true,\"duration_ms\":2980,\"num_turns\":1,\"result\":\"Not logged in · Please run /login\",\"session_id\":\"auth-fail-session\",\"total_cost_usd\":0,\"uuid\":\"a11ce000-0000-4000-8000-000000000002\"}"

export const RATE_LIMIT ="{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"allowed\",\"resetsAt\":1781395200,\"rateLimitType\":\"five_hour\",\"overageStatus\":\"rejected\",\"overageDisabledReason\":\"org_level_disabled\",\"isUsingOverage\":false},\"uuid\":\"13c4a394-2c42-48fb-ab98-92949584cf67\",\"session_id\":\"5a8fdaf7-541d-4a23-b212-62d81175cc3b\"}"

export const STREAM_MESSAGE_START = "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"model\":\"claude-opus-4-8\",\"id\":\"msg_01EBwVN6YaXxXhyV3xhoQDYF\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"stop_reason\":null,\"stop_sequence\":null,\"stop_details\":null,\"usage\":{\"input_tokens\":8647,\"cache_creation_input_tokens\":22779,\"cache_read_input_tokens\":0,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":22779},\"output_tokens\":1,\"service_tier\":\"standard\",\"inference_geo\":\"not_available\"},\"diagnostics\":null}},\"session_id\":\"5a8fdaf7-541d-4a23-b212-62d81175cc3b\",\"parent_tool_use_id\":null,\"uuid\":\"2d3137de-714b-4d5e-96a7-e03908b2319c\",\"ttft_ms\":1149}"
