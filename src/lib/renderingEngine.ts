/**
 * BO-4a — the renderer's view of the session rendering transport. Replaces the
 * BO-2 dev gate (`agentViewFlag`): the engine is now driven by config
 * (`config.rendering.engine`, surfaced through `window.api.getConfig`), not a
 * localStorage flag. Pure and node-free so it stays in the renderer bundle —
 * it deliberately does NOT import `electron/config` (whose runtime pulls in
 * node:fs / persist). It mirrors that module's `resolveRenderingEngine` default:
 * "xterm" unless the config explicitly says "structured".
 */
export type RenderingEngine = "xterm" | "structured"

/** Resolve the engine from the (possibly null, still-loading) renderer config. */
export function resolveEngine(
  config: { rendering?: { engine?: string } } | null | undefined,
): RenderingEngine {
  return config?.rendering?.engine === "structured" ? "structured" : "xterm"
}
