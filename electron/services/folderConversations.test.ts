import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { encodeProjectDir } from "./terminals"
import {
  listFolderConversations,
  previewText,
  firstUserMessageFromLine,
  MAX_FOLDER_CONVERSATIONS,
} from "./folderConversations"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ctui-folderconv-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Write a transcript .jsonl into <root>/<encoded(folder)>/<id>.jsonl with the
 *  given lines, then stamp its mtime so recency sorting is deterministic. */
function writeTranscript(folder: string, id: string, lines: object[], mtimeMs: number) {
  const dir = join(root, encodeProjectDir(folder))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
  const t = mtimeMs / 1000
  utimesSync(file, t, t)
}

const FOLDER = "C:\\Users\\ryguy\\projects\\foo"

describe("encodeProjectDir (the reused encoding)", () => {
  it("maps a known cwd to the known dir name (separators + drive colon → '-')", () => {
    expect(encodeProjectDir("C:\\Users\\ryguy\\projects\\foo")).toBe(
      "C--Users-ryguy-projects-foo",
    )
    expect(encodeProjectDir("/home/me/app")).toBe("-home-me-app")
  })
})

describe("previewText", () => {
  it("collapses whitespace, trims, and caps to ~80 chars with an ellipsis", () => {
    expect(previewText("  hello   \n  world  ")).toBe("hello world")
    const long = "a".repeat(200)
    const out = previewText(long)
    expect(out.length).toBe(80)
    expect(out.endsWith("…")).toBe(true)
  })
})

describe("firstUserMessageFromLine", () => {
  it("reads a string-content user message", () => {
    expect(
      firstUserMessageFromLine(JSON.stringify({ type: "user", message: { content: "hi there" } })),
    ).toBe("hi there")
  })
  it("reads a text block from an array-content user message", () => {
    expect(
      firstUserMessageFromLine(
        JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "from array" }] } }),
      ),
    ).toBe("from array")
  })
  it("skips a tool_result-only user message, assistant lines, sidechain, and meta", () => {
    expect(
      firstUserMessageFromLine(
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } }),
      ),
    ).toBeUndefined()
    expect(firstUserMessageFromLine(JSON.stringify({ type: "assistant", message: {} }))).toBeUndefined()
    expect(
      firstUserMessageFromLine(JSON.stringify({ type: "user", isSidechain: true, message: { content: "x" } })),
    ).toBeUndefined()
    expect(
      firstUserMessageFromLine(JSON.stringify({ type: "user", isMeta: true, message: { content: "x" } })),
    ).toBeUndefined()
  })
  it("never throws on garbage / partial JSON", () => {
    expect(firstUserMessageFromLine("{not json")).toBeUndefined()
    expect(firstUserMessageFromLine("")).toBeUndefined()
  })
})

describe("listFolderConversations", () => {
  it("parses id + mtime + preview for each transcript", () => {
    writeTranscript(
      FOLDER,
      "aaaa-1111",
      [
        { type: "queue-operation", operation: "enqueue" },
        { type: "user", message: { content: "first prompt here" } },
        { type: "assistant", message: { content: [{ type: "text", text: "reply" }] } },
      ],
      5000,
    )
    const out = listFolderConversations(root, FOLDER)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe("aaaa-1111")
    expect(out[0].updatedAt).toBe(5000)
    expect(out[0].preview).toBe("first prompt here")
  })

  it("sorts by recency (updatedAt DESC)", () => {
    writeTranscript(FOLDER, "old", [{ type: "user", message: { content: "old one" } }], 1000)
    writeTranscript(FOLDER, "new", [{ type: "user", message: { content: "new one" } }], 9000)
    writeTranscript(FOLDER, "mid", [{ type: "user", message: { content: "mid one" } }], 5000)
    const out = listFolderConversations(root, FOLDER)
    expect(out.map((c) => c.id)).toEqual(["new", "mid", "old"])
  })

  it("returns [] for a folder with no project dir", () => {
    expect(listFolderConversations(root, "C:\\nope\\missing")).toEqual([])
  })

  it("returns [] for a blank folder", () => {
    expect(listFolderConversations(root, "")).toEqual([])
    expect(listFolderConversations(root, "   ")).toEqual([])
  })

  it("keeps a transcript with no readable user message (empty preview, still resumable)", () => {
    writeTranscript(FOLDER, "no-user", [{ type: "queue-operation" }, { type: "system", x: 1 }], 3000)
    const out = listFolderConversations(root, FOLDER)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe("no-user")
    expect(out[0].preview).toBe("")
  })

  it("tolerates a file with a corrupt last line (preview from the good user line)", () => {
    const dir = join(root, encodeProjectDir(FOLDER))
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "partial.jsonl"),
      JSON.stringify({ type: "user", message: { content: "good prompt" } }) + "\n{partial json",
    )
    const out = listFolderConversations(root, FOLDER)
    expect(out).toHaveLength(1)
    expect(out[0].preview).toBe("good prompt")
  })

  it("ignores non-.jsonl files in the dir", () => {
    const dir = join(root, encodeProjectDir(FOLDER))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "notes.txt"), "ignore me")
    writeTranscript(FOLDER, "real", [{ type: "user", message: { content: "real" } }], 4000)
    const out = listFolderConversations(root, FOLDER)
    expect(out.map((c) => c.id)).toEqual(["real"])
  })

  it("caps to the MAX_FOLDER_CONVERSATIONS most recent and reports truncation", () => {
    for (let i = 0; i < MAX_FOLDER_CONVERSATIONS + 10; i++) {
      writeTranscript(FOLDER, `c-${i}`, [{ type: "user", message: { content: `p${i}` } }], 1000 + i)
    }
    let reported: { total: number; kept: number } | null = null
    const out = listFolderConversations(root, FOLDER, (total, kept) => {
      reported = { total, kept }
    })
    expect(out).toHaveLength(MAX_FOLDER_CONVERSATIONS)
    // newest-first: the highest-index (latest mtime) survives the cap.
    expect(out[0].id).toBe(`c-${MAX_FOLDER_CONVERSATIONS + 9}`)
    expect(reported).toEqual({ total: MAX_FOLDER_CONVERSATIONS + 10, kept: MAX_FOLDER_CONVERSATIONS })
  })
})
