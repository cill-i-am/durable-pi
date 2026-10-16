import { Type } from "@earendil-works/pi-ai"
import { defineTool } from "@earendil-works/pi-durable"
import type { Effect } from "effect"
import type { ExecutionOperations } from "../execution"

export function executionTools(
  executions: ExecutionOperations,
  runProgram: <T, TError>(
    program: Effect.Effect<T, TError>,
    options?: { signal?: AbortSignal }
  ) => Promise<T>
) {
  return [
    defineTool({
      name: "run_code",
      description:
        "Run bounded JavaScript for calculations or JSON transformations in an isolated Cloudflare Worker. Code is an async function body with input (parsed JSON) and console.log; return a JSON-serializable result. No network, files, application bindings, packages or credentials. Maximum 1 second CPU and 10 seconds elapsed; results/logs are bounded. Never include secrets. A saved run is visible in Code.",
      parameters: Type.Object({
        code: Type.String({ minLength: 1, maxLength: 16384 }),
        data: Type.String({
          maxLength: 32768,
          description:
            "JSON input as a string, e.g. [1,2,3]. Use null when unused.",
        }),
      }),
      replay: "safe",
      execute: async (args, api, execution) => {
        const run = await runProgram(
          executions.run({
            ...args,
            id: `code:${String(api.taskId)}`,
          }),
          { signal: execution.abortSignal }
        )
        return {
          isError: run.status !== "succeeded",
          output: [
            {
              type: "text" as const,
              text: JSON.stringify({
                id: run.id,
                status: run.status,
                output: run.output,
              }),
            },
          ],
        }
      },
    }),
  ]
}
