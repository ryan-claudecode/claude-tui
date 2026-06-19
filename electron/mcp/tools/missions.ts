import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { MissionService } from "../../services/mission"

export function registerMissionTools(server: McpServer, mission: MissionService) {
  // Mission orchestration — durable, on-disk missions driven by a Conductor.
  server.tool("mission_create", "Start a new orchestration mission. Returns the mission (status 'planning'); decompose its goal with mission_plan, then dispatch workers.", {
    goal: z.string().describe("The mission's north-star goal"),
    cwd: z.string().describe("Absolute path of the repo/dir the mission operates on"),
    autonomy: z.enum(["hands-off", "checkpoints", "supervised"]).optional().describe("How hands-on the user is (default hands-off)"),
    isolate_workers: z.boolean().optional().describe("Opt-in: spawn each worker into a private git worktree and review-gate its diff before merge (requires cwd to be a git repo). Default off."),
  }, async ({ goal, cwd, autonomy, isolate_workers }) => {
    try {
      const m = mission.create(goal, cwd, autonomy, isolate_workers)
      return { content: [{ type: "text" as const, text: JSON.stringify(m, null, 2) }] }
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }] }
    }
  })

  server.tool("mission_status", "Load a mission's full durable state — the resume entry point. Omit mission_id for the most-recently-updated active mission.", {
    mission_id: z.string().optional(),
  }, async ({ mission_id }) => {
    const m = mission.status(mission_id)
    return { content: [{ type: "text" as const, text: m ? JSON.stringify(m, null, 2) : "No active mission" }] }
  })

  server.tool("mission_list", "List all missions, newest-updated first.", {}, async () => {
    return { content: [{ type: "text" as const, text: JSON.stringify(mission.list(), null, 2) }] }
  })

  server.tool("mission_plan", "Set a mission's task list (decomposition) and start it running.", {
    mission_id: z.string(),
    tasks: z.array(z.object({ title: z.string(), detail: z.string().optional() })).describe("Ordered task list"),
    isolate_workers: z.boolean().optional().describe("Opt-in: enable per-worker git-worktree isolation + diff review for this mission (requires the cwd to be a git repo). Default leaves the create-time setting unchanged."),
  }, async ({ mission_id, tasks, isolate_workers }) => {
    try {
      const m = mission.plan(mission_id, tasks, isolate_workers)
      return { content: [{ type: "text" as const, text: m ? JSON.stringify(m, null, 2) : "Mission not found" }] }
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }] }
    }
  })

  server.tool("mission_dispatch", "Spawn/reuse a worker session for a task, inject its prompt, mark it in-progress. Returns the worker session id.", {
    mission_id: z.string(), task_id: z.string(), prompt: z.string().describe("The full task prompt for the worker"),
  }, async ({ mission_id, task_id, prompt }) => {
    const r = mission.dispatch(mission_id, task_id, prompt)
    return { content: [{ type: "text" as const, text: r ? JSON.stringify(r) : "Mission/task not found" }] }
  })

  server.tool("mission_await", "Block until a task's worker goes idle (finished), then return its recent output for review.", {
    mission_id: z.string(), task_id: z.string(), timeout_ms: z.number().optional(),
  }, async ({ mission_id, task_id, timeout_ms }) => {
    const r = await mission.await(mission_id, task_id, timeout_ms)
    return { content: [{ type: "text" as const, text: r ? JSON.stringify(r, null, 2) : "Mission/task/worker not found" }] }
  })

  server.tool("mission_resolve", "Record a task's review outcome (done/failed) and free its worker.", {
    mission_id: z.string(), task_id: z.string(), status: z.enum(["done", "failed"]), result: z.string().optional(),
  }, async ({ mission_id, task_id, status, result }) => {
    const m = mission.resolve(mission_id, task_id, status, result)
    return { content: [{ type: "text" as const, text: m ? JSON.stringify(m, null, 2) : "Mission/task not found" }] }
  })

  server.tool("mission_log", "Append an event to a mission's audit trail.", {
    mission_id: z.string(), kind: z.enum(["info", "task", "worker", "review", "commit", "pause", "error"]), text: z.string(),
  }, async ({ mission_id, kind, text }) => {
    const m = mission.logEvent(mission_id, kind, text)
    return { content: [{ type: "text" as const, text: m ? "logged" : "Mission not found" }] }
  })

  server.tool("mission_pause", "Pause a mission (e.g. on a usage limit). Optionally set resume_at (epoch ms) for auto-resume.", {
    mission_id: z.string(), resume_at: z.number().optional(),
  }, async ({ mission_id, resume_at }) => {
    const m = mission.pause(mission_id, resume_at)
    return { content: [{ type: "text" as const, text: m ? JSON.stringify(m, null, 2) : "Mission not found" }] }
  })

  server.tool("mission_resume", "Resume a paused mission immediately.", { mission_id: z.string() }, async ({ mission_id }) => {
    const m = mission.resume(mission_id)
    return { content: [{ type: "text" as const, text: m ? JSON.stringify(m, null, 2) : "Mission not found" }] }
  })

  server.tool("mission_stop", "Stop a mission and kill its workers + conductor.", { mission_id: z.string() }, async ({ mission_id }) => {
    const m = mission.stop(mission_id)
    return { content: [{ type: "text" as const, text: m ? "stopped" : "Mission not found" }] }
  })

  server.tool("mission_finish", "Mark a mission done.", { mission_id: z.string() }, async ({ mission_id }) => {
    const m = mission.finish(mission_id)
    return { content: [{ type: "text" as const, text: m ? "done" : "Mission not found" }] }
  })

  // --- Worktree-isolated worker review gate (WW-2) ---
  server.tool("mission_review_queue", "List tasks awaiting review (isolated-worker missions): each task that resolved 'done' is committed to its private branch and parked for review with its captured diff. Approve or reject each with mission_approve_task / mission_reject_task.", {}, async () => {
    return { content: [{ type: "text" as const, text: JSON.stringify(mission.reviewQueue(), null, 2) }] }
  })

  server.tool("mission_approve_task", "Approve an awaiting-review task: merge its worktree branch into the mission's working branch. Clean → task done + worktree removed. Conflict → task 'merge-conflict' with the branch preserved for manual handling (NEVER auto-resolved).", {
    mission_id: z.string(), task_id: z.string(),
  }, async ({ mission_id, task_id }) => {
    const m = mission.approveTask(mission_id, task_id)
    if (!m) return { content: [{ type: "text" as const, text: "Task not awaiting review (or mission/task not found)" }] }
    const task = m.tasks.find((t) => t.id === task_id)
    return { content: [{ type: "text" as const, text: JSON.stringify({ status: task?.status, reviewReason: task?.reviewReason }, null, 2) }] }
  })

  server.tool("mission_reject_task", "Reject an awaiting-review (or merge-conflict) task: discard its worktree + branch and set it back to pending (re-dispatchable). Nothing merges. The reason is recorded in the mission log.", {
    mission_id: z.string(), task_id: z.string(), reason: z.string().optional(),
  }, async ({ mission_id, task_id, reason }) => {
    const m = mission.rejectTask(mission_id, task_id, reason)
    return { content: [{ type: "text" as const, text: m ? "rejected — task back to pending" : "Task not awaiting review (or mission/task not found)" }] }
  })
}
