import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import SlashCommandPicker from "./SlashCommandPicker"
import { useSlashPicker } from "../hooks/useSlashPicker"
import AgentModelPicker from "./AgentModelPicker"
import AgentEffortPicker from "./AgentEffortPicker"
import AgentUltracodeToggle from "./AgentUltracodeToggle"

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
  const taRef = useRef<HTMLTextAreaElement>(null)

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

  // CAPP-49 — clear the transient `stopping` flag whenever this composer is bound to
  // a NEW terminal id (a respawn landed and the pane re-pointed). Single-pane remounts
  // fresh so this is a no-op there; it matters for the persistent split-pane composer,
  // where a left-over `stopping=true` would otherwise wedge the Stop button the next
  // time the (new) terminal goes busy.
  useEffect(() => {
    setStopping(false)
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

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // BO-7 — while the picker is open it owns Up/Down/Enter/Tab/Esc.
      if (picker.handleKeyDown(e)) return
      // Enter sends; Shift+Enter inserts a newline. Never send mid-IME-composition
      // (an Enter that commits a CJK/diacritic candidate must not submit).
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        send()
      }
    },
    [send, picker.handleKeyDown],
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
        </div>
      </div>
    </div>
  )
}
