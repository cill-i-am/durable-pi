import { Schema } from "effect"
import { expect, it, vi } from "vitest"

import {
  AgentId,
  homeAgentId,
  originalAgent,
  type AgentProfile,
} from "../src/agents/domain"
import { taskCommand } from "../src/tasks/commands"
import { parseTaskHandle, taskError, type Task } from "../src/tasks/contracts"
import { taskDirectory } from "../src/tasks/directory"

const other = Schema.decodeUnknownSync(AgentId)(
  "00000000-0000-4000-8000-000000000001"
)
const profiles: AgentProfile[] = [
  originalAgent("today"),
  { ...originalAgent("today"), id: other, name: "Research", slug: "research" },
]
const task: Task = {
  kind: "request",
  id: "original-request",
  title: "Research dinner options",
  state: "preparing-files",
  terminal: false,
}
function fixture() {
  const list = vi.fn(async () => [task])
  const stop = vi.fn(
    async (_agent: AgentProfile, ref: { kind: string; id: string }) => ({
      ...task,
      ...ref,
      state: "stopping",
    })
  )
  return {
    list,
    stop,
    run: taskDirectory({ profiles: async () => profiles, list, stop }),
  }
}

it("recognizes explicit leading controls without interpreting quoted documents or prose", () => {
  expect(taskCommand("STATUS")).toEqual({ action: "status" })
  expect(taskCommand("/status research")).toEqual({
    action: "status",
    agent: "research",
  })
  expect(
    taskCommand("STOP home/request/original-request\n\n> quoted email")
  ).toEqual({ action: "stop", handle: "home/request/original-request" })
  expect(taskCommand("STOP")).toEqual({ action: "help" })
  for (const text of [
    "> STOP home/request/other",
    "Please stop the research",
    "Here is a document:\nSTOP home/request/other",
  ])
    expect(taskCommand(text)).toBeUndefined()
})

it("lists actual states across agents, with explicit stable actor/task handles", async () => {
  const f = fixture()
  const text = await f.run({ action: "status", agent: "all" }, homeAgentId)
  expect(text).toContain("Personal assistant (personal-assistant)")
  expect(text).toContain("Research (research)")
  expect(text).toContain(`${other}/request/original-request`)
  expect(text).toContain("preparing-files")
  expect(f.stop).not.toHaveBeenCalled()
})

it("supports human slugs for reads and stable IDs for delayed stops after renaming", async () => {
  const f = fixture()
  await f.run({ action: "status", agent: "research" }, homeAgentId)
  expect(f.list).toHaveBeenCalledExactlyOnceWith(profiles[1])
  profiles[1] = { ...profiles[1]!, name: "Renamed", slug: "renamed" }
  const text = await f.run(
    { action: "stop", handle: `${other}/request/original-request` },
    homeAgentId
  )
  expect(f.stop).toHaveBeenCalledExactlyOnceWith(profiles[1], {
    kind: "request",
    id: "original-request",
  })
  expect(text).toContain("Stop requested")
  expect(text).toContain("stopping")
  expect(text).toContain("cannot undo")
  profiles[1] = { ...profiles[1]!, name: "Research", slug: "research" }
})

it("never routes a stop to a missing/foreign/archived agent or an implicit current task", async () => {
  const f = fixture()
  for (const handle of [
    "home",
    "home/request",
    "research/request/original-request",
    "home/background/0",
    "home/background/2/3",
    "00000000-0000-4000-8000-000000000099/request/original-request",
  ])
    await expect(
      f.run({ action: "stop", handle }, homeAgentId)
    ).rejects.toHaveProperty("_tag", "TaskControlError")
  expect(f.stop).not.toHaveBeenCalled()
  expect(parseTaskHandle("home/bot-task/bot:original:tool").task.id).toBe(
    "bot:original:tool"
  )
})

it("shows partial unavailability honestly, while rejecting malformed or misbound producer results", async () => {
  const f = fixture()
  f.list.mockRejectedValueOnce(taskError("unavailable", "Unavailable"))
  const text = await f.run({ action: "status", agent: "all" }, homeAgentId)
  expect(text).toContain("does not mean the agent is idle")
  expect(text).toContain("Research")
  f.stop.mockResolvedValueOnce({ ...task, id: "newer-request" })
  await expect(
    f.run(
      { action: "stop", handle: "home/request/original-request" },
      homeAgentId
    )
  ).rejects.toThrow("another task")
})
