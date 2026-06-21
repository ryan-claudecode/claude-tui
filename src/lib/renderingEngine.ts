/**
 * BO-4a — the renderer's view of the session rendering transport. Replaces the
 * BO-2 dev gate (`agentViewFlag`): the engine is now driven by config
 * (`config.rendering.engine`, surfaced through `window.api.getConfig`), not a
 * localStorage flag. Pure and node-free so it stays in the renderer bundle —
 * it deliberately does NOT import `electron/config` (whose runtime pulls in
 * node:fs / persist). It mirrors that module's `resolveRenderingEngine` default
 * (CAPP-39 gate ④): "structured" unless the config explicitly says "xterm", and is
 * kept logically in sync with it as a future-proofing invariant.
 *
 * NOTE: the LIVE renderer fork actually keys on the per-terminal, backend-stamped
 * `t.engine` field (src/App.tsx / src/components/SplitView.tsx) — NOT this helper.
 * `resolveEngine` is currently a pure, tested helper that does not gate any live
 * render decision; keep it correct so it stays a valid fallback/source of truth.
 */
export type RenderingEngine = "xterm" | "structured"

/** Resolve the engine from the (possibly null, still-loading) renderer config. */
export function resolveEngine(
  config: { rendering?: { engine?: string } } | null | undefined,
): RenderingEngine {
  return config?.rendering?.engine === "xterm" ? "xterm" : "structured"
}
