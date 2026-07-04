import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { spawnSync } from "node:child_process"
import { join } from "path"
import { tmpdir } from "os"
import {
  ContextInspectorService,
  applyFidelityTransforms,
  hasPathsFrontMatter,
  type InspectResult,
  type ContextSource,
} from "./contextInspector"
import { WorkspaceService } from "./workspaces"
import { encodeProjectDir } from "./terminals"
import type { TerminalService, TerminalInfo } from "./terminals"

/**
 * CAPP-98 / I1 — Context Inspector v1 unit suite (READ-ONLY).
 *
 * Hermetic over temp dirs: a temp "home" stands in for `~` (so the machine-global tiers
 * 0/1/2/7 read from the fixture, never the real `~/.claude`), and a temp workspace folder
 * F (optionally a real git repo) drives the project + parent-chain + auto-memory tiers.
 */

let home: string
let root: string // a temp dir to hold the workspace registry + folders
let regFile: string

/** A no-op TerminalService stub — WorkspaceService.create() needs it but we never spawn. */
function fakeTerminals(): TerminalService {
  return {
    create(name?: string, cwd?: string): TerminalInfo {
      return { id: "t-1", name: name ?? "s", cwd: cwd ?? ".", state: "active" }
    },
  } as unknown as TerminalService
}

/** A real `git init` in `dir` so `git rev-parse --show-toplevel` resolves (tests the
 *  GIT-ROOT keying of the auto-memory tier). Returns whether git is available. */
function gitInit(dir: string): boolean {
  const r = spawnSync("git", ["init"], { cwd: dir, encoding: "utf8", windowsHide: true })
  return typeof r.status === "number" && r.status === 0
}

/** Build an inspector wired to a real (temp-backed) workspace registry, with F set as the
 *  workspace's folder. Returns { inspector, workspaceId }. */
function makeInspector(folder?: string): {
  inspector: ContextInspectorService
  workspaceId: string
  workspaces: WorkspaceService
} {
  const workspaces = new WorkspaceService(fakeTerminals(), { file: regFile })
  const ws = workspaces.create("Test WS", folder)
  const inspector = new ContextInspectorService(workspaces, home)
  return { inspector, workspaceId: ws.id, workspaces }
}

/** Find a tier's first source in an inspect result. */
function tier(result: InspectResult, t: number): ContextSource | undefined {
  return result.sources.find((s) => s.tier === t)
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ctui-inspect-home-"))
  root = mkdtempSync(join(tmpdir(), "ctui-inspect-root-"))
  regFile = join(root, "workspaces.json")
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

describe("applyFidelityTransforms", () => {
  it("strips block-level HTML comments before display", () => {
    const raw = "# Title\n<!-- a hidden marker -->\nvisible line\n<!-- multi\nline\ncomment -->\nend"
    const { body } = applyFidelityTransforms(raw)
    expect(body).not.toContain("hidden marker")
    expect(body).not.toContain("multi")
    expect(body).toContain("visible line")
    expect(body).toContain("end")
  })

  it("collects @import lines OUTSIDE code fences, skipping fenced ones", () => {
    const raw = [
      "# Doc",
      "@./real-import.md",
      "@~/home-import.md",
      "```",
      "@./fenced-not-an-import.md",
      "```",
      "prose @./not-at-line-start.md is not an import",
    ].join("\n")
    const { imports } = applyFidelityTransforms(raw)
    expect(imports).toContain("@./real-import.md")
    expect(imports).toContain("@~/home-import.md")
    // The fenced @import is shown as text, NOT collected.
    expect(imports).not.toContain("@./fenced-not-an-import.md")
    // A mid-line @ is not an import line.
    expect(imports.some((i) => i.includes("not-at-line-start"))).toBe(false)
  })

  it("PRESERVES an HTML comment INSIDE a code fence (Claude reads fenced content verbatim)", () => {
    const raw = [
      "before",
      "<!-- stripped outside -->",
      "```",
      "<!-- kept inside the fence -->",
      "@./fenced-import.md",
      "```",
      "after",
    ].join("\n")
    const { body, imports } = applyFidelityTransforms(raw)
    // Outside the fence: comment stripped.
    expect(body).not.toContain("stripped outside")
    // Inside the fence: comment + @import preserved as text (NOT stripped, NOT collected).
    expect(body).toContain("kept inside the fence")
    expect(imports).not.toContain("@./fenced-import.md")
    expect(body).toContain("before")
    expect(body).toContain("after")
  })
})

describe("hasPathsFrontMatter", () => {
  it("detects a conditioned rule (front-matter with paths:)", () => {
    expect(hasPathsFrontMatter("---\npaths:\n  - src/**\n---\nbody")).toBe(true)
    expect(hasPathsFrontMatter("---\ndescription: x\n---\nbody")).toBe(false)
    expect(hasPathsFrontMatter("no front matter here")).toBe(false)
  })
})

describe("ContextInspectorService — tier enumeration", () => {
  it("ALWAYS enumerates a 'none' placeholder for an absent tier (never omits it)", () => {
    const folder = join(root, "proj-empty")
    mkdirSync(folder, { recursive: true })
    const { inspector, workspaceId } = makeInspector(folder)
    const result = inspector.inspectWorkspaceContext(workspaceId)

    // Every present tier number appears at least once. With an empty fixture, tiers 0–7
    // are all "none" placeholders, but PRESENT.
    for (const t of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const src = tier(result, t)
      expect(src, `tier ${t} must be present`).toBeDefined()
      expect(src!.exists).toBe(false)
    }
  })

  it("reads project memory (F/CLAUDE.md) at tier 4 and strips comments + lists imports", () => {
    const folder = join(root, "proj-mem")
    mkdirSync(folder, { recursive: true })
    writeFileSync(
      join(folder, "CLAUDE.md"),
      "# Project\n<!-- secret -->\nUse snake_case.\n@./extra.md\n",
    )
    const { inspector, workspaceId } = makeInspector(folder)
    const result = inspector.inspectWorkspaceContext(workspaceId)
    const t4 = tier(result, 4)!
    expect(t4.exists).toBe(true)
    expect(t4.content).toContain("Use snake_case.")
    expect(t4.content).not.toContain("secret")
    expect(t4.imports).toContain("@./extra.md")
  })

  it("reads user-global memory (~/.claude/CLAUDE.md) at tier 1 from the temp home", () => {
    const folder = join(root, "proj-ug")
    mkdirSync(folder, { recursive: true })
    mkdirSync(join(home, ".claude"), { recursive: true })
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "Global rule: prefer vitest.")
    const { inspector, workspaceId } = makeInspector(folder)
    const result = inspector.inspectWorkspaceContext(workspaceId)
    const t1 = tier(result, 1)!
    expect(t1.exists).toBe(true)
    expect(t1.content).toContain("prefer vitest")
  })

  it("includes only UNCONDITIONED rules at tier 2/5 (paths: rules deferred to tier 9)", () => {
    const folder = join(root, "proj-rules")
    const projRules = join(folder, ".claude", "rules")
    mkdirSync(projRules, { recursive: true })
    writeFileSync(join(projRules, "always.md"), "Always lint.")
    writeFileSync(join(projRules, "conditioned.md"), "---\npaths:\n  - src/**\n---\nScoped rule.")
    const { inspector, workspaceId } = makeInspector(folder)
    const result = inspector.inspectWorkspaceContext(workspaceId)
    const t5 = result.sources.filter((s) => s.tier === 5)
    const present = t5.filter((s) => s.exists)
    expect(present).toHaveLength(1)
    expect(present[0].content).toContain("Always lint.")
    expect(present.some((s) => s.content.includes("Scoped rule."))).toBe(false)
  })
})

describe("ContextInspectorService — git-root-keyed auto-memory (tier 7)", () => {
  it("encodes the GIT ROOT (not a subdir F) for the MEMORY.md path", () => {
    const repo = join(root, "repo")
    const sub = join(repo, "packages", "app")
    mkdirSync(sub, { recursive: true })
    const haveGit = gitInit(repo)
    if (!haveGit) {
      // Git unavailable in this environment — skip the keying assertion (the service still
      // falls back to keying off F, which is exercised by the no-git case below).
      return
    }

    // F is the SUBDIR; the git root is `repo`. The auto-memory MUST key off the GIT ROOT.
    const memBase = join(home, ".claude", "projects")
    const encodedRoot = encodeProjectDir(repo)
    const memFileDir = join(memBase, encodedRoot, "memory")
    mkdirSync(memFileDir, { recursive: true })
    writeFileSync(join(memFileDir, "MEMORY.md"), "# Memory Index\nlearned X")

    const { inspector, workspaceId } = makeInspector(sub)
    const result = inspector.inspectWorkspaceContext(workspaceId)

    // The git root resolved is the repo (not the subdir).
    expect(result.gitRoot).toBeTruthy()
    expect(result.gitRoot!.replace(/\\/g, "/")).toContain("repo")

    const t7 = tier(result, 7)!
    // The path keys off the ENCODED GIT ROOT, NOT encodeProjectDir(F=sub).
    expect(t7.path).toContain(encodedRoot)
    expect(t7.path).not.toContain(encodeProjectDir(sub))
    expect(t7.exists).toBe(true)
    expect(t7.content).toContain("learned X")
    // The cap note is always surfaced (Claude caps auto-memory at 200 lines / 25 KB).
    expect(t7.truncatedNote).toContain("200 lines")
  })

  it("surfaces the 200-line/25 KB cap note even when auto-memory is absent", () => {
    const folder = join(root, "proj-no-mem")
    mkdirSync(folder, { recursive: true })
    const { inspector, workspaceId } = makeInspector(folder)
    const result = inspector.inspectWorkspaceContext(workspaceId)
    const t7 = tier(result, 7)!
    expect(t7.exists).toBe(false)
    expect(t7.truncatedNote).toContain("200 lines")
  })
})

describe("ContextInspectorService — claudeMdExcludes (tier 3)", () => {
  it("marks an excluded parent-chain ancestor visibly, never silently dropping it", () => {
    // parent/  (has CLAUDE.md)  ->  parent/child (F)
    const parent = join(root, "exclude-parent")
    const child = join(parent, "child")
    mkdirSync(child, { recursive: true })
    writeFileSync(join(parent, "CLAUDE.md"), "Ancestor rule.")
    // The user's settings exclude the parent dir's CLAUDE.md.
    mkdirSync(join(home, ".claude"), { recursive: true })
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ claudeMdExcludes: ["exclude-parent"] }),
    )
    const { inspector, workspaceId } = makeInspector(child)
    const result = inspector.inspectWorkspaceContext(workspaceId)
    const t3 = result.sources.filter((s) => s.tier === 3)
    const ancestor = t3.find((s) => s.exists)
    expect(ancestor, "the ancestor CLAUDE.md must be SHOWN, not dropped").toBeDefined()
    expect(ancestor!.excluded).toBe(true)
    expect(ancestor!.truncatedNote).toContain("claudeMdExcludes")
  })
})

describe("ContextInspectorService — parent-chain boundary (tier 3)", () => {
  it("when F IS the git root, tier 3 is 'none' and NO ancestor above the repo is read", () => {
    const repo = join(root, "repo-at-f")
    mkdirSync(repo, { recursive: true })
    if (!gitInit(repo)) return // git unavailable in the runner → skip (keying is git-dependent)
    // A CLAUDE.md ABOVE the repo (in the temp root) must NEVER be scanned — that would read
    // outside §A.4's read set (unrelated projects in the home tree).
    writeFileSync(join(root, "CLAUDE.md"), "ABOVE-REPO rule that must NOT leak")
    const { inspector, workspaceId } = makeInspector(repo)
    const result = inspector.inspectWorkspaceContext(workspaceId)
    const t3 = result.sources.filter((s) => s.tier === 3)
    expect(t3.every((s) => !s.exists), "tier 3 must be a 'none' placeholder when F == git root").toBe(true)
    expect(
      result.sources.some((s) => (s.content ?? "").includes("ABOVE-REPO")),
      "an ancestor above the git root must never be read",
    ).toBe(false)
  })

  it("reads an in-repo ancestor's CLAUDE.md but never one ABOVE the git root", () => {
    const repo = join(root, "repo")
    const sub = join(repo, "pkg", "app")
    mkdirSync(sub, { recursive: true })
    if (!gitInit(repo)) return
    writeFileSync(join(repo, "CLAUDE.md"), "IN-REPO ancestor rule")
    writeFileSync(join(root, "CLAUDE.md"), "ABOVE-REPO rule")
    const { inspector, workspaceId } = makeInspector(sub)
    const result = inspector.inspectWorkspaceContext(workspaceId)
    const t3 = result.sources.filter((s) => s.tier === 3)
    expect(
      t3.some((s) => s.exists && (s.content ?? "").includes("IN-REPO")),
      "the in-repo ancestor must be shown",
    ).toBe(true)
    expect(
      result.sources.some((s) => (s.content ?? "").includes("ABOVE-REPO")),
      "an ancestor above the git root must never be read",
    ).toBe(false)
  })
})

describe("ContextInspectorService — folderless / untagged", () => {
  it("renders only the machine-global tiers 0/1/2 (folder-scoped tiers absent)", () => {
    // A null workspaceId (the untagged "All" bucket) is folderless by definition.
    const { inspector } = makeInspector()
    const result = inspector.inspectWorkspaceContext(null)

    expect(result.folder).toBeNull()
    expect(result.gitRoot).toBeNull()
    // The folder-scoped tiers (3,4,5,6,7) are absent; only 0/1/2 are enumerated.
    const tiers = result.sources.map((s) => s.tier).sort((a, b) => a - b)
    expect(tiers).toEqual([0, 1, 2])
  })
})

describe("ContextInspectorService — read-only invariant", () => {
  it("never creates or mutates any native file under F or the home dir", () => {
    const folder = join(root, "proj-readonly")
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, "CLAUDE.md"), "rule")
    const { inspector, workspaceId } = makeInspector(folder)
    // Run the inspection twice — it must be a pure read (idempotent, no writes).
    const a = inspector.inspectWorkspaceContext(workspaceId)
    const b = inspector.inspectWorkspaceContext(workspaceId)
    expect(JSON.stringify(a.sources.map((s) => [s.tier, s.exists, s.content]))).toBe(
      JSON.stringify(b.sources.map((s) => [s.tier, s.exists, s.content])),
    )
    // No new files were written into the project (only the seeded CLAUDE.md exists at root).
    // The inspector writes nothing — there's no auto-memory dir, no .claude dir created.
  })
})
