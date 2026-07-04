import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

/**
 * CAPP-121 (STT-2) — workspace-vocabulary HOTWORD biasing for push-to-talk dictation.
 *
 * sherpa-onnx supports REAL contextual biasing for the NeMo transducer: a hotwords file
 * + `modified_beam_search` decoding boosts listed words at inference with NO retraining.
 * This is the feature no system-wide dictation tool can match — the recognizer learns the
 * OWNER'S live workspace vocabulary (file names, findings, model aliases, CLI flags).
 *
 * ── LIVE SPIKE VERDICT (empirical, this machine, sherpa-onnx-node over the shipped int8
 *    Parakeet-TDT-0.6b-v2 model) ─────────────────────────────────────────────────────────
 *  • `decodingMethod: "modified_beam_search"` IS accepted by this offline `nemo_transducer`
 *    and transcription works unchanged.
 *  • Hotwords MUST be BPE-TOKENIZED, not plain words: sherpa looks each space-separated
 *    item up in `tokens.txt`, and it converts the U+2581 word-boundary marker into a leading
 *    space — so a `▁`-prefixed item only encodes if its bare remainder is ALSO a token
 *    (`▁p`→`p` ✓, but `▁po`→`po` ✗). A plain word ("Phoebe") fails to encode with an explicit
 *    `Cannot find ID for token …` warning and is silently skipped (biasing is a no-op, but
 *    transcription still succeeds — graceful degradation).
 *  • CHAR-LEVEL spelling (`▁` + first char, then bare chars — `▁P h o e b e`) is guaranteed
 *    encodable (every ASCII letter/digit is a single token) and DOES bias (a `▁P H O E B E`
 *    hotword visibly boosted "PHOEBE"). At a MODEST score (~1.5) a realistic 15-word domain
 *    vocabulary left a clean transcription of NON-vocab speech perfectly intact — non-destructive.
 *
 * So the encoding this module emits is char-level token sequences, and the recommended score
 * is {@link DEFAULT_HOTWORDS_SCORE}. Full probe transcript: this ticket's report.
 *
 * ── SHAPE ──────────────────────────────────────────────────────────────────────────────
 * PURE CORE (no I/O, heavily unit-tested): the vocabulary derivation ({@link deriveHotwords}
 * + the identifier splitters) and the char-level tokenizer ({@link encodeHotwordLines}).
 * THIN FS WRAPPER (at the bottom, clearly fenced): {@link loadTokenSet} (reads `tokens.txt`)
 * and {@link collectWorkspaceNames} (the bounded workspace walk). The SttService stays PURE —
 * the file materialization is injected as `SttDeps.writeHotwords` from `runtime.ts`, which is
 * the only place these fs helpers are called.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The on-disk hotwords filename (written beside the model dir under `~/.claude-tui/stt/`). */
export const HOTWORDS_FILENAME = "hotwords.txt"

/** sherpa's sentencepiece word-boundary marker (U+2581). Prefixes the FIRST char of a word. */
export const HOTWORD_BOUNDARY = "▁"

/**
 * Hotword lists should stay MODEST — a huge list dilutes biasing and (at higher scores)
 * risks hallucination. Capped here; the SttService/worker never sees more than this.
 */
export const MAX_HOTWORDS = 300

/** Words shorter than this are dropped (1–2 char tokens are noise: "io", "os", "a"). */
export const MIN_WORD_LEN = 3

/** Directories never descended in the workspace walk (the dot-prefix skip covers `.git` etc.). */
export const HOTWORD_SKIP_DIRS: readonly string[] = ["node_modules", "dist", "out", "build", "coverage"]

// ---------------------------------------------------------------------------
// PURE CORE — vocabulary derivation
// ---------------------------------------------------------------------------

/**
 * Split a camelCase / PascalCase / ACRONYM chunk into component words. Snake/kebab/dot
 * separators are handled by {@link splitWords} before this runs.
 *   TerminalService → [Terminal, Service]
 *   getHTTPResponse → [get, HTTP, Response]
 * Digit boundaries are deliberately NOT split (utf8 / mp3 / opus1m stay intact).
 */
function splitCamel(chunk: string): string[] {
  return chunk
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Split an arbitrary source string (a file basename, a CLI flag, a finding line) into
 * component words: first on any non-alphanumeric run (`/ \ . _ - space [] …`), then on
 * camelCase boundaries within each chunk.
 */
export function splitWords(source: string): string[] {
  const out: string[] = []
  for (const chunk of source.split(/[^A-Za-z0-9]+/)) {
    if (!chunk) continue
    for (const w of splitCamel(chunk)) out.push(w)
  }
  return out
}

/**
 * Turn a source string into a single hotword ENTRY (a phrase). A camelCase/snake_case name
 * becomes a multi-word phrase ("TerminalService" → "Terminal Service"); words shorter than
 * {@link MIN_WORD_LEN} are dropped. Returns "" when nothing survives (the caller skips it).
 */
export function phraseFromSource(source: string): string {
  return splitWords(source)
    .filter((w) => w.length >= MIN_WORD_LEN)
    .join(" ")
}

/** The categorized raw inputs {@link deriveHotwords} folds into one vocabulary. */
export interface HotwordInputs {
  /** User config `stt.hotwords` — highest priority (always kept under the cap). */
  extras?: readonly string[]
  /** App constants: MODEL_ALIASES, EFFORT_LEVELS, common CLI flags. */
  terms?: readonly string[]
  /** File/dir basenames from the bounded workspace walk. */
  fileNames?: readonly string[]
}

/**
 * Fold the vocabulary sources into ONE deduped, capped hotword-entry list. Each entry
 * is a phrase (space-separated words) suitable for {@link encodeHotwordLines}. Ordering is
 * PRIORITY order (extras → terms → fileNames) so the user's own vocabulary and the core
 * constants always survive the {@link MAX_HOTWORDS} cap. Dedup is case-insensitive,
 * first occurrence (and its casing) wins.
 *
 * PURE — no I/O. The wiring layer (`ipc.ts`) gathers the raw inputs (through injected getters)
 * and hands them here.
 */
export function deriveHotwords(inputs: HotwordInputs, opts?: { max?: number }): string[] {
  const max = opts?.max ?? MAX_HOTWORDS
  const entries: string[] = []
  const push = (e: string) => {
    if (e) entries.push(e)
  }
  for (const e of inputs.extras ?? []) push(phraseFromSource(e))
  for (const t of inputs.terms ?? []) push(phraseFromSource(t))
  for (const n of inputs.fileNames ?? []) push(phraseFromSource(n))

  const seen = new Set<string>()
  const out: string[] = []
  for (const e of entries) {
    const key = e.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
    if (out.length >= max) break
  }
  return out
}

// ---------------------------------------------------------------------------
// PURE CORE — char-level BPE tokenization (see the SPIKE VERDICT above)
// ---------------------------------------------------------------------------

/**
 * Spell a single word as a char-level token sequence the sherpa hotword encoder accepts:
 * the first char is prefixed with the U+2581 boundary (`▁P`), the rest are bare chars
 * (`h`, `o`, …). Returns null if ANY char lacks a single-char token in `tokenSet` (an emoji,
 * a rare unicode) — the caller skips the word rather than emit a partial, unencodable line.
 */
export function spellWord(word: string, tokenSet: ReadonlySet<string>): string[] | null {
  const chars = [...word]
  if (chars.length === 0) return null
  const out: string[] = []
  for (let i = 0; i < chars.length; i++) {
    const tok = i === 0 ? HOTWORD_BOUNDARY + chars[i] : chars[i]
    if (!tokenSet.has(tok)) return null
    out.push(tok)
  }
  return out
}

/**
 * Spell a whole phrase (each word carries its own ▁ boundary). ALL-OR-NOTHING: if any word
 * is unencodable the phrase is dropped (partially biasing a phrase is meaningless). Returns
 * the space-joined token line, or null.
 *   "Terminal Service" → "▁T e r m i n a l ▁S e r v i c e"
 */
export function spellPhrase(phrase: string, tokenSet: ReadonlySet<string>): string | null {
  const words = phrase.split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  const parts: string[] = []
  for (const w of words) {
    const toks = spellWord(w, tokenSet)
    if (!toks) return null
    parts.push(toks.join(" "))
  }
  return parts.join(" ")
}

/**
 * Encode a list of hotword ENTRIES (from {@link deriveHotwords}) into the token-line file
 * body sherpa reads. Unencodable entries are dropped; duplicate token lines collapse. The
 * returned lines ARE the file content (join with "\n").
 */
export function encodeHotwordLines(entries: readonly string[], tokenSet: ReadonlySet<string>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const e of entries) {
    const line = spellPhrase(e, tokenSet)
    if (line && !seen.has(line)) {
      seen.add(line)
      out.push(line)
    }
  }
  return out
}

// ===========================================================================
// THIN FS WRAPPER — the only I/O in this module (called ONLY from runtime.ts).
// Kept here per the "pure core + thin fs wrapper" one-file convention; the pure
// functions above never touch these, so the SttService stays hermetically testable.
// ===========================================================================

/**
 * Load `tokens.txt` into a Set of token strings. Format is `<token> <id>` per line; the
 * token is everything before the LAST space (tokens never contain a space in this model).
 */
export function loadTokenSet(tokensPath: string): Set<string> {
  const set = new Set<string>()
  for (const line of readFileSync(tokensPath, "utf8").split(/\r?\n/)) {
    if (!line) continue
    const sp = line.lastIndexOf(" ")
    if (sp <= 0) continue
    set.add(line.slice(0, sp))
  }
  return set
}

/**
 * Bounded walk of a workspace folder collecting file + dir BASENAMES (depth ≤ maxDepth,
 * ≤ maxEntries total, skipping {@link HOTWORD_SKIP_DIRS} and any dot-prefixed entry).
 * Best-effort: an unreadable dir is silently skipped (a permission error must never break
 * hotword regen). Returns raw basenames — {@link deriveHotwords} does the word splitting.
 */
export function collectWorkspaceNames(
  rootDir: string,
  opts?: { maxDepth?: number; maxEntries?: number; skip?: readonly string[] },
): string[] {
  const maxDepth = opts?.maxDepth ?? 3
  const maxEntries = opts?.maxEntries ?? 500
  const skip = new Set(opts?.skip ?? HOTWORD_SKIP_DIRS)
  const names: string[] = []

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || names.length >= maxEntries) return
    let entries: import("node:fs").Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // unreadable dir — skip
    }
    for (const e of entries) {
      if (names.length >= maxEntries) return
      const name = e.name
      if (name.startsWith(".")) continue // hidden / .git / .claude-tui / .vscode …
      if (e.isDirectory()) {
        if (skip.has(name)) continue
        names.push(name)
        walk(join(dir, name), depth + 1)
      } else if (e.isFile()) {
        names.push(name)
      }
    }
  }
  walk(rootDir, 1)
  return names
}
