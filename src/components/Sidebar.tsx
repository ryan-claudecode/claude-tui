import { useState, useCallback, type CSSProperties } from "react"
import { deriveSessionRow } from "../lib/sessionRow"
import { formatWaitTime } from "../lib/attentionRow"
import { goalExcerpt, missionProgress, isMissionDismissable } from "../lib/missionRow"
import { commitRenameValue } from "../lib/renameValue"
import type { ResumingRow } from "../lib/resumingList"
import type { AttentionEntry } from "../hooks/useAttention"
import type { MissionSummary } from "../hooks/useMissions"
import type { WorkspaceSummary } from "../hooks/useWorkspaces"
import WorkspaceSwitcher from "./WorkspaceSwitcher"

interface TerminalRow { id: string; name: string; lastState: string; activity?: string }
interface SessionRow { id: string; name: string; status: string; terminals: TerminalRow[] }

interface Props {
  sessions: SessionRow[]
  activeSessionId: string | null
  attentionEntries: AttentionEntry[]
  attentionNow: number
  onJumpAttention: (entry: AttentionEntry) => void
  onDismissAttention: (id: string) => void
  missions: MissionSummary[]
  onOpenMission: (m: MissionSummary) => void
  onDismissMission: (id: string) => void
  onNewMission: () => void
  onFocusConductor: (sessionId: string) => void
  onNewSession: () => void
  onKillSession: () => void
  onKillSessionById: (id: string) => void
  onSelectSession: (id: string) => void
  // CAPP-82 — rename the work-session container (double-click the row name).
  onRenameSession: (id: string, name: string) => void
  // CAPP-80 — the transient "RESUMING" section: rows for startup-restored
  // terminals, focus (primary click) + stop (always-visible control) + dismiss.
  resumingRows: ResumingRow[]
  onFocusResuming: (key: string, sessionId: string, terminalId: string) => void
  onStopResuming: (key: string, sessionId: string, terminalId: string) => void
  onDismissResuming: (key: string) => void
  // WS-D/H — the workspace area (header + pill dropdown + active-workspace
  // controls, top of the sidebar). The sections above (NEEDS YOU / MISSIONS /
  // SESSIONS) are pre-filtered to the active workspace by App.tsx; `workspaceScoped`
  // tells us a SPECIFIC workspace is active so a filtered-empty section can show a
  // quiet hint instead of the bare "(none)" empty state.
  workspaces: WorkspaceSummary[]
  activeWorkspace: WorkspaceSummary | null
  workspaceScoped: boolean
  onSelectAllWorkspaces: () => void
  onSelectWorkspace: (id: string) => void
  onNewWorkspace: () => void
  onRenameWorkspace: (id: string, name: string) => void
  onDeleteWorkspace: (id: string) => void
  /** WS-H — set (or clear, with null) the active workspace's single folder (from
   *  the switcher's always-visible folder row). */
  onSetWorkspaceDir: (id: string, dir: string | null) => void | Promise<unknown>
  /** CAPP-75 — open the restore-conversation picker for the active workspace's
   *  folder (from the switcher's always-visible "Restore a conversation" button). */
  onRestoreConversation: () => void
  /** CAPP-94 — open the workspace-memory editor (companion panel) for the active
   *  workspace, or the untagged "All" bucket when none is selected. */
  onOpenWorkspaceMemory: () => void
  /** CAPP-98 / I1 — open the READ-ONLY Context Inspector (companion panel) for the active
   *  workspace, or the untagged "All" bucket when none is selected. */
  onOpenContextInspector: () => void
}

// Resolve a friendly label for an attention entry: the terminal's name when we
// can find it, else the owning session's name, else the raw id as a last resort.
function entryLabel(entry: AttentionEntry, sessions: SessionRow[]): string {
  for (const s of sessions) {
    if (entry.terminalId) {
      const t = s.terminals.find((x) => x.id === entry.terminalId)
      if (t) return t.name
    }
  }
  const owning = sessions.find((s) => s.id === entry.sessionId)
  return owning?.name ?? entry.terminalId ?? entry.sessionId ?? "Unknown"
}

export default function Sidebar({
  sessions, activeSessionId,
  attentionEntries, attentionNow, onJumpAttention, onDismissAttention,
  missions, onOpenMission, onDismissMission, onNewMission, onFocusConductor,
  onNewSession, onKillSession, onKillSessionById, onSelectSession, onRenameSession,
  resumingRows, onFocusResuming, onStopResuming, onDismissResuming,
  workspaces, activeWorkspace, workspaceScoped,
  onSelectAllWorkspaces, onSelectWorkspace, onNewWorkspace, onRenameWorkspace, onDeleteWorkspace,
  onSetWorkspaceDir, onRestoreConversation, onOpenWorkspaceMemory, onOpenContextInspector,
}: Props) {
  // CAPP-82 — inline rename of the session container row (mirrors TabBar's terminal
  // editor): double-click → controlled input, commit on Enter/blur, cancel on Escape.
  // Uses the shared commitRenameValue helper so the trim + blank-revert policy stays
  // identical to the tab editor.
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")

  const commitSessionRename = useCallback(() => {
    if (editingSessionId) {
      const prev = sessions.find((s) => s.id === editingSessionId)?.name ?? ""
      const { name, changed } = commitRenameValue(editValue, prev)
      if (changed) onRenameSession(editingSessionId, name)
    }
    setEditingSessionId(null)
  }, [editingSessionId, editValue, sessions, onRenameSession])

  return (
    <div className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-icon">◈</span>
        <span>ClaudeTUI</span>
      </div>

      {/* CAPP-80 — transient RESUMING section, pinned ABOVE NEEDS YOU. One row per
          startup-restored APP-MANAGED terminal so non-active restored agents are
          visible + actionable. Self-closing: a row clears on focus/dismiss; the
          whole section hides when empty. Each row has an ALWAYS-VISIBLE Stop control
          (no hover-reveal) wired to the app's existing close-terminal affordance. */}
      {resumingRows.length > 0 && (
        <div className="sidebar-section resuming-section">
          <div className="sidebar-header">RESUMING ({resumingRows.length})</div>
          {resumingRows.map((r) => (
            <div
              key={r.key}
              className={`resuming-item ${r.state}`}
              onClick={() => onFocusResuming(r.key, r.sessionId, r.terminalId)}
              title="Jump to this restoring terminal"
            >
              <div className="resuming-item-line1">
                <span className={`status-dot ${r.state === "ready" ? "idle" : "dead"}`} />
                <span className="resuming-name">{r.sessionName} · {r.terminalName}</span>
                <button
                  className="resuming-stop"
                  title="Stop this terminal"
                  aria-label={`Stop ${r.sessionName} ${r.terminalName}`}
                  onClick={(e) => { e.stopPropagation(); onStopResuming(r.key, r.sessionId, r.terminalId) }}
                >
                  Stop
                </button>
                <button
                  className="resuming-dismiss"
                  title="Dismiss"
                  aria-label="Dismiss resuming entry"
                  onClick={(e) => { e.stopPropagation(); onDismissResuming(r.key) }}
                >
                  ×
                </button>
              </div>
              <div className="resuming-item-line2">
                {r.state === "ready" ? "Ready" : "Resuming…"}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* WS-D/H — workspace area: section header + select-only pill dropdown +
          always-visible active-workspace controls (folder row / rename / delete),
          pinned below the brand and above NEEDS YOU. Selecting filters the three
          sections below. */}
      <WorkspaceSwitcher
        workspaces={workspaces}
        active={activeWorkspace}
        onSelectAll={onSelectAllWorkspaces}
        onSelectWorkspace={onSelectWorkspace}
        onNewWorkspace={onNewWorkspace}
        onRenameWorkspace={onRenameWorkspace}
        onDeleteWorkspace={onDeleteWorkspace}
        onSetWorkspaceDir={onSetWorkspaceDir}
        onRestoreConversation={onRestoreConversation}
        onOpenWorkspaceMemory={onOpenWorkspaceMemory}
        onOpenContextInspector={onOpenContextInspector}
      />

      {attentionEntries.length > 0 && (
        <div className="sidebar-section attention-section">
          <div className="sidebar-header">NEEDS YOU ({attentionEntries.length})</div>
          {attentionEntries.map((entry, i) => (
            <div
              key={entry.id}
              className={`attention-item tier-${entry.tier}`}
              style={{ "--i": i } as CSSProperties}
              onClick={() => onJumpAttention(entry)}
              title={entry.missionId ? "Open mission dashboard" : "Jump to this terminal"}
            >
              <div className="attention-item-line1">
                <span className="attention-dot" />
                <span className="attention-name">{entryLabel(entry, sessions)}</span>
                <button
                  className="attention-dismiss"
                  title="Dismiss"
                  aria-label="Dismiss attention entry"
                  onClick={(e) => { e.stopPropagation(); onDismissAttention(entry.id) }}
                >
                  ×
                </button>
              </div>
              <div className="attention-item-line2">
                {entry.reason} · {formatWaitTime(entry.since, attentionNow)}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="sidebar-section missions-section">
        <div className="sidebar-header missions-header">
          <span>{missions.length > 0 ? `MISSIONS (${missions.length})` : "MISSIONS"}</span>
          <button
            className="missions-new-btn"
            title="Start a new mission"
            aria-label="Start a new mission"
            onClick={(e) => { e.stopPropagation(); onNewMission() }}
          >
            +
          </button>
        </div>
        {missions.length === 0 && (
          workspaceScoped ? (
            <div className="sidebar-scoped-empty">Nothing in this workspace</div>
          ) : (
            <div className="mission-empty-row" onClick={onNewMission}>
              No missions — start one
            </div>
          )
        )}
        {missions.map((m, i) => {
            const { done, total, pct } = missionProgress(m.tasks)
            const workerCount = m.workers?.length ?? 0
            const dismissable = isMissionDismissable(m.status as any)
            return (
              <div
                key={m.id}
                className="mission-item"
                style={{ "--i": i } as CSSProperties}
                onClick={() => onOpenMission(m)}
                title="Open mission dashboard"
              >
                <div className="mission-item-line1">
                  <span className={`mission-status-chip chip-${m.status}`}>{m.status}</span>
                  <span className="mission-goal">{goalExcerpt(m.goal)}</span>
                  {m.conductorSessionId && (
                    <button
                      className="mission-conductor-btn"
                      title="Focus Conductor session"
                      aria-label="Focus Conductor session"
                      onClick={(e) => { e.stopPropagation(); onFocusConductor(m.conductorSessionId!) }}
                    >
                      ⟳
                    </button>
                  )}
                  {dismissable && (
                    <button
                      className="mission-dismiss-btn"
                      title="Dismiss mission"
                      aria-label="Dismiss mission"
                      onClick={(e) => { e.stopPropagation(); onDismissMission(m.id) }}
                    >
                      ×
                    </button>
                  )}
                </div>
                <div className="mission-item-line2">
                  <span className="mission-progress-text">
                    {total > 0 ? `${done}/${total} tasks` : "no tasks yet"}
                  </span>
                  {total > 0 && (
                    <span className="mission-progress-bar">
                      <span
                        className="mission-progress-fill"
                        style={{ width: `${pct}%` }}
                      />
                    </span>
                  )}
                  {workerCount > 0 && (
                    <span className="mission-worker-count">· {workerCount}w</span>
                  )}
                </div>
              </div>
            )
        })}
      </div>

      <div className="sidebar-section sessions-section">
        <div className="sidebar-header">SESSIONS</div>
        {sessions.length === 0 && (
          workspaceScoped ? (
            <div className="sidebar-scoped-empty">Nothing in this workspace</div>
          ) : (
            <div className="sidebar-empty">(no sessions)</div>
          )
        )}
        {sessions.map((s, i) => {
          const { dot, count, activity } = deriveSessionRow(s)
          const selected = activeSessionId === s.id
          return (
            <div
              key={s.id}
              className={`session-item ${selected ? "active" : ""}`}
              style={{ "--i": i } as CSSProperties}
              onClick={() => onSelectSession(s.id)}
            >
              <div className="session-item-line1">
                <span className={`status-dot ${dot}`} />
                {editingSessionId === s.id ? (
                  <input
                    className="session-rename-input"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitSessionRename()
                      if (e.key === "Escape") setEditingSessionId(null)
                    }}
                    onBlur={commitSessionRename}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className="session-name"
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      setEditingSessionId(s.id)
                      setEditValue(s.name)
                    }}
                  >
                    {s.name}
                  </span>
                )}
                <span className="session-count">{count} ▣</span>
                <button
                  className="session-kill-btn"
                  title="Kill session"
                  aria-label="Kill session"
                  onClick={(e) => { e.stopPropagation(); onKillSessionById(s.id) }}
                >
                  ×
                </button>
              </div>
              <div className="session-item-line2">{activity}</div>
            </div>
          )
        })}
      </div>

      <div className="sidebar-actions">
        <div className="sidebar-action" onClick={onNewSession}>+ New session</div>
        <div className="sidebar-action" onClick={onKillSession}>Kill session</div>
      </div>
    </div>
  )
}
