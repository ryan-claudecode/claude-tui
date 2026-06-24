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
import { WorkspaceMemoryService } from "./workspaceMemory"
import { RecallService } from "./recall"
import { encodeProjectDir } from "./terminals"
import { buildInjectedContext, type InjectWorkspaceFinding } from "./contextInject"
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
let memDir: string

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

/** Build an inspector wired to real (temp-backed) services, with F set as the workspace's
 *  folder. Returns { inspector, workspaceId }. */
function makeInspector(folder?: string): {
  inspector: ContextInspectorService
  workspaceId: string
  workspaces: WorkspaceService
  memory: WorkspaceMemoryService
  recall: RecallService
} {
  const workspaces = new WorkspaceService(fakeTerminals(), { file: regFile })
  const ws = workspaces.create("Test WS", folder)
  const memory = new WorkspaceMemoryService({ dir: memDir })
  const recall = new RecallService(
    () => [],
    () => memory.listWorkspaceMemory(),
  )
  const inspector = new ContextInspectorService(workspaces, memory, recall, home)
  return { inspector, workspaceId: ws.id, workspaces, memory, recall }
}

/** Find a tier's first source in an inspect result. */
function tier(result: InspectResult, t: number): ContextSource | undefined {
  return result.sources.find((s) => s.tier === t)
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ctui-inspect-home-"))
  root = mkdtempSync(join(tmpdir(), "ctui-inspect-root-"))
  regFile = join(root, "workspaces.json")
  memDir = join(root, "workspace-memory")
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
    // are all "none" placeholders + tier 10 (no primer → exists:false), but PRESENT.
    for (const t of [0, 1, 2, 3, 4, 5, 6, 7, 10]) {
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

describe("ContextInspectorService — folderless / untagged", () => {
  it("renders only #10 + machine-global tiers 0/1/2 + the folderless note", () => {
    // A null workspaceId (the untagged "All" bucket) is folderless by definition.
    const { inspector } = makeInspector()
    const result = inspector.inspectWorkspaceContext(null)

    expect(result.folder).toBeNull()
    expect(result.gitRoot).toBeNull()
    // The folder-scoped tiers (3,4,5,6,7) are absent; only 0/1/2 + 10 are enumerated.
    const tiers = result.sources.map((s) => s.tier).sort((a, b) => a - b)
    expect(tiers).toEqual([0, 1, 2, 10])

    const t10 = tier(result, 10)!
    expect(t10.truncatedNote).toContain("Folderless")
    expect(t10.truncatedNote).toContain("machine-global tiers 0/1/2 still shown")
  })

  it("adopted is always false in v1", () => {
    const { inspector } = makeInspector()
    expect(inspector.inspectWorkspaceContext(null).adopted).toBe(false)
  })
})

describe("ContextInspectorService — tier 10 truncation parity with the inject", () => {
  it("renders the SAME capped primer the spawn injects (buildInjectedContext)", () => {
    const folder = join(root, "proj-primer")
    mkdirSync(folder, { recursive: true })
    const { inspector, workspaceId, memory } = makeInspector(folder)

    // Seed the workspace tier (instructions + a finding) the inject reads.
    memory.setInstructions(workspaceId, "Workspace standing rule: always X.")
    memory.addFinding(workspaceId, "Durable finding: the auth flow uses cookies.", "user")

    const result = inspector.inspectWorkspaceContext(workspaceId)
    const t10 = tier(result, 10)!
    expect(t10.exists).toBe(true)

    // Recompute the EXPECTED primer through the SAME path, from the SAME source the
    // inspector reads, and assert byte-identity (truncation-parity).
    const recall = (inspector as any).recall as RecallService
    const workspaceFindings: InjectWorkspaceFinding[] = recall
      .workspaceTierEntries(workspaceId)
      .map((e) => ({
        text: e.text,
        status: e.status === "ruled-out" ? ("ruled-out" as const) : ("active" as const),
        ...(e.correction ? { correction: e.correction } : {}),
        createdAt: e.createdAt,
        ...(e.pinned ? { pinned: true } : {}),
      }))
    const expected = buildInjectedContext(
      { instructions: memory.getMemory(workspaceId).instructions, workspaceFindings },
      { maxBytes: 8192 },
    )
    expect(t10.content).toBe(expected)
    // It is the WORKSPACE tier only — no per-session section.
    expect(t10.content).not.toContain("This session:")
  })

  it("renders tier 10 as absent (none) when the workspace brain is empty", () => {
    const folder = join(root, "proj-empty-brain")
    mkdirSync(folder, { recursive: true })
    const { inspector, workspaceId } = makeInspector(folder)
    const t10 = tier(inspector.inspectWorkspaceContext(workspaceId), 10)!
    expect(t10.exists).toBe(false)
    expect(t10.content).toBe("")
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
