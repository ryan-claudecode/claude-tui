import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  useSyncExternalStore,
} from "react"
import { contextMeterFromBlocks, type ContextMeter } from "../lib/contextMeter"
import type { TranscriptStore } from "../lib/transcriptStore"
import {
  reduceTranscript,
  emptyTranscript,
  settleRunningTools,
  panelForBlock,
  expandLabelForBlock,
  assistantExpandUseful,
  USER_BLOCK_KIND,
  type TranscriptBlock,
  type TranscriptState,
  type ToolBlock,
  type ResultBlock,
  type ResultCost,
  type ModelErrorBlock,
  type NeedsAuthBlock,
  type AssistantTextBlock,
} from "../lib/agentTranscript"
import { nextScrollTop, scrollFollowBehavior, shouldStick } from "../lib/scrollStick"
import { initialHiddenCount, revealEarlier, visibleBlocks, LOAD_EARLIER_PAGE } from "../lib/transcriptWindow"
import {
  groupToolRuns,
  summarizeToolGroup,
  activeToolLabel,
  type ToolGroupItem,
} from "../lib/toolGroups"
import { useSmoothReveal } from "../hooks/useSmoothReveal"
import { prefersReducedMotion } from "../lib/reducedMotion"
import AgentModelPicker from "./AgentModelPicker"
import MarkdownView from "./MarkdownView"
import { BlockExpandButton } from "./BlockExpandButton"

/**
 * BO-12 — an in-memory cache of folded transcript state, keyed by the STABLE
 * Claude Code conversation id (not terminal id, which changes on respawn). Lives
 * above AgentView (App.tsx) and is shared across panes, so a respawn or a rapid
 * tab-switch re-seeds the prior turns INSTANTLY from memory (no transcript reparse)
 * — and survives the terminal-id churn that remounts this component.
 */
export type TranscriptCache = Map<string, TranscriptState>

/**
 * WS1 — pure decision for the branded "working" row. The row exists for ONE job:
 * cover the DEAD-AIR gap between submit and the turn's first sign of life. Returns a
 * single calm "Thinking" state while that gap is open, or `null` once any content
 * exists (or we're not busy).
 *
 * Rule: show IFF `busy` AND we're still in the pre-content gap — i.e. there are no
 * blocks yet, or the trailing block is the user's own just-sent message. The instant
 * ANY content block lands as trailing (assistant / tool / thinking / result / error /
 * needs_auth / model_error), the streaming content + tool cards ARE the activity
 * signal, so the row suppresses itself. Because content blocks always APPEND after the
 * user block, the trailing block is the user message ONLY in that initial gap — so the
 * row shows exactly once per turn and can never flicker as the turn alternates
 * prose↔tool. (Pre-content, the word is always a calm "Thinking" — no cycling.)
 *
 * Kept pure (no React) so it renders identically in SSR and is unit-testable.
 */
export function workingRowState(
  blocks: readonly TranscriptBlock[],
  busy: boolean,
): { status: "Thinking" } | null {
  if (!busy) return null
  const last = blocks[blocks.length - 1]
  // Dead air only: nothing back yet (fresh turn / cold start) OR the trailing block
  // is still the user's own message. Any content block as trailing → the transcript
  // itself signals life → suppress.
  if (!last || last.kind === USER_BLOCK_KIND) return { status: "Thinking" }
  return null
}

/**
 * WS5 — pure decision for the STREAMING CARET. Mirrors {@link workingRowState}'s
 * shape (trailing-block + busy) so the show/hide is unit-testable and renders
 * identically in SSR. Returns the id of the assistant block that should carry a
 * thin breathing caret at the end of its text — or `null` when no caret should
 * show. The caret gives a live "typing" feel WHILE the turn streams, and vanishes
 * the instant the block settles or the turn ends.
 *
 * Rule: caret shows IFF `busy` AND the TRAILING block is an `assistant` block —
 * i.e. the agent is actively appending prose right now. Because `assistant_delta`
 * coalesces into the trailing assistant block, the trailing block is that block
 * exactly while prose is streaming; the moment a tool / result / error block
 * appends after it (or `busy` flips false at turn end), the trailing block is no
 * longer that assistant block, so the caret disappears with no flicker.
 */
export function streamingCaretId(
  blocks: readonly TranscriptBlock[],
  busy: boolean,
): string | null {
  if (!busy) return null
  const last = blocks[blocks.length - 1]
  if (last && last.kind === "assistant") return last.id
  return null
}

interface Props {
  /** The live terminal (PTY/headless) id this view renders. */
  terminalId: string
  active: boolean
  /**
   * WS1 — the agent is generating a turn (or parked on a permission prompt). Drives
   * the branded "working" row pinned at the bottom of the transcript. `busy` flips
   * true synchronously on submit (the `terminal:state` "active" event), so the row
   * paints within a frame of Enter — covering the multi-second `claude -p` cold
   * start where init + the first tokens only arrive AFTER the first stdin message.
   * The row is suppressed the moment the turn's first content block lands (so it
   * covers only the dead-air gap, never double-signals beside streaming content).
   */
  busy?: boolean
  /** BO-6 — the work-session + current model, so the model-unavailable banner can
   *  render an inline picker that respawns this terminal on a different model. */
  sessionId?: string | null
  model?: string
  /** CAPP-113 — the effective, config-extensible model option list, threaded to the
   *  model-unavailable banner's inline picker so it derives from the SAME list as the
   *  composer picker (config models.extra/models.hidden honored on the recovery path
   *  too — the exact surface the never-stale feature targets). */
  modelOptions?: string[]
  /** CAPP-113 — the RESOLVED full model id (init echo) for the banner picker's tooltip. */
  resolvedModel?: string
  /**
   * BO-12 — the STABLE Claude Code conversation id this terminal is bound to. When
   * present, the view rehydrates its prior turns on mount (cache-first, then the
   * on-disk transcript) so a Stop/model-switch/handoff respawn or an app-restart
   * restore KEEPS showing the conversation instead of blanking.
   */
  ccConversationId?: string
  /** BO-12 — the shared, cross-pane transcript cache (see {@link TranscriptCache}). */
  transcriptCache?: TranscriptCache
  /**
   * THE TRUST FIX — the always-on renderer transcript store (one instance in App.tsx,
   * subscribed once at mount). AgentView reads THIS terminal's folded state from here
   * via useSyncExternalStore instead of folding into component-local state, so the
   * transcript keeps accumulating while the view is unmounted (the user switched to
   * another session) and is intact on return. The App-level subscription is the sole
   * fold site; this view only READS + SEEDS history into it.
   */
  transcriptStore: TranscriptStore
  /** Re-point the active selection at the respawned terminal after a model switch. */
  onSwitched?: (terminalId: string) => void
  /**
   * CAPP-127 — lift the derived context meter up to AgentSurface, which mounts the
   * ContextMeterBar between this view and the composer. Derived HERE (not in the
   * surface) because the folded `state.blocks` — the same blocks the transcript
   * renders, and which rehydrate on restore — live in this component. Null until a
   * usage-bearing `result` lands (the bar stays hidden).
   */
  onContextMeter?: (meter: ContextMeter | null) => void
}

/**
 * BO-2 — the custom React surface that renders a headless Claude session's
 * structured stream IN PLACE of xterm. Deliberately imports NO xterm: it
 * subscribes to the BO-1 stream channel, folds events through the pure reducer
 * (`src/lib/agentTranscript.ts`), and renders the resulting blocks. The detail
 * surface reuses the EXISTING companion panels via `window.api.showPanel`.
 *
 * Mounted by App.tsx when the structured rendering engine is configured
 * (config.rendering.engine = "structured"; see src/lib/renderingEngine.ts). BO-4a
 * flipped this from the BO-2 dev flag to the real config-driven engine switch.
 */
export default function AgentView({
  terminalId,
  active,
  busy = false,
  sessionId,
  model,
  modelOptions,
  resolvedModel,
  ccConversationId,
  transcriptCache,
  transcriptStore,
  onSwitched,
  onContextMeter,
}: Props) {
  // THE TRUST FIX — read THIS terminal's folded transcript from the always-on store
  // via useSyncExternalStore. The fold happens ONCE in App.tsx (subscribed at mount),
  // so events keep accumulating while this view is unmounted (the user switched away)
  // and the full transcript is intact on return. `state` is the store's snapshot: a
  // stable reference between changes, and a shared empty for a not-yet-seen terminal
  // (so the Object.is snapshot compare never loops). Live folding (coalescing, tool
  // correlation, resume-append) is byte-identical — it's the same reduceTranscript,
  // just relocated into the store.
  const subscribe = useCallback(
    (cb: () => void) => transcriptStore.subscribe(terminalId, cb),
    [transcriptStore, terminalId],
  )
  const getSnapshot = useCallback(
    () => transcriptStore.get(terminalId),
    [transcriptStore, terminalId],
  )
  const state = useSyncExternalStore(subscribe, getSnapshot)

  // True while the on-disk transcript read is in flight (cache cold + a convo id
  // present → app-restart restore). Seeds the "Restoring conversation…" rest state
  // instead of flashing "Ready when you are" (which reads as data loss). If the store
  // already holds this terminal's blocks (live-accumulated while unmounted, or seeded
  // on a prior mount) there is nothing to restore.
  const [seeding, setSeeding] = useState<boolean>(() => {
    if (!ccConversationId) return false
    if (transcriptStore.get(terminalId).blocks.length > 0) return false
    const cached = transcriptCache?.get(ccConversationId)
    return !(cached && cached.blocks.length > 0)
  })
  // CAPP-103 — render-windowing: the number of OLDEST blocks NOT rendered. A long restored
  // conversation renders only its tail (the rest froze the main thread parsing markdown).
  // Seeded from the cache hit here so a huge cached transcript is windowed from the first
  // paint; the disk-restore path seeds it in the read's .then (below). Live streaming (incl.
  // content accumulated while the view was unmounted) appends at the tail and never changes
  // it — a conversation the user watched grow is never auto-hidden. "Load earlier" reveals it.
  const [hiddenCount, setHiddenCount] = useState<number>(() => {
    if (ccConversationId) {
      const cached = transcriptCache?.get(ccConversationId)
      if (cached && cached.blocks.length > 0) return initialHiddenCount(cached.blocks.length)
    }
    return 0
  })
  // CAPP-103 — true ONLY for a genuine cold restore (a convo id bound at mount with a cold
  // cache → the disk read below is restoring history). `seeding`'s initial value captures
  // exactly that. We gate the disk-path window-seed on it so a FRESH live session — whose
  // convo id arrives late, re-running the seed effect — is NEVER auto-windowed (the user
  // watched it grow; hiding its head would be jarring). Mirrors the `seeding` initializer.
  const coldRestoreRef = useRef(seeding)
  const seededRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Inner content wrapper whose box GROWS with the transcript — the ResizeObserver
  // observes this (the scroll container itself is inset:0 and never resizes).
  const contentRef = useRef<HTMLDivElement>(null)

  // BO-12 (cache-hit seed) — a respawn (model switch / handoff / interrupt) remounts
  // this view under a NEW terminal id but the SAME convo id; seed the store from the
  // convo-keyed cache SYNCHRONOUSLY (layout effect, pre-paint) so the prior conversation
  // paints with no blank flash. The dangling-tool settle covers a Stop-aborted tool the
  // live cache may have left "running". `seedHistory` is idempotent (a per-terminal
  // seeded flag) and merges BENEATH any live blocks, so a remount never double-seeds and
  // never discards live content.
  useLayoutEffect(() => {
    if (!ccConversationId) return
    if (transcriptStore.hasSeeded(terminalId)) return
    const cached = transcriptCache?.get(ccConversationId)
    if (cached && cached.blocks.length > 0) {
      transcriptStore.seedHistory(terminalId, settleRunningTools(cached))
    }
  }, [ccConversationId, terminalId, transcriptStore, transcriptCache])

  // BO-12 (disk seed) — rehydrate from the ON-DISK transcript when the cache is cold (an
  // app restart starts with an empty cache). Runs once. `seedHistory` merges the restored
  // history BENEATH whatever live blocks already streamed into the store — the line-244 fix:
  // no live event can discard the seed, and no seed can discard live blocks.
  useEffect(() => {
    if (seededRef.current) return
    if (!ccConversationId) return
    if (transcriptStore.hasSeeded(terminalId)) return // cache seed / a prior mount already did it
    seededRef.current = true
    const cached = transcriptCache?.get(ccConversationId)
    if (cached && cached.blocks.length > 0) return // handled by the cache-seed layout effect
    let cancelled = false
    window.api
      .getTranscriptEvents(ccConversationId)
      .then((events) => {
        if (cancelled) return
        setSeeding(false)
        if (!events || events.length === 0) return
        const seeded = settleRunningTools(events.reduce(reduceTranscript, emptyTranscript()))
        transcriptStore.seedHistory(terminalId, seeded)
        // CAPP-103 — window a big RESTORED transcript to its tail. ONLY for a genuine cold
        // restore — never a fresh live session whose convo id arrived late (coldRestoreRef).
        // Preserve any value the user already set rather than clobbering it.
        if (coldRestoreRef.current) {
          setHiddenCount((h) => (h > 0 ? h : initialHiddenCount(seeded.blocks.length)))
        }
      })
      .catch(() => {
        if (!cancelled) setSeeding(false)
      })
    return () => {
      cancelled = true
    }
  }, [ccConversationId, terminalId, transcriptCache, transcriptStore])

  // BO-12 — keep the shared cache current with live folding, so a later respawn
  // (which remounts this component under a new terminal id but the SAME convo id)
  // re-seeds from memory. Keyed by the stable convo id. Reads the store snapshot.
  useEffect(() => {
    if (ccConversationId && state.blocks.length > 0) {
      transcriptCache?.set(ccConversationId, state)
    }
  }, [state, ccConversationId, transcriptCache])

  // Sticky-to-bottom: follow new content only when the user is pinned to the
  // bottom; never yank the viewport if they scrolled up to read history.
  const stickRef = useRef(true)
  // WS5 — the FIRST settle after mount (the BO-12 rehydrate/restore seed, or the
  // first turn) snaps instantly so a long restored transcript doesn't animate a
  // top→bottom slide; every subsequent follow during streaming is SMOOTH so the
  // viewport glides with the arriving tokens instead of hard-jumping. Honors
  // prefers-reduced-motion via `matchMedia` (the global CSS reset only governs
  // CSS-driven scroll; an explicit `scrollTo({behavior:'smooth'})` must opt out here).
  const didFirstScrollRef = useRef(false)

  // The current prefers-reduced-motion answer, read fresh at the call site (cheap;
  // the value can change at runtime if the user toggles the OS setting mid-session).
  const reduceMotion = useCallback(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  )

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (!stickRef.current) return
    const target = nextScrollTop(
      { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
      el.scrollHeight,
      el.clientHeight,
    )
    // We just appended, so `before` reflects pre-append metrics only loosely;
    // when pinned we always snap to the bottom, which is the intended behavior.
    const top = target ?? el.scrollHeight
    // WS5 fix — decide instant-vs-smooth via the pure helper, passing the block
    // count so the EMPTY initial mount (blocks.length === 0, before the async BO-12
    // disk seed commits) does NOT consume the one-shot. Only the first NON-EMPTY
    // settle counts as "the first scroll" and snaps `behavior:"auto"` — so a
    // cache-cold app-restart restore lands instantly instead of sliding top→bottom,
    // and only post-restore streaming animates smooth. `scrollTo` retargets any
    // in-flight animation (it doesn't queue) so rapid deltas glide without piling up.
    const { behavior, markFirstDone } = scrollFollowBehavior(
      didFirstScrollRef.current,
      state.blocks.length,
      reduceMotion(),
    )
    if (markFirstDone) didFirstScrollRef.current = true
    el.scrollTo({ top, behavior })
  }, [state.blocks, reduceMotion])

  // UI tweak (stick-to-bottom on SEND) — when the turn starts (busy flips true) the
  // user's just-sent message + the "thinking" WorkingRow + the turn separator (HR)
  // append at the bottom; without an explicit follow they land below the fold. Force a
  // snap to the bottom on the busy rising edge so the new turn is in view. Re-arm
  // stick too (the user pressed Send → they want to watch this turn). Instant snap:
  // there's no streaming yet to glide with, and it matches the "jump to the new turn"
  // intent. Guard the empty initial mount (busy may be false there anyway).
  useEffect(() => {
    if (!busy) return
    const el = scrollRef.current
    if (!el) return
    stickRef.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: "auto" })
  }, [busy])

  // UI tweak (FOLLOW STREAMING GROWTH) — useSmoothReveal grows the assistant block's
  // height frame-by-frame during a turn, but the block-count effect above only fires
  // when a NEW block appends, so the revealing text + HR would scroll out of view.
  // Observe the INNER CONTENT wrapper (whose box grows; the scroll container is inset:0
  // and never resizes) and, while stuck-to-bottom, follow the growth to the bottom.
  // A genuine user scroll-up de-arms stick (onScroll), so this never fights them; it
  // re-arms when they return to the bottom.
  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content) return
    if (typeof ResizeObserver !== "function") return
    const ro = new ResizeObserver(() => {
      if (!stickRef.current) return
      // Continuous follow uses INSTANT ("auto"), never "smooth": the observer fires on
      // every reveal frame (~60fps), and a smooth scrollTo retargeted each frame never
      // settles and visibly rubber-bands behind the revealing edge. The motion comes
      // from the text reveal itself; the scroll just keeps the bottom pinned.
      el.scrollTo({ top: el.scrollHeight, behavior: "auto" })
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [])

  // Track stick state from scroll position. The smooth follow's own intermediate
  // scroll events may briefly read as "not at bottom" and transiently de-stick, but
  // this is self-correcting: the animation's final frame lands at the bottom (re-
  // sticking), and every new block re-evaluates follow — so at worst one delta's
  // follow is skipped, never a permanent freeze. A genuine user scroll-up is ALWAYS
  // honored (it de-sticks and we never yank them back); a scroll back DOWN within the
  // threshold RE-ARMS (shouldStick is symmetric — same threshold both edges).
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = shouldStick({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    })
  }, [])

  // CAPP-103 — "Load earlier": reveal a page of older blocks (or all). Revealing PREPENDS
  // content above the viewport, which would otherwise jump the page down; capture the
  // distance from the current scrollTop to the content bottom so the layout effect below can
  // restore it — the user's reading position stays put. De-arm stick (they're reading
  // history, not following the tail) so the ResizeObserver follow never fights the anchor.
  const pendingAnchorRef = useRef<number | null>(null)
  const captureAnchor = useCallback(() => {
    const el = scrollRef.current
    pendingAnchorRef.current = el ? el.scrollHeight - el.scrollTop : null
    stickRef.current = false
  }, [])
  const loadEarlier = useCallback(() => {
    captureAnchor()
    setHiddenCount((h) => revealEarlier(h, LOAD_EARLIER_PAGE))
  }, [captureAnchor])
  const loadAll = useCallback(() => {
    captureAnchor()
    setHiddenCount(0)
  }, [captureAnchor])

  // Restore the viewport's distance-from-bottom after older blocks prepend, so revealing
  // history doesn't yank the page. Runs synchronously post-layout (before paint) → no flash.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pendingAnchorRef.current != null) {
      el.scrollTop = Math.max(0, el.scrollHeight - pendingAnchorRef.current)
      pendingAnchorRef.current = null
    }
  }, [hiddenCount])

  const expand = useCallback((block: TranscriptBlock) => {
    const req = panelForBlock(block)
    if (!req) return
    try {
      window.api.showPanel(req.type, req.props)
    } catch {
      // Panels are best-effort; a missing companion window must not crash the view.
    }
  }, [])

  // WS1 — the branded "working" row, pinned to the bottom of the transcript. Derived
  // purely from `busy` + the trailing block, so it paints in the same render `busy`
  // flips true (a frame after Enter) and self-suppresses the instant the turn's first
  // content block lands (assistant / tool / thinking / result / …).
  const working = workingRowState(state.blocks, busy)

  // CAPP-103 — only the tail of the transcript is rendered (older blocks hidden behind
  // "Load earlier"). `working`/`caretId` derive from the FULL `state.blocks` (the streaming
  // target is the trailing block, always in the visible tail), so streaming is unaffected.
  const visible = visibleBlocks(state.blocks, hiddenCount)

  // Collapse consecutive tool-call BURSTS in the visible tail into one expandable group
  // (a long autonomous turn is otherwise a wall of read/grep/edit rows). Display-only +
  // pure — `state.blocks`, the caret target, and the context meter are all derived from
  // the ungrouped blocks, so streaming/tool-correlation are unaffected. Memoized so the
  // O(n) fold only reruns when the visible slice changes.
  const items = useMemo(() => groupToolRuns(visible), [visible])

  // WS5 — id of the assistant block (if any) that should carry the live streaming
  // caret. Derived from the same trailing-block + busy signals as the working row,
  // so it appears only while prose is actively streaming and clears the instant the
  // block settles / the turn ends.
  const caretId = streamingCaretId(state.blocks, busy)

  // CAPP-127 — derive the context meter from the FULL folded blocks (not the windowed
  // `visible` tail) + the terminal's model. The alias (`opus[1m]`) and the init-resolved
  // id are joined so the `[1m]` 1M-cap marker is detected from whichever carries it.
  const capModel = useMemo(
    () => [model, resolvedModel].filter(Boolean).join(" "),
    [model, resolvedModel],
  )
  const contextMeter = useMemo(
    () => contextMeterFromBlocks(state.blocks, capModel),
    [state.blocks, capModel],
  )
  // Lift only when the meter's VALUES change (a new result landed / the cap changed),
  // not on every blocks-identity change — state.blocks is replaced per stream delta,
  // and an unconditional lift would setState in AgentSurface (re-rendering the composer)
  // on every streamed token.
  const liftedMeterRef = useRef<ContextMeter | null>(null)
  useEffect(() => {
    const prev = liftedMeterRef.current
    if (
      prev === contextMeter ||
      (prev != null &&
        contextMeter != null &&
        prev.total === contextMeter.total &&
        prev.results === contextMeter.results &&
        prev.cap === contextMeter.cap)
    ) {
      return
    }
    liftedMeterRef.current = contextMeter
    onContextMeter?.(contextMeter)
  }, [contextMeter, onContextMeter])

  return (
    <div
      className={`agent-view ${active ? "active" : "hidden"}`}
      ref={scrollRef}
      onScroll={onScroll}
    >
      <div className="agent-view-content" ref={contentRef}>
      {state.blocks.length === 0 && !working ? (
        seeding ? (
          // BO-12 — a convo id is bound but the on-disk transcript read is still in
          // flight (app-restart restore, cache cold). Show a restoring rest state,
          // never the bare "Ready" — the conversation is being rehydrated.
          <div className="agent-view-empty">
            <span className="agent-view-empty-glyph" aria-hidden="true">↻</span>
            <span className="agent-view-empty-title">Restoring conversation…</span>
          </div>
        ) : ccConversationId ? (
          // BO-12 — resumed conversation but no transcript could be read (missing /
          // empty). It is NOT data loss (the agent still has full context via
          // --resume), so say so instead of "Ready when you are".
          <div className="agent-view-empty">
            <span className="agent-view-empty-glyph" aria-hidden="true">↻</span>
            <span className="agent-view-empty-title">Conversation resumed</span>
            <span className="agent-view-empty-hint">
              History appears on your next message.
            </span>
          </div>
        ) : (
          // BO-4b — a structured session emits NOTHING until the first user message
          // (`claude -p` waits on stdin), so this empty state is the resting state a
          // freshly opened session sits in. It must read as "ready, type to start",
          // NOT an indefinite "Waiting for the agent…" spinner (which made the
          // working composer look like a stuck/blank screen).
          <div className="agent-view-empty">
            <span className="agent-view-empty-glyph" aria-hidden="true">›_</span>
            <span className="agent-view-empty-title">Ready when you are</span>
            <span className="agent-view-empty-hint">Type a message below to start the agent.</span>
          </div>
        )
      ) : (
        <>
          {hiddenCount > 0 && (
            // CAPP-103 — older history is hidden for performance; reveal it on demand.
            // Statically visible (no hover-reveal, per the project UI rule).
            <div className="agent-load-earlier">
              <button type="button" className="agent-load-earlier-btn" onClick={loadEarlier}>
                <span aria-hidden="true">▲</span> Load earlier
                <span className="agent-load-earlier-count">
                  {hiddenCount} hidden
                </span>
              </button>
              <button type="button" className="agent-load-all-btn" onClick={loadAll}>
                Load all
              </button>
            </div>
          )}
          {items.map((item) =>
            item.kind === "tool-group" ? (
              <ToolGroupView key={item.id} group={item} onExpand={expand} />
            ) : (
              <BlockView
                key={item.block.id}
                block={item.block}
                onExpand={() => expand(item.block)}
                terminalId={terminalId}
                sessionId={sessionId ?? null}
                model={model}
                modelOptions={modelOptions}
                resolvedModel={resolvedModel}
                onSwitched={onSwitched}
                streaming={item.block.id === caretId}
              />
            ),
          )}
          {working && <WorkingRow status={working.status} />}
        </>
      )}
      </div>
    </div>
  )
}

/**
 * WS1 — OURS, not a Claude Code spinner clone: a single warm breathing dot in the
 * accent with a soft accent-glow halo, a calm "Thinking" label, and a thin shimmer
 * along a 1px baseline. It only ever shows during the pre-content dead-air gap (see
 * {@link workingRowState}), so the label is a single steady word — no cycling. The
 * breathe + shimmer + arrival fade are all CSS (`.agent-working` in App.css); this
 * component is pure presentation.
 */
function WorkingRow({ status }: { status: "Thinking" }) {
  return (
    <div className="agent-working" role="status" aria-live="polite">
      <span className="agent-working-dot" aria-hidden="true" />
      <span className="agent-working-label">{status}</span>
      <span className="agent-working-baseline" aria-hidden="true" />
    </div>
  )
}

/**
 * CAPP-77 — pure derivation of the AssistantBlock className, extracted so the
 * class-stability invariant is unit-testable WITHOUT a DOM (the test env is
 * node-only). Two independent flags:
 *  - `agent-streaming` — set IFF this is the trailing assistant block of an actively
 *    streaming turn (`streaming`). Drives the WS5 typing caret.
 *  - `agent-revealing` — set IFF the PER-LINE rise should be live, which is for the
 *    WHOLE active streaming turn (`reveal`, i.e. `streaming && motion-allowed`), NOT
 *    the transient per-catch-up "draining" state.
 *
 * THE CAPP-77 BUG THIS GUARDS (the flicker): the original wiring set `agent-revealing`
 * off `draining = active && shown < text.length`. The adaptive drain (CAPP-77) paces
 * FASTER than prose streams, so BETWEEN tokens the buffer catches up (`shown ===
 * text.length`) → `draining` flips false → the class is REMOVED → the next token
 * re-adds it. Toggling a class that carries a CSS `animation` RESTARTS `agent-line-rise`
 * from keyframe 0, so the live paragraph snapped to opacity 0 / translateY 5px and slid
 * back on ~every token = a pronounced jitter. Driving the class off the stable
 * whole-turn `reveal` signal (held continuously while streaming, dropped only at
 * turn-end) keeps the parent class constant; react-markdown then keeps the SAME DOM
 * node for the growing trailing block, so `agent-line-rise` on `:last-child` plays
 * exactly ONCE per block (on its mount as the trailing block) with no restart.
 */
export function assistantBlockClass(streaming: boolean, reveal: boolean): string {
  return (
    `agent-block agent-assistant` +
    (streaming ? " agent-streaming" : "") +
    (reveal ? " agent-revealing" : "")
  )
}

/**
 * CAPP-74 — the assistant prose block, fronted by the streaming SMOOTHING BUFFER.
 *
 * Lives in its own component so it can call {@link useSmoothReveal} unconditionally
 * (hooks can't run inside BlockView's `switch`). The hook is `active` ONLY when this
 * is the LIVE current-turn trailing assistant block (`streaming`) AND the user
 * hasn't asked for reduced motion — in which case it returns a growing prefix slice
 * drained at a constant rate (the typewriter), reshaping bursty deltas into steady
 * output. The instant `streaming` drops (turn end, the block settling behind a tool/
 * result, a terminal switch / re-mount) or under reduced-motion, it returns the FULL
 * text immediately — so settled, historical, and BO-12-rehydrated blocks render
 * complete INSTANTLY, never replayed.
 *
 * The WS5 streaming caret (a CSS `::after` driven by `.agent-streaming`) sits at the
 * end of the rendered (revealed) text, so it tracks the typewriter's leading edge.
 * CAPP-77 — `agent-revealing` drives a PER-LINE fade + translate-up rise (the
 * "lines rise into place" feel): the CSS targets only the trailing (`:last-child`)
 * markdown block, so each freshly-revealed block animates ONCE as it appears and
 * already-settled blocks (no longer `:last-child`) stay put. The class is held for the
 * WHOLE active streaming turn (`active`) — NOT toggled on the transient per-catch-up
 * `draining` state — so the parent class never flips off→on between tokens and the
 * rise never restarts mid-block (see {@link assistantBlockClass}). It drops the moment
 * the turn ends (active→false), so the final block settles; reduced-motion (where the
 * buffer is bypassed and `active` is false) gets no rise.
 */
function AssistantBlock({
  block,
  onExpand,
  streaming,
}: {
  block: AssistantTextBlock
  onExpand: () => void
  streaming: boolean
}) {
  // Buffer ONLY the live streaming block, and only when motion is allowed. Anything
  // else (settled block, historical/rehydrated transcript, reduced-motion) → the
  // hook short-circuits to the full text on the very first render. `active` is the
  // STABLE whole-turn signal: it does not depend on the catch-up/`shown` state, so it
  // also drives `agent-revealing` continuously (no per-token toggle → no rise restart).
  const active = streaming && !prefersReducedMotion()
  const shown = useSmoothReveal(block.text, active)
  // CAPP-111 (M2) — the expand button renders ONLY when the block is SETTLED
  // (`!streaming`), gated on the SAME stable whole-turn signal the WS5 caret +
  // CAPP-77 reveal use (`streaming`). It must never paint over reveal-animated
  // text or the typing caret (the stream-reveal-flicker-trap), and it sits OUTSIDE
  // the `.markdown-body` flow (absolute, top-right) so it never disturbs layout.
  // CAPP-119 — additionally gated on USEFULNESS: a short paragraph gains nothing
  // from the roomier panel, so it renders no ⤢ (only long / code / table prose does).
  const ex = expandLabelForBlock(block)
  const showExpand = !streaming && ex != null && assistantExpandUseful(block.text)
  return (
    <div className={assistantBlockClass(streaming, active)}>
      {showExpand && ex && (
        <BlockExpandButton label={ex.label} compact={ex.compact} onExpand={onExpand} />
      )}
      {/* WS5 — the streaming caret is a CSS `::after` on the LAST block of the
          markdown body (driven by the `.agent-streaming` class), NOT a sibling span.
          A sibling rendered AFTER the block-level `.markdown-body` wrapped onto its
          own line at the left margin below the prose; the pseudo-element flows inline
          at the END of the final text line, reading as a real typing caret. It self-
          clears the instant the block stops being the trailing streaming block (the
          class drops). CAPP-74 — `source` is now the smoothing buffer's REVEALED
          slice while streaming, so the caret sits at the typewriter's leading edge. */}
      <MarkdownView source={shown} revealing={active} />
    </div>
  )
}

export function BlockView({
  block,
  onExpand,
  terminalId,
  sessionId,
  model,
  modelOptions,
  resolvedModel,
  onSwitched,
  streaming = false,
}: {
  block: TranscriptBlock
  onExpand: () => void
  terminalId: string
  sessionId: string | null
  model?: string
  /** CAPP-113 — the effective option list + resolved-model echo for the
   *  model-unavailable banner's inline picker (same list as the composer's). */
  modelOptions?: string[]
  resolvedModel?: string
  onSwitched?: (terminalId: string) => void
  /** WS5 — this is the trailing assistant block of an actively streaming turn:
   *  render a subtle live caret at the end of its text. */
  streaming?: boolean
}) {
  switch (block.kind) {
    case "user":
      return (
        <div className="agent-block agent-user">
          <div className="agent-user-bubble">{block.text}</div>
        </div>
      )
    case "assistant":
      return <AssistantBlock block={block} onExpand={onExpand} streaming={streaming} />
    case "thinking":
      return (
        <details className="agent-block agent-thinking">
          <summary>Thinking</summary>
          <div className="agent-thinking-body">{block.text || "…"}</div>
        </details>
      )
    case "tool":
      return <ToolView tool={block} onExpand={onExpand} />
    case "injected": {
      // CAPP-118 — harness-injected content (task-notification / system-reminder /
      // local-command) as a MUTED, compact one-line system chip (NOT a user bubble).
      // The statically-visible compact ⤢ opens the raw wrapper text VERBATIM in the
      // read-only code panel — collapsed but never hidden. `ex` is non-null for
      // `injected` but computed through the helper so it stays the source of truth.
      const ex = expandLabelForBlock(block)
      return (
        <div className="agent-block agent-injected">
          <span className="agent-injected-glyph" aria-hidden="true">⚙</span>
          <span className="agent-injected-label">{block.label}</span>
          {ex && <BlockExpandButton label={ex.label} compact={ex.compact} onExpand={onExpand} />}
        </div>
      )
    }
    case "error":
      return (
        <div className="agent-block agent-error" role="alert">
          <span className="agent-error-icon">!</span>
          <span>{block.message}</span>
        </div>
      )
    case "model_error":
      return (
        <ModelErrorView
          block={block}
          terminalId={terminalId}
          sessionId={sessionId}
          model={model}
          modelOptions={modelOptions}
          resolvedModel={resolvedModel}
          onSwitched={onSwitched}
        />
      )
    case "needs_auth":
      return <NeedsAuthView block={block} sessionId={sessionId} />
    case "result":
      return <ResultView result={block} onExpand={onExpand} />
    case "raw": {
      // CAPP-111 — explicit top-right expand button (icon-only/compact), replacing
      // the old whole-block click-to-open. `ex` is non-null for `raw` (it has a
      // code-panel view), but compute it through the helper so it stays the source
      // of truth.
      const ex = expandLabelForBlock(block)
      return (
        <div className="agent-block agent-raw">
          <span className="agent-raw-tag">raw event</span>
          <code>{previewJson(block.raw)}</code>
          {ex && <BlockExpandButton label={ex.label} compact={ex.compact} onExpand={onExpand} />}
        </div>
      )
    }
  }
}

/** A one-line, compact summary of a tool call's input for the inline widget. */
function toolSummary(input: unknown): string {
  if (input == null) return ""
  if (typeof input !== "object") return String(input)
  const o = input as Record<string, unknown>
  const pick =
    pickStr(o.command) ??
    pickStr(o.file_path) ??
    pickStr(o.path) ??
    pickStr(o.query) ??
    pickStr(o.pattern) ??
    pickStr(o.url)
  if (pick) return pick
  try {
    return JSON.stringify(o)
  } catch {
    return ""
  }
}

function pickStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

/**
 * A collapsed run of consecutive tool calls (see {@link groupToolRuns}). Native
 * `<details>` — the whole header is a statically-visible clickable/keyboard-toggleable
 * control (no hover-reveal, per the project UI rule), collapsed by default. The header
 * carries the aggregate status dot, a live "Running X…" label while the burst is in
 * flight (else "N tool calls"), the per-tool-name breakdown, and a red "N failed" count
 * so a failure inside the burst is never hidden. Expanding reveals every individual tool
 * row exactly as it renders inline (each keeps its own ⤢ detail button); interleaved raw
 * events render in the body too, so nothing is lost.
 *
 * Uncontrolled on purpose: the `<details>` keeps its own open state in the DOM, keyed by
 * the group's stable id (the first tool's block id). As more tools stream into a live
 * burst the id is invariant, so a group the user expanded stays expanded while it grows.
 */
export function ToolGroupView({ group, onExpand }: { group: ToolGroupItem; onExpand: (block: TranscriptBlock) => void }) {
  const active = activeToolLabel(group)
  const breakdown = summarizeToolGroup(group)
  const title = active ? `Running ${active}…` : `${group.count} tool calls`
  return (
    <details className={`agent-block agent-tool-group agent-tool-group-${group.status}`}>
      <summary className="agent-tool-group-summary">
        <span className="agent-tool-group-chevron" aria-hidden="true">▸</span>
        <span
          className={`agent-tool-status agent-tool-status-${group.status}`}
          aria-hidden="true"
        />
        <span className="agent-tool-group-title">{title}</span>
        {breakdown && <span className="agent-tool-group-breakdown">{breakdown}</span>}
        {group.errored > 0 && (
          <span className="agent-tool-group-failed">{group.errored} failed</span>
        )}
      </summary>
      <div className="agent-tool-group-body">
        {group.items.map((block) =>
          block.kind === "tool" ? (
            <ToolView key={block.id} tool={block} onExpand={() => onExpand(block)} />
          ) : (
            // A transparent raw event absorbed into the burst — render it via the shared
            // block renderer (it only needs onExpand; terminal/session are unused for raw).
            <BlockView
              key={block.id}
              block={block}
              onExpand={() => onExpand(block)}
              terminalId=""
              sessionId={null}
            />
          ),
        )}
      </div>
    </details>
  )
}

function ToolView({ tool, onExpand }: { tool: ToolBlock; onExpand: () => void }) {
  const summary = toolSummary(tool.input)
  // CAPP-111 — explicit expand button (icon-only/compact) as the last flex child,
  // pushed right via the CSS `margin-left:auto`; replaces the old whole-block click.
  const ex = expandLabelForBlock(tool)
  return (
    <div className={`agent-block agent-tool agent-tool-${tool.status}`}>
      <span className={`agent-tool-status agent-tool-status-${tool.status}`} aria-label={tool.status} />
      <span className="agent-tool-name">{tool.name || "tool"}</span>
      {summary && <span className="agent-tool-summary">{truncate(summary, 80)}</span>}
      {ex && <BlockExpandButton label={ex.label} compact={ex.compact} onExpand={onExpand} />}
    </div>
  )
}

function ResultView({ result, onExpand }: { result: ResultBlock; onExpand: () => void }) {
  // CAPP-111 — explicit top-right icon-only expand button, replacing the old
  // click-to-open on `.agent-result-text`. The block root is `position:relative`
  // and the button absolute top-right (icon-only fits the reserved gutter clear of
  // the meta row / cost chips — CAPP-111 review).
  const ex = expandLabelForBlock(result)
  return (
    <div className={`agent-block agent-result ${result.isError ? "agent-result-error" : ""}`}>
      {ex && <BlockExpandButton label={ex.label} compact={ex.compact} onExpand={onExpand} />}
      {result.text && (
        <div className="agent-result-text">
          <MarkdownView source={result.text} />
        </div>
      )}
      <div className="agent-result-meta">
        <span className="agent-result-label">{result.isError ? "Turn failed" : "Turn complete"}</span>
        <CostChips cost={result.cost} />
      </div>
    </div>
  )
}

/**
 * BO-6 — the model-unavailable banner. Distinct from the bare "Turn failed"
 * result: it names the offending model and embeds the picker inline so the user
 * fixes it in one click (the pick respawns this terminal on a working model). This
 * is what future-proofs the next model disablement.
 */
function ModelErrorView({
  block,
  terminalId,
  sessionId,
  model,
  modelOptions,
  resolvedModel,
  onSwitched,
}: {
  block: ModelErrorBlock
  terminalId: string
  sessionId: string | null
  model?: string
  /** CAPP-113 — the effective (config-extensible) option list + resolved-model echo,
   *  so the recovery banner's picker matches the composer's (models.extra/hidden
   *  honored on the exact surface a disabled model strands the user on). */
  modelOptions?: string[]
  resolvedModel?: string
  onSwitched?: (terminalId: string) => void
}) {
  const name = block.model ?? model
  return (
    <div className="agent-block agent-model-error" role="alert">
      <span className="agent-error-icon">!</span>
      <div className="agent-model-error-body">
        <div className="agent-model-error-msg">
          {name ? (
            <>
              Model <code>{name}</code> is unavailable — pick another.
            </>
          ) : (
            "The selected model is unavailable — pick another."
          )}
        </div>
        <AgentModelPicker
          sessionId={sessionId}
          terminalId={terminalId}
          model={model}
          options={modelOptions}
          resolvedModel={resolvedModel}
          variant="banner"
          onSwitched={onSwitched}
        />
      </div>
    </div>
  )
}

/**
 * CAPP-39 gate ② — the "not signed in" banner. The headless `claude -p` path
 * CANNOT show Claude's OAuth login UI, so the Sign-in button launches a ONE-TIME
 * INTERACTIVE xterm terminal running `claude /login` (via window.api.startLogin →
 * a dedicated IPC → TerminalService.createLogin). The user completes the OAuth flow
 * there, then re-sends their message in this structured session. AUTO-RETRY of the
 * failed turn is intentionally OUT OF SCOPE (follow-up: CAPP-39 gate ② polish).
 */
function NeedsAuthView({
  block,
  sessionId,
}: {
  block: NeedsAuthBlock
  sessionId: string | null
}) {
  const [busy, setBusy] = useState(false)
  const [launched, setLaunched] = useState(false)
  const signIn = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      await window.api.startLogin(sessionId ?? undefined)
      setLaunched(true)
    } catch {
      // Best-effort: a failed launch leaves the banner so the user can retry.
    } finally {
      setBusy(false)
    }
  }, [busy, sessionId])

  return (
    <div className="agent-block agent-needs-auth" role="alert">
      <span className="agent-needs-auth-icon" aria-hidden="true">🔑</span>
      <div className="agent-needs-auth-body">
        <div className="agent-needs-auth-title">You're not signed in to Claude</div>
        <div className="agent-needs-auth-msg">
          {block.message || "Sign in to continue, then re-send your message."}
        </div>
        <div className="agent-needs-auth-actions">
          <button
            type="button"
            className="agent-needs-auth-btn"
            onClick={signIn}
            disabled={busy}
          >
            {busy ? "Opening login…" : "Sign in"}
          </button>
          {launched && (
            <span className="agent-needs-auth-hint">
              Complete login in the new terminal, then re-send your message.
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/** The user-facing cost surface for a completed turn (automation-credit burn). */
function CostChips({ cost }: { cost?: ResultCost }) {
  if (!cost) return null
  const chips: string[] = []
  if (cost.costUsd != null) chips.push(`$${cost.costUsd.toFixed(4)}`)
  if (cost.totalTokens != null) chips.push(`${cost.totalTokens.toLocaleString()} tok`)
  else {
    if (cost.inputTokens != null) chips.push(`${cost.inputTokens.toLocaleString()} in`)
    if (cost.outputTokens != null) chips.push(`${cost.outputTokens.toLocaleString()} out`)
  }
  if (cost.durationMs != null) chips.push(`${(cost.durationMs / 1000).toFixed(2)}s`)
  if (chips.length === 0) return null
  return (
    <span className="agent-cost">
      {chips.map((c, i) => (
        <span key={i} className="agent-cost-chip">
          {c}
        </span>
      ))}
    </span>
  )
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}

function previewJson(raw: unknown): string {
  try {
    return truncate(JSON.stringify(raw), 120)
  } catch {
    return String(raw)
  }
}
