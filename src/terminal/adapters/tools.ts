import { Type } from "@earendil-works/pi-ai"
import { defineTool } from "@earendil-works/pi-durable"
import { Effect } from "effect"
import { preserveFatal } from "../../shared/effect"
import type { CommandInput, CommandRun, TerminalFailure } from "../contracts"
import type { TerminalRuntimeError } from "../runtime"

const text = (value: string) => ({
  isError: true,
  output: [{ type: "text" as const, text: value }],
})
export function terminalToolResult<TRequirements>(
  operation: Effect.Effect<
    CommandRun,
    TerminalFailure | TerminalRuntimeError,
    TRequirements
  >
): Effect.Effect<ReturnType<typeof text>, never, TRequirements> {
  return operation.pipe(
    Effect.map((run) => ({
      isError: run.status !== "succeeded" || run.error !== null,
      output: [{ type: "text" as const, text: JSON.stringify(run) }],
    })),
    preserveFatal,
    Effect.catchTags({
      TerminalFailure: (error) => Effect.succeed(text(error.message)),
      TerminalRuntimeError: () =>
        Effect.succeed(
          text(
            "The command status could not be confirmed. Inspect Terminal before starting another command."
          )
        ),
    })
  )
}
export function terminalTools(
  command: (
    input: CommandInput
  ) => Effect.Effect<CommandRun, TerminalFailure | TerminalRuntimeError>,
  run: <T, TError>(
    program: Effect.Effect<T, TError>,
    options?: { signal?: AbortSignal }
  ) => Promise<T>
) {
  return [
    defineTool({
      name: "run_command",
      description:
        "Run a Linux shell command in this bot's private Cloudflare container. Node and Python are available. Outbound internet follows the owner-controlled Terminal settings; application/model credentials are never provided. Only /workspace is restored between commands; excludes node_modules, .git and .cache. 30-second execution budget, 64,000 output characters and 8 MiB compressed checkpoint. Completion waits for container cleanup. All background processes end after the command. Stop or a failed checkpoint restores the previous saved workspace. Inspect Terminal for saved command/status; never repeat an interrupted command blindly.",
      parameters: Type.Object({
        command: Type.String({ minLength: 1, maxLength: 16000 }),
      }),
      replay: "safe",
      execute: (args, api, execution) =>
        run(
          terminalToolResult(
            command({ ...args, id: `command:${String(api.taskId)}` })
          ),
          { signal: execution.abortSignal }
        ),
    }),
  ]
}
