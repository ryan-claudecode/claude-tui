import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import SlashCommandPicker from "./SlashCommandPicker"
import { useSlashPicker } from "../hooks/useSlashPicker"
import AgentModelPicker from "./AgentModelPicker"
import AgentEffortPicker from "./AgentEffortPicker"
import AgentUltracodeToggle from "./AgentUltracodeToggle"
import { useDictation } from "../hooks/useDictation"
import { spliceWithSpacing } from "../lib/insertAtCursor"
import { formatElapsed } from "../lib/audioCapture"
import {
  HOLD_THRESHOLD_MS,
  micPointerDownAction,
  micPointerUpAction,
  micPointerCancelAction,
  isDictationShortcut,
} from "../lib/micInteraction"
import { registerDictationEscHandler } from "../lib/dictationEsc"
import { toast } from "../lib/toast"
import type { SttProgress } from "../../electron/stt/protocol"

/** CAPP-120 — MB (1 dp) for the download progress label. */
function formatMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}

/** CAPP-120 / CAPP-124 — a human label for the current acquisition phase. When the
 *  total is known the download label leads with the percent ("Downloading… 43% ·
 *  290.0 / 680.0 MB") so the card is legible at a glance. */
export function dictationProgressLabel(p: SttProgress | null): string {
  if (!p) return "Preparing…"
  if (p.phase === "downloading") {
    const got = formatMB(p.receivedBytes ?? 0)
    if (p.totalBytes) return `Downloading… ${dictationProgressPct(p)}% · ${got} / ${formatMB(p.totalBytes)} MB`
    return `Downloading… ${got} MB`
  }
  if (p.phase === "extracting") return "Extracting…"
  if (p.phase === "verifying") return "Verifying…"
  return "Preparing…"
}

/** CAPP-120 — a 0–100 progress percent (0 when the total is unknown). */
export function dictationProgressPct(p: SttProgress | null): number {
  if (!p || p.phase !== "downloading" || !p.totalBytes || p.totalBytes <= 0) return 0
  return Math.max(0, Math.min(100, Math.round(((p.receivedBytes ?? 0) / p.totalBytes) * 100)))
}

interface Props {
  /** The structured (headless) terminal this composer feeds. */
  terminalId: string
  /** The work-session container the terminal belongs to (for the model/effort/raw
   *  switches now rendered under the composer). Null until the session is started. */
  sessionId?: string | null
  /** The terminal's current `--model` (shown in + driven by the model picker). */
  model?: string
  /** CAPP-46 — the terminal's current `--effort` level (driven by the effort picker). */
  effort?: string
  /** CAPP-108 — the terminal's current ultracode posture (driven by the toggle;
   *  the toggle only renders for xhigh-capable models). */
  ultracode?: boolean
  /** CAPP-113 — the effective, config-extensible model option list for the picker
   *  (built-in aliases ∪ config models.extra − hidden). Absent → built-in aliases. */
  modelOptions?: string[]
  /** CAPP-113 — the RESOLVED full model id (init echo) for the picker's tooltip. */
  resolvedModel?: string
  /** CAPP-113 — the ADDITIVE config models.xhigh list for the ultracode visibility gate. */
  extraXhigh?: string[]
  /**
   * BO-10 — the agent is generating a turn or parked on a permission prompt. While
   * busy, Send is disabled (writing to a blocked stdin would silently buffer unread
   * — the message would look "sent" but lost) and a Stop button surfaces instead.
   */
  busy?: boolean
  /** CAPP-39 gate ③ — true while the structured→xterm engine swap is in flight; the
   *  Raw-view button shows "Switching…" and stays disabled. Owned by AgentSurface. */
  switching?: boolean
  /** CAPP-39 gate ③ — disabled state for the Raw-view button (= !sessionId || busy ||
   *  switching). Computed by AgentSurface, which owns the switch. */
  rawViewDisabled?: boolean
  /** CAPP-39 gate ③ — fire AgentSurface's structured→xterm switch (relocated from the
   *  old header into the composer controls row). */
  onSwitchToRaw?: () => void
  /** Re-point the active selection at the respawned terminal after an interrupt
   *  (the kill+resume mints a new terminal id, like the model switch). Also passed to
   *  the model/effort pickers, whose respawn mints a fresh id too. */
  onSwitched?: (terminalId: string) => void
}

/**
 * BO-3 — the human→agent input for a structured (headless) session. Replaces the
 * role xterm's keystroke stream played for PTY sessions: a multiline composer
 * that sends ONE structured user message per submit (Enter=send, Shift+Enter=
 * newline). Image attachments reuse the existing saveDroppedImage path (drop an
 * image onto the composer) and ride along as quoted paths in the message.
 *
 * It sends via window.api.sendAgentInput → TerminalService.sendAgentMessage — it
 * NEVER calls writeToSession / pty.write (input was never load-bearing to xterm).
 * A structured message always submits, so there is no staged "don't run" mode
 * here: send is immediate.
 */
export default function AgentComposer({
  terminalId,
  sessionId = null,
  model,
  effort,
  ultracode,
  modelOptions,
  resolvedModel,
  extraXhigh,
  busy = false,
  switching = false,
  rawViewDisabled = false,
  onSwitchToRaw,
  onSwitched,
}: Props) {
  const [text, setText] = useState("")
  const [attachments, setAttachments] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // CAPP-120 (STT-1) — push-to-talk dictation. The mic inserts transcribed text at the
  // caret (never auto-submits); the model downloads on first enable via the inline overlay.
  const [downloadOpen, setDownloadOpen] = useState(false)
  const holdTimerRef = useRef<number | null>(null)
  /** True between a ready-state pointerdown and its up/cancel (the press is "live"). */
  const armedRef = useRef(false)
  /** True once the 350ms hold elapsed on the current press (push-to-talk mode). */
  const heldRef = useRef(false)

  // Splice transcribed (or any) text into the textarea at the caret with smart spacing,
  // then restore focus + caret. `ta.value` is the source of truth (controlled input).
  const insertAtCursor = useCallback((insert: string) => {
    const ta = taRef.current
    const base = ta ? ta.value : text
    const selStart = ta ? ta.selectionStart ?? base.length : base.length
    const selEnd = ta ? ta.selectionEnd ?? base.length : base.length
    const { text: next, cursor } = spliceWithSpacing(base, selStart, selEnd, insert)
    setText(next)
    requestAnimationFrame(() => {
      const el = taRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(cursor, cursor)
      }
    })
  }, [text])

  const dictation = useDictation({
    onInsert: insertAtCursor,
    onError: (message) => toast("error", message),
    // Review finding 4 — the recording-cap auto-stop announces itself as an info
    // notice (it isn't an error: the captured audio IS transcribed).
    onNotice: (message) => toast("info", message),
  })

  // Auto-close the download overlay once the model is ready.
  useEffect(() => {
    if (downloadOpen && dictation.status === "ready") setDownloadOpen(false)
  }, [downloadOpen, dictation.status])

  // Review finding 2 (MAJOR) — register this composer's Esc-discard with the renderer-
  // local registry. App.tsx's CAPTURE-phase Escape arm consults dispatchDictationEsc()
  // FIRST, so an active recording owns Esc (discard, mic off) and the busy-terminal
  // interrupt only fires when nothing was recording. Multi-instance-safe: a split pane
  // registers two handlers; only the recording one returns true.
  useEffect(
    () =>
      registerDictationEscHandler(() => {
        if (!dictation.recording) return false
        dictation.cancelRecording()
        return true
      }),
    [dictation.recording, dictation.cancelRecording],
  )

  // Review finding 9 — never leak the 350ms hold timer across unmount: pressing the mic
  // then switching terminals within the threshold would otherwise fire dictation.start()
  // on an unmounted hook (whose own unmount guard then has to clean up a ghost stream).
  useEffect(
    () => () => {
      if (holdTimerRef.current != null) window.clearTimeout(holdTimerRef.current)
    },
    [],
  )

  // CAPP-58 — auto-grow the textarea so Shift+Enter newlines GROW the box line-by-
  // line instead of overflowing+scrolling a fixed `rows={1}`. Reset to `auto` first
  // so it can SHRINK back too (e.g. send() clears the text), then measure scrollHeight.
  // The CSS caps it (.composer-input min-height 44px / max-height 180px); past the cap
  // the box scrolls. Under the global `box-sizing: border-box`, scrollHeight is
  // content+padding (NO border), so add the vertical border to get the border-box
  // height that shows every line — otherwise the last line clips ~1 step before the
  // scrollbar engages. Runs in useLayoutEffect on every `text` change (keystrokes,
  // slash-insert, send()'s clear) so the resize is committed before paint — no jump.
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = "auto"
    const max = 180 // keep in sync with .composer-input max-height
    const cs = getComputedStyle(ta)
    const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0)
    const needed = ta.scrollHeight + border // border-box height to show all content
    ta.style.height = `${Math.min(needed, max)}px`
    ta.style.overflowY = needed > max ? "auto" : "hidden"
  }, [text])

  const send = useCallback(() => {
    // BO-10 — never send while busy: the message would write into a stdin the
    // parked turn can't read (it buffers unread), so the composer would falsely
    // report "sent". Stop the agent first. The button is disabled too; this guards
    // the Enter path.
    if (busy) return
    const trimmed = text.trim()
    if (!trimmed && attachments.length === 0) return
    window.api.sendAgentInput(terminalId, { text: trimmed, attachments })
    setText("")
    setAttachments([])
    // Keep focus for the next message.
    requestAnimationFrame(() => taRef.current?.focus())
  }, [busy, text, attachments, terminalId])

  // BO-10 — the handbrake. Kill the proc + resume the SAME conversation (the
  // aborted turn is dropped, the chat survives). The respawn mints a new terminal
  // id; onSwitched re-points the active selection at it. In single-pane this
  // component then unmounts; in a split pane it stays mounted and is re-pointed to
  // the new id (see the terminalId-change reset below).
  const stop = useCallback(async () => {
    setStopping(true)
    try {
      const r = await window.api.interruptAgent(terminalId)
      if (r?.terminalId) onSwitched?.(r.terminalId)
      // CAPP-49 — a no-op interrupt (single-flight already in flight, or the terminal
      // was torn down) resolves with `undefined`: no respawn, no re-point, so this
      // composer stays mounted on the SAME id. Clear `stopping` here too, otherwise
      // the Stop button wedges on "Stopping…" forever (previously only the catch did).
      else setStopping(false)
    } catch {
      // Best-effort; if the interrupt failed the busy state simply persists and the
      // user can retry. Clear the transient stopping flag so the button is usable.
      setStopping(false)
    }
  }, [terminalId, onSwitched])

  // Restart THIS terminal in place: kill the proc + resume the SAME conversation on the
  // SAME engine, so a fresh --mcp-config / config read picks up MCP or config changes
  // without closing the app. The respawn mints a new terminal id; onSwitched re-points
  // the active selection at it (like the interrupt / model switch). Usable while busy —
  // reloading a wedged proc is the point — and while idle (the common MCP-reload case).
  const restart = useCallback(async () => {
    if (!sessionId || restarting) return
    setRestarting(true)
    try {
      const r = await window.api.restartTerminal(terminalId)
      if (r?.terminalId) onSwitched?.(r.terminalId)
      // A no-op restart (single-flight already in flight, or the terminal was torn
      // down) resolves undefined: no respawn, no re-point, so this composer stays on the
      // SAME id — clear the flag here so the button doesn't wedge on "Restarting…".
      else setRestarting(false)
    } catch {
      toast("error", "Couldn't restart the terminal.")
      setRestarting(false)
    }
  }, [sessionId, restarting, terminalId, onSwitched])

  // CAPP-49 — clear the transient `stopping` flag whenever this composer is bound to
  // a NEW terminal id (a respawn landed and the pane re-pointed). Single-pane remounts
  // fresh so this is a no-op there; it matters for the persistent split-pane composer,
  // where a left-over `stopping=true` would otherwise wedge the Stop button the next
  // time the (new) terminal goes busy. The `restarting` flag rides the same reset (a
  // landed restart re-points to a new id, so the button must un-wedge).
  useEffect(() => {
    setStopping(false)
    setRestarting(false)
  }, [terminalId])

  // BO-7 — `/`-command autocomplete (structured-only; this composer mounts only for
  // structured terminals). Catalog is sourced live from the headless `init` event.
  // Selecting an entry inserts `/name ` into the message; the existing input path
  // then routes it to stdin where Claude (or the native-command intercept) handles it.
  const picker = useSlashPicker({
    terminalId,
    text,
    onAccept: (name) => {
      setText(`/${name} `)
      requestAnimationFrame(() => taRef.current?.focus())
    },
  })

  // CAPP-120 — the mic affordance: a quick click toggles recording; a press-and-hold
  // (≥HOLD_THRESHOLD_MS) is push-to-talk (record while held, stop on release). Pointer
  // capture keeps the release on the button even if the pointer drifts off mid-hold.
  // When the model isn't downloaded, the press opens the inline download overlay instead.
  // Review finding 10 — the DECISIONS live in src/lib/micInteraction.ts (pure, tested:
  // hold-vs-click, pointercancel, non-primary buttons); this component only executes them.
  const clearHold = useCallback(() => {
    if (holdTimerRef.current != null) {
      window.clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
  }, [])

  const onMicPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const action = micPointerDownAction({ status: dictation.status, primaryButton: e.button === 0 })
      if (action === "none") return
      e.preventDefault()
      if (action === "open-setup") {
        setDownloadOpen(true)
        return
      }
      // "arm" — the press is live; the hold timer decides push-to-talk vs quick click.
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* capture is best-effort */
      }
      armedRef.current = true
      heldRef.current = false
      clearHold()
      holdTimerRef.current = window.setTimeout(() => {
        if (!armedRef.current) return // stale timer (already released/cancelled)
        heldRef.current = true
        void dictation.start()
      }, HOLD_THRESHOLD_MS)
    },
    [dictation, clearHold],
  )

  // Shared release path for pointerup AND pointercancel/lostpointercapture (finding 8):
  // a cancel after the hold elapsed takes the SAME stop route as a release, so the mic
  // can never be left hot. Idempotent — armedRef is cleared first, so the duplicate
  // lostpointercapture that follows our own releasePointerCapture resolves to "none".
  const finishMicPointer = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>, kind: "up" | "cancel") => {
      clearHold()
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      const state = { armed: armedRef.current, held: heldRef.current }
      armedRef.current = false
      heldRef.current = false
      const action =
        kind === "up"
          ? micPointerUpAction({ ...state, primaryButton: e.button === 0 })
          : micPointerCancelAction(state)
      if (action === "stop-transcribe") void dictation.stop()
      else if (action === "toggle") dictation.toggleRecord()
    },
    [dictation, clearHold],
  )

  const onMicPointerUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => finishMicPointer(e, "up"),
    [finishMicPointer],
  )
  const onMicPointerCancel = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => finishMicPointer(e, "cancel"),
    [finishMicPointer],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // BO-7 — while the picker is open it owns Up/Down/Enter/Tab/Esc.
      if (picker.handleKeyDown(e)) return
      // CAPP-120 — Ctrl+M (or Cmd+M) toggles dictation while the composer is focused;
      // opens the download overlay if the model isn't ready yet. The match guard is the
      // pure isDictationShortcut (review finding 10 — no Shift/Alt chords).
      if (isDictationShortcut(e)) {
        e.preventDefault()
        if (dictation.status === "ready") dictation.toggleRecord()
        else setDownloadOpen(true)
        return
      }
      // CAPP-120 — Escape discards an in-flight recording (before it interrupts the agent).
      if (e.key === "Escape" && dictation.recording) {
        e.preventDefault()
        dictation.cancelRecording()
        return
      }
      // Enter sends; Shift+Enter inserts a newline. Never send mid-IME-composition
      // (an Enter that commits a CJK/diacritic candidate must not submit).
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        send()
      }
    },
    [send, picker.handleKeyDown, dictation],
  )

  const onDrop = useCallback((e: React.DragEvent) => {
    // Attach the image here. We deliberately do NOT stopPropagation: App's global
    // handleDrop also fires, but it detects a `.agent-composer` target and skips
    // its own write (only clearing the drop overlay) — so the image attaches once
    // AND the full-window overlay doesn't get stuck.
    e.preventDefault()
    setDragOver(false)
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"))
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const path = await window.api.saveDroppedImage(reader.result as string, file.name)
        setAttachments((prev) => [...prev, path])
      } catch {
        // best-effort attach; ignore failures.
      }
    }
    reader.readAsDataURL(file)
  }, [])

  // CAPP-124 — the download card's progress bar. A determinate width while bytes stream
  // (percent known); an INDETERMINATE sweep while extracting/verifying or before the
  // first byte total is known (pct 0), so the bar never sits dead-flat at 0.
  const dlPct = dictationProgressPct(dictation.progress)
  const dlIndeterminate = dictation.status === "downloading" && dlPct === 0

  // CAPP-124 — the mic affordance (icon-only, universal glyph) now lives in the INPUT
  // ROW immediately beside Send; while recording it REPLACES the glyph with a pulsing
  // dot + elapsed, so the recording state is unmissable next to the input. The card is
  // rendered as a viewport-fixed overlay (see below) so no ancestor overflow clips it.
  const micAffordance = dictation.enabled ? (
    <div className="composer-mic-wrap">
      <button
        type="button"
        className={`composer-mic composer-mic-${dictation.micState}${
          dictation.status !== "ready" ? " composer-mic-setup" : ""
        }`}
        onPointerDown={onMicPointerDown}
        onPointerUp={onMicPointerUp}
        onPointerCancel={onMicPointerCancel}
        onLostPointerCapture={onMicPointerCancel}
        disabled={dictation.transcribing}
        aria-pressed={dictation.recording}
        aria-label={
          dictation.recording
            ? "Stop recording"
            : dictation.transcribing
              ? "Transcribing"
              : dictation.status === "ready"
                ? "Dictate — click to record, hold to push-to-talk (Ctrl+M)"
                : "Set up voice dictation"
        }
        title={
          dictation.status === "ready"
            ? // CAPP-121 (STT-2) — the workspace-vocabulary term count is a tooltip SUPPLEMENT
              // ("Parakeet · 214 workspace terms"), never the primary affordance.
              `Dictate — click to record, hold to push-to-talk (Ctrl+M)${
                dictation.hotwordCount > 0 ? ` · Parakeet, ${dictation.hotwordCount} workspace terms` : ""
              }`
            : "Set up voice dictation (downloads an on-device model)"
        }
      >
        {dictation.recording ? (
          <>
            <span className="composer-mic-dot" aria-hidden="true" />
            <span className="composer-mic-elapsed">{formatElapsed(dictation.elapsedSec)}</span>
          </>
        ) : dictation.transcribing ? (
          <span className="composer-mic-spinner" aria-hidden="true" />
        ) : (
          <span className="composer-mic-icon" aria-hidden="true">
            🎤
          </span>
        )}
      </button>
      {downloadOpen && (
        <>
          {/* CAPP-124 — a faint scrim: focuses attention on the card + closes on click.
              Both scrim and card are position:fixed so they escape the composer's
              overflow-clipped, z-index:4 stacking context (the old absolute card was
              truncated by .terminal-container { overflow: hidden }). */}
          <div
            className="composer-mic-download-backdrop"
            onClick={() => setDownloadOpen(false)}
            aria-hidden="true"
          />
          <div className="composer-mic-download" role="dialog" aria-modal="true" aria-label="Voice dictation setup">
            <div className="composer-mic-download-head">
              <span className="composer-mic-download-title">Voice dictation</span>
              <button
                type="button"
                className="composer-mic-download-x"
                aria-label="Close"
                onClick={() => setDownloadOpen(false)}
              >
                ×
              </button>
            </div>

            {dictation.status === "downloading" ? (
              // DOWNLOADING / EXTRACTING / VERIFYING — live progress + Cancel.
              <>
                <div className="composer-mic-progress-label">
                  {dictationProgressLabel(dictation.progress)}
                </div>
                <div className={`composer-mic-progress${dlIndeterminate ? " indeterminate" : ""}`}>
                  <div
                    className="composer-mic-progress-bar"
                    style={dlIndeterminate ? undefined : { width: `${dlPct}%` }}
                  />
                </div>
                <div className="composer-mic-download-actions">
                  <button
                    type="button"
                    className="composer-mic-download-cancel"
                    onClick={() => dictation.cancelAcquire()}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : dictation.status === "error" ? (
              // ERROR — the message + Retry (resume) and Re-download (force, deletes the
              // possibly-corrupt model dir + re-fetches — the way out of a bad-files loop).
              <>
                <p className="composer-mic-download-error">
                  {dictation.statusMessage ?? dictation.progress?.message ?? "The download failed."}
                </p>
                <p className="composer-mic-download-desc">
                  Retry the download, or re-download from scratch if the model files look corrupt.
                </p>
                <div className="composer-mic-download-actions">
                  <button
                    type="button"
                    className="composer-mic-download-go"
                    onClick={() => dictation.acquire(false)}
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    className="composer-mic-download-cancel"
                    onClick={() => dictation.acquire(true)}
                  >
                    Re-download
                  </button>
                </div>
              </>
            ) : dictation.status === "ready" ? (
              // READY — a confirmation (the effect below also auto-closes the card).
              <>
                <p className="composer-mic-download-desc">
                  Voice dictation is ready. Click the mic to record, or hold it to push-to-talk.
                </p>
                <div className="composer-mic-download-actions">
                  <button
                    type="button"
                    className="composer-mic-download-go"
                    onClick={() => setDownloadOpen(false)}
                  >
                    Done
                  </button>
                </div>
              </>
            ) : (
              // NOT-DOWNLOADED — the initial CONFIRM step. Never auto-starts: the download
              // begins only when the user clicks "Download model".
              <>
                <p className="composer-mic-download-desc">
                  Download the dictation model (~680&nbsp;MB)? It then runs fully offline —
                  audio never leaves your machine.
                </p>
                <div className="composer-mic-download-actions">
                  <button
                    type="button"
                    className="composer-mic-download-go"
                    onClick={() => dictation.acquire(false)}
                  >
                    Download model
                  </button>
                  <button
                    type="button"
                    className="composer-mic-download-cancel"
                    onClick={() => setDownloadOpen(false)}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
            <p className="composer-mic-attribution">
              {dictation.attribution ||
                "Speech model: NVIDIA Parakeet TDT 0.6B v2 (English), licensed CC-BY-4.0."}
            </p>
          </div>
        </>
      )}
    </div>
  ) : null

  return (
    <div
      className={`agent-composer${dragOver ? " drag-over" : ""}`}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.items || []).some((i) => i.kind === "file")) {
          e.preventDefault()
          e.stopPropagation()
          setDragOver(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget === null) setDragOver(false)
      }}
      onDrop={onDrop}
    >
      {/* BO-7 — the `/`-command autocomplete, anchored above the input row. */}
      {picker.open && (
        <SlashCommandPicker
          entries={picker.entries}
          index={picker.index}
          onHover={picker.setIndex}
          onSelect={picker.accept}
          stale={picker.stale}
        />
      )}
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((p, i) => (
            <span className="composer-chip" key={`${p}-${i}`}>
              <span className="composer-chip-name" title={p}>
                {p.split(/[\\/]/).pop()}
              </span>
              <button
                className="composer-chip-x"
                aria-label="Remove attachment"
                onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-row">
        <textarea
          ref={taRef}
          className="composer-input"
          rows={1}
          placeholder={
            busy
              ? "Agent is working — press Stop or Esc to interrupt"
              : "Message the agent…  (Enter to send, Shift+Enter for newline, drop an image to attach)"
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {/* BO-10 — the visible handbrake (sibling to Send), shown only while the
            agent is generating or awaiting a permission. Same path as Esc. */}
        {busy && (
          <button
            className="composer-stop"
            onClick={stop}
            disabled={stopping}
            title="Stop the agent (Esc)"
          >
            {stopping ? "Stopping…" : "Stop"}
          </button>
        )}
        {/* CAPP-124 — the mic sits in the input row, immediately beside Send (the 2026
            chat convention), so first-time dictation is easy to find. Icon-only. */}
        {micAffordance}
        <button
          className="composer-send"
          onClick={send}
          disabled={busy || (!text.trim() && attachments.length === 0)}
        >
          Send
        </button>
      </div>
      {/* Footer — the persistent hint strip on the LEFT; the session chrome (model +
          effort + the Raw-view escape hatch, relocated out of the deleted surface header)
          on the RIGHT, under the Send button. All always visible (no hover-reveal); the
          chrome reads as quiet/compact, smaller than Send. The pickers self-disable on
          busy || !sessionId; Raw-view is disabled while busy/switching (the switch would
          lose a live turn) and shows "Switching…". a11y — ONLY the busy hint is a polite
          live region (it announces a state change); the idle hint is static, so it must
          NOT be an aria-live status (that would re-announce noisily). */}
      <div className="composer-footer">
        <div
          className={`composer-hint${busy ? " busy" : ""}`}
          {...(busy ? { role: "status", "aria-live": "polite" as const } : {})}
        >
          {busy ? (
            <span className="composer-hint-busy">
              {stopping
                ? "Stopping — restoring the conversation…"
                : "Agent is working — Esc or Stop to interrupt"}
            </span>
          ) : (
            <span className="composer-hint-keys">
              Enter to send · Shift+Enter for newline · / for commands · drop an image to attach
            </span>
          )}
        </div>
        <div className="composer-controls-row">
          <AgentModelPicker
            sessionId={sessionId}
            terminalId={terminalId}
            model={model}
            options={modelOptions}
            resolvedModel={resolvedModel}
            variant="composer"
            onSwitched={onSwitched}
          />
          <AgentEffortPicker
            sessionId={sessionId}
            terminalId={terminalId}
            effort={effort}
            variant="composer"
            onSwitched={onSwitched}
          />
          <AgentUltracodeToggle
            sessionId={sessionId}
            terminalId={terminalId}
            model={model}
            effort={effort}
            extraXhigh={extraXhigh}
            ultracode={ultracode}
            variant="composer"
            onSwitched={onSwitched}
          />
          <button
            className="agent-raw-view-btn agent-raw-view-btn-composer"
            onClick={onSwitchToRaw}
            disabled={rawViewDisabled}
            title="Switch this session to the raw terminal view (keeps the conversation)"
          >
            {switching ? "Switching…" : "Raw view"}
          </button>
          {/* Restart THIS terminal in place — reload the proc (picks up MCP/config
              changes) while resuming the conversation. Usable even while busy (that's
              when a wedged proc most needs reloading); disabled only with no session or
              while a restart/engine-swap is already in flight. */}
          <button
            className="agent-restart-btn"
            onClick={restart}
            disabled={!sessionId || restarting || switching}
            title="Restart this terminal — reload the process (picks up MCP/config changes) and resume the conversation"
          >
            {restarting ? "Restarting…" : "↻ Restart"}
          </button>
        </div>
      </div>
    </div>
  )
}
