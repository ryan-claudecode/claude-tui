import { useState, useEffect, useMemo, useRef } from "react"

/**
 * CAPP-86 — "The Lexicon" RecallPanel (companion window). A read-only cross-session
 * search over every finding + summary the work sessions have accumulated. A search
 * box + always-visible status filters; results are grouped by their owning session,
 * and a session header click-opens that session's Overview. NO hover-reveal — every
 * control (the search box, the filter pills, the "Open overview" button) is always
 * visible.
 */

type RecallStatus = "active" | "ruled-out" | "summary"

/** The synthetic sessionId every workspace-memory hit carries (mirrors
 *  WORKSPACE_MEMORY_SESSION_ID in recall.ts). Used to suppress the "Open overview"
 *  button on the memory group (there's no real session to open). */
const WORKSPACE_MEMORY_SESSION_ID = "__workspace_memory__"

interface RecallHit {
  sessionId: string
  sessionName: string
  workspaceId?: string
  text: string
  status: RecallStatus
  /** "workspace-memory" is the durable promoted/authored tier (CAPP-87 / U4); its hits
   *  carry the synthetic memory sessionId + a "Workspace memory" citation. */
  source: "note" | "summary" | "workspace-memory"
  createdAt: number
  correction?: string
  score: number
}

type StatusFilter = "all" | "active" | "ruled-out"

interface RecallApi {
  recall: (
    query: string,
    scope?: "session" | "workspace" | "all",
    sessionId?: string,
  ) => Promise<RecallHit[]>
  openSessionOverview: (sessionId: string) => Promise<unknown>
}

function recallApi(): RecallApi | undefined {
  // The companion preload exposes these on companionApi; guard so the panel renders
  // (degraded) even if invoked in a context without them (e.g. a hermetic harness).
  const api = (window as unknown as { companionApi?: Partial<RecallApi> }).companionApi
  if (api && typeof api.recall === "function" && typeof api.openSessionOverview === "function") {
    return api as RecallApi
  }
  return undefined
}

export interface RecallPanelProps {
  /** Optional initial query (e.g. when Claude opens the panel pre-seeded). */
  query?: string
  /** Optional initial scope (defaults to 'workspace' — the read-side default). */
  scope?: "session" | "workspace" | "all"
  /** The caller's session id, so 'workspace'/'session' scope resolves correctly. */
  sessionId?: string
}

export default function RecallPanel(props: RecallPanelProps) {
  const [query, setQuery] = useState(props.query ?? "")
  const [scope, setScope] = useState<"session" | "workspace" | "all">(props.scope ?? "workspace")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [hits, setHits] = useState<RecallHit[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)

  // Debounce the live search so each keystroke doesn't fire an IPC round-trip.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const api = recallApi()
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const q = query.trim()
    if (!q) {
      setHits([])
      setSearched(false)
      setLoading(false)
      return
    }
    setLoading(true)
    debounceRef.current = setTimeout(async () => {
      if (!api) {
        setHits([])
        setLoading(false)
        setSearched(true)
        return
      }
      const result = await api.recall(q, scope, props.sessionId).catch(() => [] as RecallHit[])
      setHits(result)
      setLoading(false)
      setSearched(true)
    }, 200)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, scope, props.sessionId])

  const filtered = useMemo(() => {
    if (statusFilter === "all") return hits
    if (statusFilter === "active") return hits.filter((h) => h.status !== "ruled-out")
    return hits.filter((h) => h.status === "ruled-out")
  }, [hits, statusFilter])

  // Group filtered hits by owning session, preserving the (score-then-recency) order
  // the service already returned — the first hit of each session sets its rank.
  const groups = useMemo(() => {
    const map = new Map<string, { sessionId: string; sessionName: string; hits: RecallHit[] }>()
    for (const h of filtered) {
      let g = map.get(h.sessionId)
      if (!g) {
        g = { sessionId: h.sessionId, sessionName: h.sessionName, hits: [] }
        map.set(h.sessionId, g)
      }
      g.hits.push(h)
    }
    return [...map.values()]
  }, [filtered])

  const openOverview = (sessionId: string) => {
    recallApi()?.openSessionOverview(sessionId)
  }

  return (
    <div className="recall-panel">
      <div className="recall-controls">
        <input
          className="recall-search"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search findings across sessions — have we learned this before?"
          autoFocus
          aria-label="Recall search query"
        />
        <div className="recall-filters">
          <div className="recall-filter-group" role="group" aria-label="Status filter">
            <button
              className={`recall-pill ${statusFilter === "all" ? "active" : ""}`}
              onClick={() => setStatusFilter("all")}
            >
              All
            </button>
            <button
              className={`recall-pill ${statusFilter === "active" ? "active" : ""}`}
              onClick={() => setStatusFilter("active")}
            >
              Active
            </button>
            <button
              className={`recall-pill ${statusFilter === "ruled-out" ? "active" : ""}`}
              onClick={() => setStatusFilter("ruled-out")}
            >
              Ruled out
            </button>
          </div>
          <div className="recall-filter-group" role="group" aria-label="Scope filter">
            <button
              className={`recall-pill ${scope === "session" ? "active" : ""}`}
              onClick={() => setScope("session")}
              title="Only this session"
            >
              Session
            </button>
            <button
              className={`recall-pill ${scope === "workspace" ? "active" : ""}`}
              onClick={() => setScope("workspace")}
              title="This workspace (default)"
            >
              Workspace
            </button>
            <button
              className={`recall-pill ${scope === "all" ? "active" : ""}`}
              onClick={() => setScope("all")}
              title="Every workspace"
            >
              All
            </button>
          </div>
        </div>
      </div>

      <div className="recall-results">
        {loading && <div className="recall-empty">Searching…</div>}
        {!loading && !query.trim() && (
          <div className="recall-empty">
            Type to search every finding and summary across your sessions.
          </div>
        )}
        {!loading && searched && query.trim() && filtered.length === 0 && (
          <div className="recall-empty">
            No matches for “{query.trim()}”{statusFilter !== "all" ? ` (${statusFilter})` : ""}.
          </div>
        )}
        {!loading &&
          groups.map((g) => (
            <section key={g.sessionId} className="recall-group">
              <div className="recall-group-header">
                <span className="recall-group-name">{g.sessionName || "Untitled session"}</span>
                {/* The synthetic workspace-memory group has no real session to open, so
                    its "Open overview" affordance is suppressed (CAPP-87 / U4). */}
                {g.sessionId !== WORKSPACE_MEMORY_SESSION_ID && (
                  <button
                    className="recall-open-overview"
                    onClick={() => openOverview(g.sessionId)}
                  >
                    Open overview
                  </button>
                )}
              </div>
              <ul className="recall-hits">
                {g.hits.map((h, i) => (
                  <li key={`${g.sessionId}-${i}`} className={`recall-hit status-${h.status}`}>
                    <span className={`recall-hit-tag tag-${h.status}`}>
                      {h.source === "summary" ? "summary" : h.status === "ruled-out" ? "ruled out" : "finding"}
                    </span>
                    {h.status === "ruled-out" ? (
                      <span className="recall-hit-text">
                        <span className="struck">{h.text}</span>
                        {h.correction && <span className="correction"> → {h.correction}</span>}
                      </span>
                    ) : (
                      <span className="recall-hit-text">{h.text}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
      </div>
    </div>
  )
}
