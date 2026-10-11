import { Effect } from "effect"
import type {
  ToolRegistration,
  ToolExecutionResult,
} from "@earendil-works/pi-durable"
import type { AccessGate } from "../gate"
import { toolReceipt } from "./receipt"

/** Native Pi owns task IDs; the access receipt makes waiting tools safe to reopen. */
export function guardedTools(
  gate: AccessGate,
  activeTurn: () => string | undefined,
  recoverableTools: ReadonlySet<string> = new Set()
) {
  const running = new Map<
    string,
    { input: string; promise: Promise<ToolExecutionResult> }
  >()
  return (tool: ToolRegistration): ToolRegistration => ({
    ...tool,
    replay: "safe",
    execute: (args, api, context) => {
      const id = String(api.taskId),
        input = JSON.stringify({ tool: tool.name, args })
      const existing = running.get(id)
      if (existing) {
        if (existing.input !== input)
          return Promise.reject(new Error("Tool identity conflict"))
        return existing.promise
      }
      const previous = gate.store.get(id)
      const turnId = previous?.turnId ?? activeTurn()
      if (!turnId) return Promise.reject(new Error("The reply has ended."))
      const promise = Effect.runPromise(
        gate.run(
          { id, turnId, tool: tool.name, input: JSON.stringify(args) },
          async () => toolReceipt(await tool.execute(args, api, context)),
          recoverableTools.has(tool.name)
        ),
        { signal: context.abortSignal }
      )
      running.set(id, { input, promise })
      void promise
        .finally(() => {
          if (running.get(id)?.promise === promise) running.delete(id)
        })
        .catch(() => {})
      return promise
    },
  })
}
