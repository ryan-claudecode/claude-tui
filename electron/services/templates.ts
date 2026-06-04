import type { TerminalService, TerminalInfo } from "./terminals"

export interface SessionTemplate {
  id: string
  label: string
  description?: string
  cwd?: string
  /** Text typed into the new session once Claude has booted. */
  prompt?: string
}

/** How long to wait for Claude to boot before sending a template's prompt. */
const PROMPT_DELAY_MS = 4000

const BUILTIN_TEMPLATES: SessionTemplate[] = [
  {
    id: "code-review",
    label: "Code Review",
    description: "Review the current diff and surface issues",
    prompt:
      "You are doing a code review. Run `git diff` and `git status`, summarize the changes, then flag any bugs, risks, or style issues.",
  },
  {
    id: "debug",
    label: "Debugging",
    description: "Systematically track down a bug",
    prompt:
      "Help me debug an issue. Ask me to describe the bug and expected behavior, then investigate systematically before proposing a fix.",
  },
  {
    id: "frontend",
    label: "Frontend Dev",
    description: "Work on UI with the dev server running",
    prompt:
      "We're working on the frontend UI. Review the component structure and start the dev server so we can verify changes in the browser.",
  },
  {
    id: "plan",
    label: "Planning",
    description: "Plan a feature before writing code",
    prompt:
      "Let's plan a feature. Ask me clarifying questions about requirements and constraints before writing any code.",
  },
]

/**
 * TemplateService — pre-configured session types ("code review", "debugging",
 * etc.) that spawn a session and seed it with a starter prompt. Claude drives
 * this via MCP tools to bootstrap purpose-built sessions in one call.
 */
export class TemplateService {
  private templates = new Map<string, SessionTemplate>()

  constructor(private sessions: TerminalService) {
    for (const t of BUILTIN_TEMPLATES) this.templates.set(t.id, t)
  }

  list(): SessionTemplate[] {
    return Array.from(this.templates.values())
  }

  add(template: SessionTemplate): SessionTemplate {
    this.templates.set(template.id, template)
    return template
  }

  /** Create a session from a template and seed its starter prompt. */
  instantiate(id: string, cwd?: string): TerminalInfo | null {
    const template = this.templates.get(id)
    if (!template) return null

    const info = this.sessions.create(template.label, cwd ?? template.cwd)

    if (template.prompt) {
      // Claude needs a moment to boot before it can accept input.
      setTimeout(() => {
        this.sessions.write(info.id, `${template.prompt}\r`)
      }, PROMPT_DELAY_MS)
    }

    return info
  }
}
