import { useState, useCallback } from "react"
import type { ContextSourceView, InspectResultView } from "../../lib/contextInspectorView"
import type { PanelApi } from "../../lib/panelApi"

export type { ContextSourceView, InspectResultView } from "../../lib/contextInspectorView"

/** The slice of `PanelApi` this panel uses (the read-only Refresh re-read). When
 *  absent → Refresh is a no-op and the seed result stays put (CAPP-106 / S1). */
type ContextInspectorApi = Pick<PanelApi, "inspectWorkspaceContext">

/**
 * CAPP-98 / I1 — the Context Inspector panel (READ-ONLY).
 *
 * Renders, by precedence (top = highest), the complete launch-time native context a fresh
 * Claude session eats in a workspace PLUS our injected primer — modeled on
 * `SessionOverviewPanel` (read-only, collapsible sections), NOT the editable
 * `WorkspaceMemoryPanel`. This window NEVER mutates anything: the only call it makes is the
 * read-only `inspectWorkspaceContext` (its Refresh button).
 *
 * The data arrives as STATIC seed props (fetched main-side at open time and passed via
 * `show_panel`). There is no live-refresh subscription — a statically-visible Refresh
 * button re-invokes `context:inspect` for the captured workspaceId. v1 shows @import LINES
 * literally (a count line per tier), never expanding their bodies, and renders a "none"
 * placeholder for every absent tier (the completeness claim depends on showing empties).
 *
 * The view types are a RENDERER-SIDE MIRROR of the canonical
 * `electron/services/contextInspector.ts` contract (`src/lib/contextInspectorView.ts`) — the
 * canonical types can't be imported into the renderer because that module pulls in
 * `node:fs`/`node:child_process`. A compile-time parity pin
 * (`electron/services/contextInspectorViewSync.test.ts`) fails the build on drift.
 */

export interface ContextInspectorProps {
  /** The workspace the inspection targets (captured at open time; null = untagged "All"). */
  workspaceId: string | null
  /** Display name for the title bar (optional). */
  workspaceName?: string
  /** The seed inspection result (fetched main-side at open). */
  result: InspectResultView
  /** CAPP-106 / S1 — the bridge (companion OR main window). Optional; absent → the
   *  Refresh button is a no-op and the seed result stays put (never throws). */
  api?: ContextInspectorApi
}

/** The verbatim honesty header (design doc §A.2) — v1 must NOT overclaim. */
const HONESTY_COPY =
  "Files Claude loads at launch, in precedence order. Imported files listed but not expanded. Full resolved view coming soon."

/** Render a single tier source as a collapsible section. A present source defaults open;
 *  a "none" placeholder renders collapsed-but-visible (the tier is never omitted). */
function SourceSection({ source }: { source: ContextSourceView }) {
  return (
    <details className="ctx-source" open={source.exists}>
      <summary className="ctx-source-summary">
        <span className="ctx-tier-badge">#{source.tier}</span>
        <span className="ctx-source-label">{source.label}</span>
        {source.excluded && <span className="ctx-badge ctx-badge-excluded">excluded</span>}
        {!source.exists && <span className="ctx-badge ctx-badge-none">none</span>}
        {source.imports.length > 0 && (
          <span className="ctx-badge ctx-badge-imports">
            {source.imports.length} @import{source.imports.length === 1 ? "" : "s"}
          </span>
        )}
      </summary>

      <div className="ctx-source-body">
        <div className="ctx-source-path" title={source.path}>
          {source.path}
        </div>

        {source.truncatedNote && <div className="ctx-source-note">{source.truncatedNote}</div>}

        {source.exists ? (
          <pre className="ctx-source-content">{source.content || "(empty)"}</pre>
        ) : (
          <div className="ctx-source-empty">No source at this tier.</div>
        )}

        {source.imports.length > 0 && (
          <div className="ctx-imports">
            <div className="ctx-imports-head">
              Contains {source.imports.length} @import
              {source.imports.length === 1 ? "" : "s"} — bodies also load but are not expanded here:
            </div>
            <ul className="ctx-imports-list">
              {source.imports.map((imp, i) => (
                <li key={i} className="ctx-import-line">
                  {imp}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  )
}

export default function ContextInspectorPanel(props: ContextInspectorProps) {
  const { workspaceId, workspaceName } = props
  // Seed from props; the Refresh button replaces it with a fresh read-only inspection.
  const [result, setResult] = useState<InspectResultView>(props.result)
  const [refreshing, setRefreshing] = useState(false)

  const handleRefresh = useCallback(async () => {
    if (refreshing || !props.api) return
    setRefreshing(true)
    try {
      const fresh = await props.api.inspectWorkspaceContext(workspaceId)
      if (fresh) setResult(fresh)
    } catch {
      // A read-only inspection failure is non-fatal — keep the last good result.
    } finally {
      setRefreshing(false)
    }
  }, [workspaceId, refreshing, props.api])

  return (
    <div className="context-inspector-panel">
      <div className="ctx-header">
        <h2 className="ctx-title">
          Context Inspector{workspaceName ? <span className="ctx-ws-name"> · {workspaceName}</span> : null}
        </h2>
        {/* Always-visible Refresh (NO hover-reveal) — re-runs the read-only inspection. */}
        <button
          type="button"
          className="ctx-refresh"
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          title="Re-read the launch-time context (read-only)"
        >
          {refreshing ? "Refreshing…" : "↻ Refresh"}
        </button>
      </div>

      <p className="ctx-honesty">{HONESTY_COPY}</p>

      <div className="ctx-meta">
        <div className="ctx-meta-row">
          <span className="ctx-meta-key">Folder</span>
          <span className="ctx-meta-val">{result.folder ?? "(folderless / untagged)"}</span>
        </div>
        <div className="ctx-meta-row">
          <span className="ctx-meta-key">Git root</span>
          <span className="ctx-meta-val">{result.gitRoot ?? "(not in a git repo)"}</span>
        </div>
        <div className="ctx-meta-row">
          <span className="ctx-meta-key">Adopted</span>
          <span className="ctx-meta-val">
            {result.adopted ? "yes (via your @import)" : "no"}
          </span>
        </div>
      </div>

      <div className="ctx-sources">
        {result.sources.map((s, i) => (
          <SourceSection key={`${s.tier}-${s.path}-${i}`} source={s} />
        ))}
      </div>
    </div>
  )
}
