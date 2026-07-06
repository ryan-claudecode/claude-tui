import { describe, it, expect } from "vitest"
import {
  backgroundStartId,
  taskNotificationIds,
  isTaskNotification,
  contentToText,
} from "./backgroundTasks"

// The REAL shapes captured from live runs (see the module doc).
const START =
  "Command running in background with ID: bwcvqj4e4. Output is being written to: C:\\Users\\x\\tasks\\bwcvqj4e4"
const NOTIF =
  "<task-notification> <task-id>bwcvqj4e4</task-id> <tool-use-id>toolu_015aDM3wSw5BDtnYyZWBDEPw</tool-use-id> <output-file>C:\\x</output-file> </task-notification>"

describe("backgroundStartId", () => {
  it("extracts the task-id from a string tool_result", () => {
    expect(backgroundStartId(START)).toBe("bwcvqj4e4")
  })

  it("extracts it from an array-of-text tool_result content", () => {
    expect(backgroundStartId([{ type: "text", text: START }])).toBe("bwcvqj4e4")
  })

  it("returns null for an ordinary (non-background) tool_result", () => {
    expect(backgroundStartId("1\tusing Godot;\n2\t...")).toBeNull()
    expect(backgroundStartId("<tool_use_error>Blocked: ...</tool_use_error>")).toBeNull()
  })

  it("never throws on odd content shapes", () => {
    expect(backgroundStartId(null)).toBeNull()
    expect(backgroundStartId(42)).toBeNull()
    expect(backgroundStartId({})).toBeNull()
  })
})

describe("taskNotificationIds", () => {
  it("pulls the completed task-id from a task-notification", () => {
    expect(taskNotificationIds(NOTIF)).toEqual(["bwcvqj4e4"])
  })

  it("handles a batched notice with several task-ids", () => {
    const multi = "<task-notification><task-id>aaa</task-id><task-id>bbb</task-id></task-notification>"
    expect(taskNotificationIds(multi)).toEqual(["aaa", "bbb"])
  })

  it("returns [] when there is no well-formed task-id", () => {
    expect(taskNotificationIds("just some prose")).toEqual([])
    expect(taskNotificationIds("<task-notification>no id here</task-notification>")).toEqual([])
  })
})

describe("isTaskNotification", () => {
  it("recognizes a task-notification wrapper, rejects other text", () => {
    expect(isTaskNotification(NOTIF)).toBe(true)
    expect(isTaskNotification("<system-reminder>hi</system-reminder>")).toBe(false)
    expect(isTaskNotification("plain user text")).toBe(false)
  })
})

describe("contentToText", () => {
  it("flattens strings and text-block arrays, tolerates junk", () => {
    expect(contentToText("hi")).toBe("hi")
    expect(contentToText([{ type: "text", text: "a" }, "b", { nope: 1 }])).toBe("ab")
    expect(contentToText(null)).toBe("")
    expect(contentToText(99)).toBe("")
  })
})
