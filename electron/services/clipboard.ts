import { clipboard } from "electron"

export interface ClipboardResult {
  /** The clipboard text after the operation. */
  text: string
  /** Character length of the text. */
  length: number
}

/**
 * ClipboardService — read from and write to the user's system clipboard.
 *
 * Lets Claude hand finished artifacts straight to the user's clipboard (a
 * generated command, a regex, a snippet) so they can paste elsewhere without
 * copying out of the terminal — and read back whatever the user just copied to
 * pull it into the conversation. Thin wrapper over Electron's `clipboard`.
 */
export class ClipboardService {
  /** Return the current clipboard text. */
  read(): ClipboardResult {
    const text = clipboard.readText()
    return { text, length: text.length }
  }

  /** Replace the clipboard contents with `text`. */
  write(text: string): ClipboardResult {
    clipboard.writeText(text)
    return { text, length: text.length }
  }
}
