import { Schema } from "effect"

import type { AgentId, AgentProfile } from "../agents/domain"
import { taskHelp, type TaskCommand } from "./commands"
import {
  Task,
  TaskList,
  TaskControlError,
  taskError,
  taskHandle,
  parseTaskHandle,
  type TaskReference,
} from "./contracts"

/** One account-scoped directory for tools and channel controls. Stable handles
 * contain actor IDs, so renaming an agent never redirects a delayed stop. */
export function taskDirectory(host: {
  profiles: () => Promise<readonly AgentProfile[]>
  list: (agent: AgentProfile) => Promise<unknown>
  stop: (agent: AgentProfile, task: TaskReference) => Promise<unknown>
}) {
  return async (command: TaskCommand, current: AgentId): Promise<string> => {
    if (command.action === "help") return taskHelp
    const profiles = (await host.profiles()).filter(
      (p) => p.status === "active"
    )
    if (command.action === "stop") {
      const target = parseTaskHandle(command.handle)
      const profile = profiles.find((p) => p.id === target.agent)
      if (!profile)
        throw taskError(
          "not_found",
          "That task's agent is unavailable in your account."
        )
      const result = Schema.decodeUnknownSync(Task)(
        await host.stop(profile, target.task)
      )
      if (result.id !== target.task.id || result.kind !== target.task.kind)
        throw new Error("Task stop returned another task's identity.")
      return `${profile.name}: ${result.title}\n${taskHandle(profile.id, result)}\n${result.terminal && result.state !== "cancellation-requested" ? `Current state: ${result.state}.` : `Stop requested. Current state: ${result.state}. Cancellation is still settling.`}\nStopping cannot undo actions already completed.`
    }
    const selector = command.agent ?? current
    const selected =
      selector === "all"
        ? profiles
        : profiles.filter((p) => p.id === selector || p.slug === selector)
    if (!selected.length)
      throw taskError(
        "not_found",
        "That agent is unavailable. Use STATUS all to see your agents."
      )
    const results: string[] = []
    // Keep native fan-out bounded, even as the catalogue grows.
    for (let i = 0; i < selected.length; i += 4) {
      const batch = await Promise.all(
        selected.slice(i, i + 4).map(async (profile) => {
          try {
            const tasks = Schema.decodeUnknownSync(TaskList)(
              await host.list(profile)
            )
            return `${profile.name} (${profile.slug})\n${tasks.length ? tasks.map((t) => `${t.state}: ${t.title}\n${taskHandle(profile.id, t)}`).join("\n\n") : "No open task records."}`
          } catch (error) {
            if (!Schema.is(TaskControlError)(error)) throw error
            return `${profile.name} (${profile.slug})\nStatus is unavailable; this does not mean the agent is idle.`
          }
        })
      )
      results.push(...batch)
    }
    return results.join("\n\n") + "\n\n" + taskHelp
  }
}
