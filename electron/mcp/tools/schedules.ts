import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { SchedulerService, ScheduleInput, ScheduleUpdate } from "../../services/scheduler"
import type { WorkspaceService } from "../../services/workspaces"
import type { SessionService } from "../../services/sessions"
import type { TerminalIdentity } from "./shared"

/**
 * CAPP-114 (SCHED-1) — the MCP surface for the on-device scheduler. This is the
 * "hey, watch X for me every 20 minutes" path: the agent authors a schedule and it
 * runs headless on this machine at the set times (with the local filesystem, git,
 * gh, and the user's auth — the whole point of on-device vs cloud scheduling).
 *
 * IDENTITY-BINDING (matches the workspace-memory tools): `workspace_id` defaults to
 * the CALLER's OWNING session's workspace (`workSessions.get(identity.sessionId)?.
 * workspaceId`) — NEVER the global active selection. An explicit `workspace_id` is
 * validated against the registry and an unknown id is rejected. Undefined workspace
 * → the untagged "All" bucket. Every schedule is visible in the sidebar the moment
 * it exists (no invisible recurring agents — a deliberate policy).
 */

const recurrenceSchema = z.union([
  z.object({
    kind: z.literal("interval"),
    everyMinutes: z.number().int().min(1).describe("Fire every N minutes (anchored to the last fire)"),
    window: z
      .object({ start: z.string().describe("HH:mm local"), end: z.string().describe("HH:mm local, inclusive") })
      .optional()
      .describe("Only fire within this local time-of-day window; a fire outside it rolls to the next window start. start > end (e.g. 22:00–06:00) is a wrap-around, midnight-straddling window"),
    days: z.array(z.number().int().min(0).max(6)).optional().describe("Allowed weekdays (0=Sun..6=Sat); absent = every day"),
  }),
  z.object({
    kind: z.literal("daily"),
    at: z.string().describe("HH:mm local time to fire each day"),
    days: z.array(z.number().int().min(0).max(6)).optional().describe("Allowed weekdays (0=Sun..6=Sat); absent = every day"),
  }),
  z.object({
    kind: z.literal("once"),
    at: z.string().describe("ISO datetime to fire once, then the schedule is exhausted"),
  }),
])

export function registerScheduleTools(
  server: McpServer,
  scheduler: SchedulerService,
  workspaces: WorkspaceService,
  // The caller's bound work session resolves the default workspace for a new schedule.
  workSessions: SessionService,
  identity: TerminalIdentity = {},
) {
  const json = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  })
  const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] })
  const isKnownWorkspace = (id: string): boolean => workspaces.list().some((w) => w.id === id)

  server.tool(
    "schedule_create",
    "Create an ON-DEVICE scheduled Claude run — recurring (interval or daily) or one-shot. At each fire time the app spawns a headless Claude run seeded with your prompt, on THIS machine (local filesystem, git, gh, the user's auth). Use this for 'watch X every N minutes and act on a hit' style automation. recurrence is one of: {kind:'interval', everyMinutes, window?{start,end}, days?}, {kind:'daily', at:'HH:mm', days?}, or {kind:'once', at:ISO}. By default the run is scoped to YOUR bound session's workspace (spawns in its folder); pass workspace_id to target another. The schedule is visible in the sidebar the moment it exists. Returns the created schedule.",
    {
      name: z.string().describe("Display name, e.g. 'Fable watch'"),
      prompt: z.string().describe("The prompt seeded into each scheduled run"),
      recurrence: recurrenceSchema,
      workspace_id: z.string().optional().describe("Workspace to scope the run to (default: your bound session's workspace). Rejected if unknown."),
      cwd: z.string().optional().describe("Absolute spawn dir (default: the workspace folder, else home)"),
      model: z.string().optional().describe("Model alias for the run (default: config default)"),
      effort: z.string().optional().describe("Reasoning effort level for the run (default: config default)"),
      ultracode: z.boolean().optional().describe("Run with ultracode ON (xhigh reasoning)"),
      catch_up: z.boolean().optional().describe("If a fire was missed while the app was closed, run ONCE at launch (default false)"),
      keep_terminal: z.boolean().optional().describe("Keep the run terminal open after it finishes (default false = retire it, keep the session)"),
      max_runtime_ms: z.number().int().min(1000).optional().describe("Kill a run that exceeds this many ms (default 30 min)"),
      enabled: z.boolean().optional().describe("Whether the schedule is active (default true)"),
    },
    async (args) => {
      if (args.workspace_id !== undefined && !isKnownWorkspace(args.workspace_id)) {
        return text(`Workspace not found: ${args.workspace_id}`)
      }
      // NEVER fall back to the global active selection — resolve the caller's own workspace.
      const workspaceId = args.workspace_id ?? workSessions.get(identity.sessionId ?? "")?.workspaceId ?? undefined
      const input: ScheduleInput = {
        name: args.name,
        prompt: args.prompt,
        recurrence: args.recurrence,
        workspaceId,
        cwd: args.cwd,
        model: args.model,
        effort: args.effort,
        ultracode: args.ultracode,
        catchUp: args.catch_up,
        keepTerminal: args.keep_terminal,
        maxRuntimeMs: args.max_runtime_ms,
        enabled: args.enabled,
      }
      return json(scheduler.create(input))
    },
  )

  server.tool(
    "schedule_list",
    "List all on-device scheduled Claude runs (newest-created first), each with its recurrence, enabled state, next run time, and recent run history.",
    {},
    async () => json(scheduler.list()),
  )

  server.tool(
    "schedule_update",
    "Update a scheduled run by id — including enabling/disabling it (pass enabled). Only the fields you pass change; a changed recurrence (or re-enabling) re-derives the next run time. For the string overrides (cwd/model/effort) passing an empty string CLEARS the override back to the default. Returns the updated schedule, or an error if the id is unknown.",
    {
      id: z.string().describe("Schedule id from schedule_list"),
      name: z.string().optional(),
      prompt: z.string().optional(),
      recurrence: recurrenceSchema.optional(),
      enabled: z.boolean().optional().describe("Enable (true) or disable/pause (false) the schedule"),
      workspace_id: z.string().optional().describe("Re-scope the run's workspace. Rejected if unknown."),
      cwd: z.string().optional().describe("New spawn dir; pass an empty string to CLEAR the override (falls back to the workspace folder, then home)"),
      model: z.string().optional().describe("New model alias; pass an empty string to CLEAR the override (falls back to the config default)"),
      effort: z.string().optional().describe("New effort level; pass an empty string to CLEAR the override (falls back to the config default)"),
      ultracode: z.boolean().optional(),
      catch_up: z.boolean().optional(),
      keep_terminal: z.boolean().optional(),
      max_runtime_ms: z.number().int().min(1000).optional(),
    },
    async (args) => {
      if (args.workspace_id !== undefined && !isKnownWorkspace(args.workspace_id)) {
        return text(`Workspace not found: ${args.workspace_id}`)
      }
      const patch: ScheduleUpdate = {
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
        ...(args.recurrence !== undefined ? { recurrence: args.recurrence } : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        ...(args.workspace_id !== undefined ? { workspaceId: args.workspace_id } : {}),
        ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.effort !== undefined ? { effort: args.effort } : {}),
        ...(args.ultracode !== undefined ? { ultracode: args.ultracode } : {}),
        ...(args.catch_up !== undefined ? { catchUp: args.catch_up } : {}),
        ...(args.keep_terminal !== undefined ? { keepTerminal: args.keep_terminal } : {}),
        ...(args.max_runtime_ms !== undefined ? { maxRuntimeMs: args.max_runtime_ms } : {}),
      }
      const s = scheduler.update(args.id, patch)
      return s ? json(s) : text(`Schedule not found: ${args.id}`)
    },
  )

  server.tool(
    "schedule_delete",
    "Delete a scheduled run by id (kills any in-flight run for it). Returns whether a schedule was deleted.",
    { id: z.string().describe("Schedule id from schedule_list") },
    async ({ id }) => text(scheduler.delete(id) ? "Schedule deleted" : `Schedule not found: ${id}`),
  )

  server.tool(
    "schedule_run_now",
    "Fire a scheduled run immediately, ignoring its due time (still overlap-guarded — refused if a run for it is already in flight). Returns whether a run was started.",
    { id: z.string().describe("Schedule id from schedule_list") },
    async ({ id }) => text(scheduler.runNow(id) ? "Run started" : `Not started (unknown id, or a run is already in flight): ${id}`),
  )
}
