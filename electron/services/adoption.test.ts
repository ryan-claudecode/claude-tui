import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  detectAdoption,
  adoptionScanFiles,
  wireImport,
  unwireImport,
  findImportBlock,
  IMPORT_BLOCK_START,
  IMPORT_BLOCK_END,
  type AdoptionDeps,
} from "./adoption"
import { workspaceMemoryMarker } from "./export"

/**
 * CAPP-100 / E2 — adoption detection + the reversible CLAUDE.local.md insert.
 *
 * Hermetic: temp "workspace folders" + a temp home; NEVER touches a real repo or the real `~`.
 * Pins the load-bearing invariants a reviewer probes: the FRESH per-call marker scan; the
 * default-SAFE rule (unreadable/absent → NOT adopted → inject); marker-for-a-DIFFERENT-id does
 * not count; the change-guard; the CRLF-agnostic idempotent insert; Unwire pristine-vs-refusal.
 */

let root: string
let folder: string
let home: string

function deps(extra: Partial<AdoptionDeps> = {}): AdoptionDeps {
  return {
    resolveFolder: () => folder,
    gitRoot: () => null, // no parent walk by default
    home,
    ...extra,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "adoption-test-"))
  folder = join(root, "repo")
  home = join(root, "home")
  mkdirSync(folder, { recursive: true })
  mkdirSync(join(home, ".claude"), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("adoptionScanFiles", () => {
  it("includes project CLAUDE.md, CLAUDE.local.md, and ~/.claude/CLAUDE.md", () => {
    const files = adoptionScanFiles(folder, null, home)
    expect(files).toContain(join(folder, "CLAUDE.md"))
    expect(files).toContain(join(folder, "CLAUDE.local.md"))
    expect(files).toContain(join(home, ".claude", "CLAUDE.md"))
  })

  it("walks the parent chain bounded at the git root, never above it", () => {
    const child = join(folder, "pkg", "app")
    const gitRoot = folder
    const files = adoptionScanFiles(child, gitRoot, home)
    // F's parent (pkg) + the git root (repo) are in range; nothing ABOVE the root.
    expect(files).toContain(join(folder, "pkg", "CLAUDE.md"))
    expect(files).toContain(join(folder, "CLAUDE.md"))
    // root's PARENT must NOT be scanned (would scan unrelated projects).
    expect(files).not.toContain(join(root, "CLAUDE.md"))
  })

  it("folderless → only ~/.claude/CLAUDE.md", () => {
    const files = adoptionScanFiles(null, null, home)
    expect(files).toEqual([join(home, ".claude", "CLAUDE.md")])
  })
})

describe("detectAdoption — the fresh marker scan", () => {
  const WS = "ws-1"

  it("adopted when THIS workspace's marker is in the project CLAUDE.md", () => {
    writeFileSync(join(folder, "CLAUDE.md"), `# Project\n${workspaceMemoryMarker(WS)}\nmore`, "utf8")
    expect(detectAdoption(WS, deps())).toBe(true)
  })

  it("adopted when the marker is in CLAUDE.local.md", () => {
    writeFileSync(join(folder, "CLAUDE.local.md"), workspaceMemoryMarker(WS), "utf8")
    expect(detectAdoption(WS, deps())).toBe(true)
  })

  it("adopted when the marker is in ~/.claude/CLAUDE.md", () => {
    writeFileSync(join(home, ".claude", "CLAUDE.md"), `x\n${workspaceMemoryMarker(WS)}\n`, "utf8")
    expect(detectAdoption(WS, deps())).toBe(true)
  })

  it("adopted via a parent-chain CLAUDE.md (bounded at git root)", () => {
    const child = join(folder, "pkg")
    mkdirSync(child, { recursive: true })
    writeFileSync(join(folder, "CLAUDE.md"), workspaceMemoryMarker(WS), "utf8")
    const d = deps({ resolveFolder: () => child, gitRoot: () => folder })
    expect(detectAdoption(WS, d)).toBe(true)
  })

  it("NOT adopted when absent (no host file carries the marker)", () => {
    writeFileSync(join(folder, "CLAUDE.md"), "# Project, no import here", "utf8")
    expect(detectAdoption(WS, deps())).toBe(false)
  })

  it("NOT adopted for a DIFFERENT workspace id's marker", () => {
    writeFileSync(join(folder, "CLAUDE.md"), workspaceMemoryMarker("other-ws"), "utf8")
    expect(detectAdoption(WS, deps())).toBe(false)
  })

  it("FRESH each call — a marker added between calls flips false→true", () => {
    const target = join(folder, "CLAUDE.local.md")
    writeFileSync(target, "nothing yet", "utf8")
    expect(detectAdoption(WS, deps())).toBe(false)
    writeFileSync(target, `nothing yet\n${workspaceMemoryMarker(WS)}`, "utf8")
    expect(detectAdoption(WS, deps())).toBe(true)
  })

  it("default-SAFE: an unreadable host file → NOT adopted (so the caller injects)", () => {
    // Simulate an unreadable file by pointing resolveFolder at a path whose CLAUDE.md is a
    // directory (readFileSync throws EISDIR) — the scan must swallow it and return false, not
    // infer adoption from a file it couldn't read.
    mkdirSync(join(folder, "CLAUDE.md"), { recursive: true })
    expect(detectAdoption(WS, deps())).toBe(false)
  })

  it("honors the Mode-C self-wired hint as a fallback only", () => {
    expect(detectAdoption(WS, deps())).toBe(false)
    const d = deps({ selfWiredHint: () => true })
    expect(detectAdoption(WS, d)).toBe(true)
  })

  it("adopted via a MANUAL @import paste matching the export's import line", () => {
    // The user pasted the "Copy line" @import (the marker stays in the EXPORTED file, not the
    // host) — a literal scan matches the advertised import line.
    const importLine = "@./.claude-tui/workspace-memory.md"
    writeFileSync(join(folder, "CLAUDE.local.md"), `# Local\n${importLine}\n`, "utf8")
    const d = deps({ importLine: () => importLine })
    expect(detectAdoption(WS, d)).toBe(true)
    // Without the import-line hint, the bare line is NOT a recognized signal (no marker).
    expect(detectAdoption(WS, deps())).toBe(false)
  })

  it("a wired block matches only when its inner line is THIS workspace's import line", () => {
    const importLine = "@./.claude-tui/workspace-memory.md"
    const block = `${IMPORT_BLOCK_START}\n${importLine}\n${IMPORT_BLOCK_END}`
    writeFileSync(join(folder, "CLAUDE.local.md"), `# Local\n${block}\n`, "utf8")
    expect(detectAdoption(WS, deps({ importLine: () => importLine }))).toBe(true)
    // A block carrying a DIFFERENT workspace's import line does not count for WS.
    const otherBlock = `${IMPORT_BLOCK_START}\n@/some/other/path.md\n${IMPORT_BLOCK_END}`
    writeFileSync(join(folder, "CLAUDE.local.md"), `# Local\n${otherBlock}\n`, "utf8")
    expect(detectAdoption(WS, deps({ importLine: () => importLine }))).toBe(false)
  })

  it("untagged (null workspaceId) scans only ~/.claude/CLAUDE.md, matches the untagged marker", () => {
    const d: AdoptionDeps = { resolveFolder: () => null, home }
    writeFileSync(join(home, ".claude", "CLAUDE.md"), workspaceMemoryMarker("__untagged__"), "utf8")
    expect(detectAdoption(null, d)).toBe(true)
  })

  it("a RELATIVE import line in a SHARED host file does NOT false-positive a different workspace", () => {
    // The Mode-A import line is the SAME for every workspace (`@./.claude-tui/workspace-memory.md`).
    // If workspace A's "Copy line" is pasted into a SHARED file (the git-root/global CLAUDE.md),
    // workspace B (whose folder is a sibling) MUST NOT be considered adopted — else B's inject
    // silently drops B's workspace tier (the worse §E failure).
    const sharedImport = "@./.claude-tui/workspace-memory.md"
    // Lay out a git root with the relative import in the ROOT CLAUDE.md (shared), and B under it.
    const gitRoot = folder
    const bFolder = join(folder, "pkg-b")
    mkdirSync(bFolder, { recursive: true })
    writeFileSync(join(gitRoot, "CLAUDE.md"), `# Monorepo root\n${sharedImport}\n`, "utf8")
    const dB = deps({ resolveFolder: () => bFolder, gitRoot: () => gitRoot, importLine: () => sharedImport })
    // The relative import lives in the shared root file, not B's own → B is NOT adopted.
    expect(detectAdoption("ws-b", dB)).toBe(false)

    // …but the SAME relative line in B's OWN CLAUDE.local.md DOES count (non-regression).
    writeFileSync(join(bFolder, "CLAUDE.local.md"), `# B local\n${sharedImport}\n`, "utf8")
    expect(detectAdoption("ws-b", dB)).toBe(true)
  })

  it("an ABSOLUTE (self-identifying) import line still matches in a shared/global host file", () => {
    // A Mode-C absolute path embeds the workspace id, so it self-identifies and may match anywhere.
    const absImport = "@~/.claude-tui/exports/ws-1/workspace-memory.md"
    writeFileSync(join(home, ".claude", "CLAUDE.md"), `# global\n${absImport}\n`, "utf8")
    expect(detectAdoption(WS, deps({ importLine: () => absImport }))).toBe(true)
  })
})

describe("wireImport / unwireImport — reversible CLAUDE.local.md insert", () => {
  const LINE = "@./.claude-tui/workspace-memory.md"
  let host: string

  beforeEach(() => {
    host = join(folder, "CLAUDE.local.md")
  })

  it("appends a delimited block (creates the file if absent)", () => {
    const res = wireImport({ hostFile: host, importLine: LINE })
    expect(res.ok).toBe(true)
    expect(res.status).toBe("wired")
    const text = readFileSync(host, "utf8")
    expect(text).toContain(IMPORT_BLOCK_START)
    expect(text).toContain(LINE)
    expect(text).toContain(IMPORT_BLOCK_END)
    expect(findImportBlock(text)).not.toBeNull()
  })

  it("double-run → exactly ONE block (idempotent)", () => {
    wireImport({ hostFile: host, importLine: LINE })
    const second = wireImport({ hostFile: host, importLine: LINE })
    expect(second.status).toBe("already")
    const text = readFileSync(host, "utf8")
    const starts = text.split(IMPORT_BLOCK_START).length - 1
    expect(starts).toBe(1)
  })

  it("CRLF file → no duplicate block, EOL preserved", () => {
    writeFileSync(host, "# Local\r\nsome line\r\n", "utf8")
    const first = wireImport({ hostFile: host, importLine: LINE })
    expect(first.status).toBe("wired")
    const text = readFileSync(host, "utf8")
    expect(text).toContain("\r\n") // CRLF preserved
    expect(text).not.toContain("\n\n\r") // no stray mixed terminator garbling
    // Re-run is idempotent even though the file is CRLF.
    const second = wireImport({ hostFile: host, importLine: LINE })
    expect(second.status).toBe("already")
    expect((readFileSync(host, "utf8").split(IMPORT_BLOCK_START).length - 1)).toBe(1)
  })

  it("change-guard aborts when the file changed since the pre-image was captured", () => {
    writeFileSync(host, "original", "utf8")
    // The UI captured "original" but the user edited it to "edited" before the write.
    writeFileSync(host, "edited by the user", "utf8")
    const res = wireImport({ hostFile: host, importLine: LINE, expectedPreImage: "original" })
    expect(res.ok).toBe(false)
    expect(res.status).toBe("refused")
    // The file was NOT touched.
    expect(readFileSync(host, "utf8")).toBe("edited by the user")
  })

  it("Unwire removes a pristine block", () => {
    writeFileSync(host, "# Local\nkeep me\n", "utf8")
    wireImport({ hostFile: host, importLine: LINE })
    const res = unwireImport({ hostFile: host, importLine: LINE })
    expect(res.ok).toBe(true)
    expect(res.status).toBe("removed")
    const text = readFileSync(host, "utf8")
    expect(text).not.toContain(IMPORT_BLOCK_START)
    expect(text).toContain("keep me") // surrounding content preserved
  })

  it("Unwire REFUSES when the user hand-edited inside our delimiters", () => {
    wireImport({ hostFile: host, importLine: LINE })
    // The user edits inside the block.
    const tampered = readFileSync(host, "utf8").replace(
      LINE,
      `${LINE}\n@./extra-thing-the-user-added.md`,
    )
    writeFileSync(host, tampered, "utf8")
    const res = unwireImport({ hostFile: host, importLine: LINE })
    expect(res.ok).toBe(false)
    expect(res.status).toBe("refused")
    // The block is still there (no-op).
    expect(readFileSync(host, "utf8")).toContain("extra-thing-the-user-added")
  })

  it("Unwire on a file with no block → absent (no-op)", () => {
    writeFileSync(host, "# Local, nothing of ours", "utf8")
    const res = unwireImport({ hostFile: host, importLine: LINE })
    expect(res.status).toBe("absent")
  })

  it("wire → unwire round-trips back to the original content", () => {
    const original = "# Local\nline one\nline two\n"
    writeFileSync(host, original, "utf8")
    wireImport({ hostFile: host, importLine: LINE })
    expect(existsSync(host)).toBe(true)
    const removed = unwireImport({ hostFile: host, importLine: LINE })
    expect(removed.status).toBe("removed")
    const after = readFileSync(host, "utf8")
    expect(after).not.toContain(IMPORT_BLOCK_START)
    expect(after).toContain("line one")
    expect(after).toContain("line two")
  })

  it("a DANGLING half-block (START, no END) → wire REFUSES (never appends a duplicate)", () => {
    // The user hand-deleted our END delimiter, leaving an orphan START.
    writeFileSync(host, `# Local\n${IMPORT_BLOCK_START}\n${LINE}\n`, "utf8")
    const res = wireImport({ hostFile: host, importLine: LINE })
    expect(res.ok).toBe(false)
    expect(res.status).toBe("refused")
    // No second START was appended.
    const after = readFileSync(host, "utf8")
    expect(after.split(IMPORT_BLOCK_START).length - 1).toBe(1)
  })

  it("a DANGLING half-block (START, no END) → unwire REFUSES (manual fix)", () => {
    writeFileSync(host, `# Local\n${IMPORT_BLOCK_START}\n${LINE}\n`, "utf8")
    const res = unwireImport({ hostFile: host, importLine: LINE })
    expect(res.ok).toBe(false)
    expect(res.status).toBe("refused")
    // The orphan START is left for the user to fix manually (never silently dropped).
    expect(readFileSync(host, "utf8")).toContain(IMPORT_BLOCK_START)
  })
})
