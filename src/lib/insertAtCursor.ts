/**
 * CAPP-120 (STT-1) — pure "splice text at the cursor with smart spacing" helper for the
 * dictation flow. Transcribed text is inserted at the composer's caret (or over its
 * selection), space-separated from adjacent words so it never fuses onto a neighbor
 * ("hello" + "world" → "hello world", but "(" + "hi" stays "(hi", and "hi" + "." → "hi.").
 *
 * Kept pure (no DOM) so it's unit-tested; the composer wraps it around the textarea's
 * selectionStart/selectionEnd.
 */
export interface SpliceResult {
  text: string
  /** The caret position AFTER the inserted text (both selection ends collapse here). */
  cursor: number
}

/** True if `s` ends with a char the inserted text should be spaced away from. */
function needsLeadingSpace(before: string, insert: string): boolean {
  if (before.length === 0) return false
  if (/\s$/.test(before)) return false // already whitespace-separated
  if (/[([{]$/.test(before)) return false // don't space after an opening bracket
  // Don't add a leading space if the insert itself starts with space or closing punct.
  if (/^[\s.,!?;:'")\]}]/.test(insert)) return false
  return true
}

/** True if the following text should be spaced away from the inserted text. */
function needsTrailingSpace(after: string, insert: string): boolean {
  if (after.length === 0) return false
  if (/\s$/.test(insert)) return false // insert already ends with space
  // Only separate from a real word/opening-bracket start, not punctuation.
  return /^[A-Za-z0-9([{'"]/.test(after)
}

/**
 * Splice `insert` into `text`, replacing [selStart, selEnd), adding surrounding spaces
 * where needed. Clamps the selection indices into range.
 */
export function spliceWithSpacing(
  text: string,
  selStart: number,
  selEnd: number,
  insert: string,
): SpliceResult {
  const len = text.length
  const start = Math.max(0, Math.min(selStart, len))
  const end = Math.max(start, Math.min(selEnd, len))
  const before = text.slice(0, start)
  const after = text.slice(end)
  let ins = insert
  if (needsLeadingSpace(before, ins)) ins = " " + ins
  if (needsTrailingSpace(after, ins)) ins = ins + " "
  const cursor = before.length + ins.length
  return { text: before + ins + after, cursor }
}
