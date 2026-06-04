import { readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

export type TaskStatus = "pending" | "claimed" | "done"

export interface QueuedTask {
  id: string
  title: string
  detail?: string
  status: TaskStatus
  /** Free-form label of whoever claimed it — a session id, a name, etc. */
  claimedBy?: string
  createdAt: string
  updatedAt: string
}

const QUEUE_DIR = join(homedir(), ".claude-tui")
const QUEUE_FILE = join(QUEUE_DIR, "tasks.json")

/**
 * TaskQueueService — a shared job board persisted to disk. ClaudeTUI routinely
 * runs several Claude sessions at once; this gives them a coordination
 * primitive: one session enqueues work items, another lists/claims/completes
 * them. Survives app restarts, so a backlog can outlive any single session.
 *
 * Thin by design: it only reads/writes ~/.claude-tui/tasks.json. No session-layer
 * or renderer changes.
 */
export class TaskQueueService {
  private read(): QueuedTask[] {
    try {
      const data = JSON.parse(readFileSync(QUEUE_FILE, "utf-8"))
      return Array.isArray(data) ? data : []
    } catch {
      return []
    }
  }

  private persist(tasks: QueuedTask[]): void {
    mkdirSync(QUEUE_DIR, { recursive: true })
    writeFileSync(QUEUE_FILE, JSON.stringify(tasks, null, 2))
  }

  /** List tasks, optionally filtered by status. Pending first, then by age. */
  list(status?: TaskStatus): QueuedTask[] {
    let tasks = this.read()
    if (status) tasks = tasks.filter((t) => t.status === status)
    const order: Record<TaskStatus, number> = { pending: 0, claimed: 1, done: 2 }
    return tasks.sort(
      (a, b) => order[a.status] - order[b.status] || a.createdAt.localeCompare(b.createdAt),
    )
  }

  /** Add a new pending task to the queue. */
  enqueue(title: string, detail?: string): QueuedTask {
    const now = new Date().toISOString()
    const task: QueuedTask = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      detail,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    }
    const tasks = this.read()
    tasks.push(task)
    this.persist(tasks)
    return task
  }

  /**
   * Claim a task so other sessions know it's being worked on. Returns the task,
   * or undefined if no such id, or null if it was already claimed/done.
   */
  claim(id: string, by?: string): QueuedTask | undefined | null {
    const tasks = this.read()
    const task = tasks.find((t) => t.id === id)
    if (!task) return undefined
    if (task.status !== "pending") return null
    task.status = "claimed"
    task.claimedBy = by
    task.updatedAt = new Date().toISOString()
    this.persist(tasks)
    return task
  }

  /** Mark a task done. Returns the task, or undefined if no such id. */
  complete(id: string): QueuedTask | undefined {
    const tasks = this.read()
    const task = tasks.find((t) => t.id === id)
    if (!task) return undefined
    task.status = "done"
    task.updatedAt = new Date().toISOString()
    this.persist(tasks)
    return task
  }

  /** Remove a task from the queue. Returns false if none matched. */
  delete(id: string): boolean {
    const tasks = this.read()
    const next = tasks.filter((t) => t.id !== id)
    if (next.length === tasks.length) return false
    this.persist(next)
    return true
  }

  /** Remove all completed tasks. Returns how many were cleared. */
  clearDone(): number {
    const tasks = this.read()
    const next = tasks.filter((t) => t.status !== "done")
    const removed = tasks.length - next.length
    if (removed > 0) this.persist(next)
    return removed
  }
}
