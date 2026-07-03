import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  splitWords,
  phraseFromSource,
  extractSignificantWords,
  deriveHotwords,
  gatherContextProse,
  spellWord,
  spellPhrase,
  encodeHotwordLines,
  collectWorkspaceNames,
  loadTokenSet,
  MAX_HOTWORDS,
  HOTWORD_BOUNDARY,
} from "./hotwords"

/**
 * CAPP-121 (STT-2) — the pure workspace-vocabulary derivation + the char-level BPE tokenizer.
 * Heavily unit-tested (the fs helpers get a real temp dir). The tokenization RULE these encode
 * (▁ + first char, bare subsequent chars) was pinned by the live spike against the shipped
 * int8 nemo_transducer — see the module header.
 */

// A synthetic token vocab: every ASCII letter as a bare token AND as a ▁-prefixed boundary
// token (exactly the two forms char-level spelling needs). Deliberately NO digits, so a
// word containing a digit is UNENCODABLE — exercising the drop path.
function makeTokenSet(): Set<string> {
  const set = new Set<string>()
  const letters = "abcdefghijklmnopqrstuvwxyz"
  for (const c of letters + letters.toUpperCase()) {
    set.add(c)
    set.add(HOTWORD_BOUNDARY + c)
  }
  return set
}

describe("splitWords / phraseFromSource — identifier splitting", () => {
  it("splits camelCase and PascalCase into words", () => {
    expect(splitWords("TerminalService")).toEqual(["Terminal", "Service"])
    expect(splitWords("workspaceMemory")).toEqual(["workspace", "Memory"])
  })

  it("splits acronym boundaries", () => {
    expect(splitWords("getHTTPResponse")).toEqual(["get", "HTTP", "Response"])
  })

  it("splits snake_case, kebab, dots and brackets", () => {
    expect(splitWords("work_session-service.ts")).toEqual(["work", "session", "service", "ts"])
    expect(splitWords("opus[1m]")).toEqual(["opus", "1m"])
  })

  it("phraseFromSource drops 1-2 char tokens and joins the rest", () => {
    expect(phraseFromSource("TerminalService.tsx")).toBe("Terminal Service tsx")
    expect(phraseFromSource("work_session_service")).toBe("work session service")
    // both words are ≤2 chars -> nothing survives
    expect(phraseFromSource("io_ns")).toBe("")
    // the "1m" fragment is ≤2 chars and is dropped
    expect(phraseFromSource("opus[1m]")).toBe("opus")
  })
})

describe("extractSignificantWords — prose", () => {
  it("keeps capitalized / long / identifier words, drops short function words", () => {
    const out = extractSignificantWords("the TerminalService owns pty and idle state")
    // "the","and","pty","owns","idle" dropped (short/lowercase, no cap/digit, <6 chars)
    expect(out).toContain("Terminal")
    expect(out).toContain("Service")
    expect(out).not.toContain("owns")
    expect(out).not.toContain("the")
    expect(out).not.toContain("and")
  })

  it("keeps a 6+ char lowercase domain word", () => {
    expect(extractSignificantWords("workspace dictation")).toEqual(["workspace", "dictation"])
  })
})

describe("deriveHotwords — folding, dedup, cap, priority", () => {
  it("folds all four sources into phrase entries", () => {
    const out = deriveHotwords({
      extras: ["Widget"],
      terms: ["opus", "--dangerously-skip-permissions"],
      fileNames: ["TerminalService.ts"],
      prose: ["The RecallService indexes findings"],
    })
    expect(out).toContain("Widget")
    expect(out).toContain("opus")
    expect(out).toContain("dangerously skip permissions")
    expect(out).toContain("Terminal Service") // ".ts" (2 chars) is dropped
    expect(out).toContain("Recall")
    expect(out).toContain("Service")
  })

  it("dedupes case-insensitively, first occurrence (and its casing) wins", () => {
    const out = deriveHotwords({ fileNames: ["electron", "Electron", "ELECTRON"] })
    expect(out).toEqual(["electron"])
  })

  it("caps at the requested max, honoring priority order (extras > terms > files > prose)", () => {
    const out = deriveHotwords(
      { extras: ["zeta"], terms: ["alpha"], fileNames: ["middle"], prose: ["Prosetermone Prosetermtwo"] },
      { max: 2 },
    )
    expect(out).toEqual(["zeta", "alpha"])
  })

  it("defaults the cap to MAX_HOTWORDS", () => {
    // A big set of DISTINCT single-word all-lowercase names (each a distinct 3-letter suffix,
    // so nothing collapses under dedup or the ≥3-char word filter).
    const names = Array.from({ length: MAX_HOTWORDS + 50 }, (_, i) => {
      const a = String.fromCharCode(97 + (i % 26))
      const b = String.fromCharCode(97 + (Math.floor(i / 26) % 26))
      const c = String.fromCharCode(97 + (Math.floor(i / 676) % 26))
      return `term${a}${b}${c}`
    })
    const out = deriveHotwords({ fileNames: names })
    expect(out.length).toBe(MAX_HOTWORDS)
  })

  it("empty inputs -> empty vocabulary", () => {
    expect(deriveHotwords({})).toEqual([])
  })
})

describe("gatherContextProse — context-engine prose (review NIT 5)", () => {
  const memories: Record<string, { instructions: string; findings: { text: string }[] }> = {
    "ws-1": { instructions: "ws1 standing rules", findings: [{ text: "WsOneFinding" }] },
    untagged: { instructions: "global standing rules", findings: [{ text: "GlobalFinding" }] },
  }
  const base = {
    // getMemory(null) => the untagged "All" bucket, like WorkspaceMemoryService.
    getMemory: (id: string | null) => memories[id ?? "untagged"],
    listSessions: () => [
      { id: "s1", workspaceId: "ws-1" },
      { id: "s2" }, // an UNTAGGED session
    ],
    getSessionSections: (id: string) =>
      id === "s1"
        ? { summary: "s1 summary", active: [{ text: "S1Finding" }] }
        : { summary: "s2 summary", active: [{ text: "S2Finding" }] },
  }

  it("an active workspace reads ITS bucket + ITS sessions only", () => {
    const prose = gatherContextProse({ ...base, activeWorkspaceId: "ws-1" })
    expect(prose).toEqual(["ws1 standing rules", "WsOneFinding", "s1 summary", "S1Finding"])
  })

  it("NO active workspace reads the UNTAGGED 'All' bucket + untagged sessions", () => {
    const prose = gatherContextProse({ ...base, activeWorkspaceId: null })
    expect(prose).toEqual(["global standing rules", "GlobalFinding", "s2 summary", "S2Finding"])
  })

  it("empty instructions / missing sections contribute nothing (no empty strings)", () => {
    const prose = gatherContextProse({
      activeWorkspaceId: null,
      getMemory: () => ({ instructions: "", findings: [] }),
      listSessions: () => [{ id: "s9" }],
      getSessionSections: () => undefined,
    })
    expect(prose).toEqual([])
  })
})

describe("spellWord / spellPhrase / encodeHotwordLines — char-level tokenizer", () => {
  const set = makeTokenSet()

  it("spells a word: ▁first-char then bare chars", () => {
    expect(spellWord("cat", set)).toEqual([HOTWORD_BOUNDARY + "c", "a", "t"])
    expect(spellWord("Phoebe", set)).toEqual([HOTWORD_BOUNDARY + "P", "h", "o", "e", "b", "e"])
  })

  it("returns null when any char lacks a single-char token (unencodable)", () => {
    // digits are absent from the synthetic vocab
    expect(spellWord("utf8", set)).toBeNull()
    expect(spellWord("", set)).toBeNull()
  })

  it("spells a multi-word phrase with a ▁ boundary per word", () => {
    expect(spellPhrase("Terminal Service", set)).toBe(
      `${HOTWORD_BOUNDARY}T e r m i n a l ${HOTWORD_BOUNDARY}S e r v i c e`,
    )
  })

  it("phrase is all-or-nothing: one unencodable word drops the whole phrase", () => {
    expect(spellPhrase("valid mp3word", set)).toBeNull() // "mp3word" has a digit
  })

  it("encodeHotwordLines drops unencodable entries and collapses duplicate lines", () => {
    const lines = encodeHotwordLines(["cat", "cat", "dog", "utf8"], set)
    expect(lines).toEqual([`${HOTWORD_BOUNDARY}c a t`, `${HOTWORD_BOUNDARY}d o g`])
  })
})

describe("fs wrappers — loadTokenSet + collectWorkspaceNames", () => {
  let root: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "capp121-"))
    // tokens.txt in the sherpa "<token> <id>" format
    writeFileSync(join(root, "tokens.txt"), "<unk> 0\n▁the 1\na 2\n b 3\n", "utf8")
    // a small workspace tree
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src", "TerminalService.tsx"), "x", "utf8")
    writeFileSync(join(root, "README.md"), "x", "utf8")
    // dirs that MUST be skipped
    for (const d of ["node_modules", "dist", ".git"]) {
      mkdirSync(join(root, d))
      writeFileSync(join(root, d, "junk.js"), "x", "utf8")
    }
    // a dotfile (skipped) + a nested dir within skip depth
    writeFileSync(join(root, ".env"), "x", "utf8")
    mkdirSync(join(root, "src", "components"))
    writeFileSync(join(root, "src", "components", "Widget.ts"), "x", "utf8")
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it("loadTokenSet parses <token> <id> lines (token = up to the last space)", () => {
    const set = loadTokenSet(join(root, "tokens.txt"))
    expect(set.has("<unk>")).toBe(true)
    expect(set.has("▁the")).toBe(true)
    expect(set.has("a")).toBe(true)
    // " b 3" -> token is " b" (space before b), and the leading-space form is what we stored
    expect(set.has(" b")).toBe(true)
  })

  it("collectWorkspaceNames returns basenames but skips node_modules/.git/dist and dotfiles", () => {
    const names = collectWorkspaceNames(root)
    expect(names).toContain("src")
    expect(names).toContain("TerminalService.tsx")
    expect(names).toContain("README.md")
    expect(names).toContain("components")
    expect(names).toContain("Widget.ts")
    // skipped
    expect(names).not.toContain("node_modules")
    expect(names).not.toContain("dist")
    expect(names).not.toContain(".git")
    expect(names).not.toContain("junk.js") // never descended into a skipped dir
    expect(names).not.toContain(".env")
  })

  it("respects maxEntries + maxDepth bounds", () => {
    const capped = collectWorkspaceNames(root, { maxEntries: 2 })
    expect(capped.length).toBeLessThanOrEqual(2)
    const shallow = collectWorkspaceNames(root, { maxDepth: 1 })
    // depth 1 sees top-level entries (src, README.md) but NOT nested Widget.ts
    expect(shallow).toContain("src")
    expect(shallow).not.toContain("Widget.ts")
  })

  it("a non-existent root yields [] (never throws)", () => {
    expect(collectWorkspaceNames(join(root, "does-not-exist"))).toEqual([])
  })

  it("end-to-end: derive -> encode a real vocabulary against a token set", () => {
    const set = makeTokenSet()
    const words = deriveHotwords({ fileNames: ["Widget"], terms: ["opus"] })
    const lines = encodeHotwordLines(words, set)
    expect(lines).toContain(`${HOTWORD_BOUNDARY}W i d g e t`)
    expect(lines).toContain(`${HOTWORD_BOUNDARY}o p u s`)
  })
})
