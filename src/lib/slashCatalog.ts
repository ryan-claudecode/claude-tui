/**
 * BO-7 (CAPP-41) — the PURE model behind the structured composer's `/`-command
 * autocomplete picker. Side-effect-free (no React / Electron), so it's the unit
 * seam for the picker the same way agentTranscript.ts is for AgentView.
 *
 * The data is sourced LIVE from the headless `init` event's `slash_commands` +
 * `skills` arrays (see AgentCatalog / streamProtocol.ts), never a hardcoded set —
 * so the picker reflects the user's real skills, plugin skills, built-ins, and
 * custom commands. In this Claude Code version slash commands and skills are a
 * single unified namespace, so the two arrays are merged and de-duplicated.
 */

import type { AgentCatalog } from "../../electron/services/streamProtocol"

export interface CatalogEntry {
  /** The invokable name WITHOUT the leading slash (e.g. "clear", "chrome-live"). */
  name: string
  /** Cosmetic label: skill-backed names render as "skill", the rest as "command". */
  kind: "command" | "skill"
}

function isNonEmptyStr(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

/**
 * Merge a catalog's slash commands + skills into a de-duplicated, alphabetically
 * sorted entry list. A name present in both arrays appears once; a name present in
 * `skills` is labeled "skill" (the more specific of the unified pair), otherwise
 * "command". Tolerant of a null/partial catalog and non-string members.
 */
export function buildCatalogEntries(catalog: AgentCatalog | null | undefined): CatalogEntry[] {
  const skills = (catalog?.skills ?? []).filter(isNonEmptyStr)
  const commands = (catalog?.slashCommands ?? []).filter(isNonEmptyStr)
  const skillSet = new Set(skills)
  const seen = new Map<string, CatalogEntry>()
  for (const name of commands) {
    if (!seen.has(name)) seen.set(name, { name, kind: skillSet.has(name) ? "skill" : "command" })
  }
  for (const name of skills) {
    if (!seen.has(name)) seen.set(name, { name, kind: "skill" })
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Filter entries to those whose name contains `query` (case-insensitive), ranking
 * prefix matches above mid-string matches and then alphabetically. An empty query
 * returns everything (prefix tier is uniform), alphabetically ordered.
 */
export function filterCatalogEntries(entries: CatalogEntry[], query: string): CatalogEntry[] {
  const q = query.toLowerCase()
  return entries
    .filter((e) => e.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1
      const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1
      if (ap !== bp) return ap - bp
      return a.name.localeCompare(b.name)
    })
}

/**
 * Derive the picker's live query from raw composer text, or null when the picker
 * should be hidden. Visible only while the text is a SINGLE in-progress slash
 * token (leading whitespace tolerated, no space yet) — once a space is typed the
 * command name is complete and the user is entering args, so the picker hides.
 *   "/"        → ""      (show all)
 *   "/con"     → "con"
 *   "/clear x" → null    (token complete)
 *   "hello"    → null
 */
export function slashQuery(text: string): string | null {
  const m = /^\s*\/(\S*)$/.exec(text ?? "")
  return m ? m[1] : null
}
