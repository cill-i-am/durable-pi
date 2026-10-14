import { Effect } from "effect"
import type {
  ToolRegistration,
  ToolExecutionResult,
  ToolExecutionApi,
} from "@earendil-works/pi-durable"
import type { AccessGate } from "../gate"
import { toolReceipt } from "./receipt"

export function guardedTools(
  gate: AccessGate,
  activeTurn: (
    api: ToolExecutionApi
  ) => string | undefined | Promise<string | undefined>,
  recoverableTools: ReadonlySet<string> = new Set(),
  run: typeof Effect.runPromise = Effect.runPromise
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
      const promise = Promise.resolve().then(async () => {
        const previous = gate.store.get(id)
        const resolved = await activeTurn(api)
        if (previous && resolved !== previous.turnId)
          throw new Error(
            "Tool ownership no longer matches its original request."
          )
        const turnId = previous?.turnId ?? resolved
        if (!turnId) throw new Error("The reply has ended.")
        return run(
          gate.run(
            { id, turnId, tool: tool.name, input: JSON.stringify(args) },
            async () => toolReceipt(await tool.execute(args, api, context)),
            recoverableTools.has(tool.name)
          ),
          { signal: context.abortSignal }
        )
      })
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
