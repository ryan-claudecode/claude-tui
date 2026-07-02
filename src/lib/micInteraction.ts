import type { SttStatus } from "../../electron/stt/protocol"

/**
 * CAPP-120 (STT-1, review finding 10) — the dictation mic's interaction DECISIONS as
 * pure, exhaustively-testable logic (this repo's pure-fn idiom). The composer is a thin
 * wrapper: it feeds pointer/keyboard events + refs in and executes the returned action.
 * Everything here is DOM-free so vitest's node environment covers the full matrix
 * (hold-vs-click, pointercancel, Esc precedence, Ctrl+M guard, the recording cap).
 */

/** Press-and-hold longer than this = push-to-talk (record while held, stop on release). */
export const HOLD_THRESHOLD_MS = 350

/**
 * Review finding 4 — the recording cap. Unbounded capture accumulates ~11.5 MB/min of
 * Float32 (then full structured-clone copies across IPC); at this cap the hook auto-STOPS
 * exactly like a manual stop (transcribes what was captured) and raises a notice toast.
 */
export const MAX_RECORDING_MS = 5 * 60_000

// ---------------------------------------------------------------------------
// Pointer state machine (hold = push-to-talk, quick click = toggle)
// ---------------------------------------------------------------------------

export type MicDownAction = "open-setup" | "arm" | "none"

/** Pointer-down: non-primary buttons are ignored; a not-ready engine opens the
 *  inline setup/download flow; ready arms the hold-vs-click decision. */
export function micPointerDownAction(opts: { status: SttStatus; primaryButton: boolean }): MicDownAction {
  if (!opts.primaryButton) return "none"
  if (opts.status !== "ready") return "open-setup"
  return "arm"
}

export type MicUpAction = "stop-transcribe" | "toggle" | "none"

/**
 * Pointer-up: only an ARMED press acts (an `open-setup` press, or a stray up without a
 * down, is a no-op). Held past the threshold = push-to-talk release → stop + transcribe;
 * a quick click = toggle recording.
 */
export function micPointerUpAction(opts: {
  armed: boolean
  held: boolean
  primaryButton: boolean
}): MicUpAction {
  if (!opts.primaryButton || !opts.armed) return "none"
  return opts.held ? "stop-transcribe" : "toggle"
}

export type MicCancelAction = "stop-transcribe" | "none"

/**
 * Review finding 8 — pointercancel (or lostpointercapture) after the hold elapsed must
 * take the SAME stop path as pointerup, or the mic is left permanently hot (pointerup
 * never fires after a cancel). A cancel before the hold elapsed just disarms (no user
 * intent completed — never toggle on a cancelled quick click).
 */
export function micPointerCancelAction(opts: { armed: boolean; held: boolean }): MicCancelAction {
  return opts.armed && opts.held ? "stop-transcribe" : "none"
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

/** The Ctrl+M / Cmd+M dictation-toggle match guard (no Shift/Alt chords). */
export function isDictationShortcut(e: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}): boolean {
  return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "m" || e.key === "M")
}

export type EscapeOwner = "discard-recording" | "interrupt" | "none"

/**
 * Review finding 2 (MAJOR) — the Esc precedence. An ACTIVE dictation recording owns
 * Escape: discard the recording (mic off, nothing transcribed, composer text untouched)
 * and do NOT interrupt the agent's turn. Only when no recording is live does Esc fall
 * through to the BO-10 busy-terminal interrupt. App.tsx's capture-phase Escape arm
 * mirrors this exact ordering (dictation handlers consulted FIRST, then escInterruptRef).
 */
export function escapePrecedence(opts: {
  recordingActive: boolean
  interruptAvailable: boolean
}): EscapeOwner {
  if (opts.recordingActive) return "discard-recording"
  if (opts.interruptAvailable) return "interrupt"
  return "none"
}

// ---------------------------------------------------------------------------
// Recording clock (elapsed + the finding-4 cap)
// ---------------------------------------------------------------------------

/** One tick of the recording clock: whole elapsed seconds + whether the cap is hit. */
export function recordingTick(
  startedAtMs: number,
  nowMs: number,
  maxMs: number = MAX_RECORDING_MS,
): { elapsedSec: number; capped: boolean } {
  const elapsed = Math.max(0, nowMs - startedAtMs)
  return { elapsedSec: Math.floor(elapsed / 1000), capped: elapsed >= maxMs }
}
