import { Schema, Effect } from "effect"
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable"
import type { DelegationFailure } from "../../delegation/contracts"
import { Type } from "@earendil-works/pi-ai"
import {
  DelegateInput,
  type Communication,
  type Source,
} from "../communication"

type Runner = <T, TError>(
  operation: Effect.Effect<T, TError>,
  signal?: AbortSignal
) => Promise<T>

export const communicationInstructions = `For an internal question or text-only drafting task for another named bot, use discover_bots then delegate_bot. Supply only the necessary text and all constraints. This persists a dependency and returns immediately. You may finish your reply while waiting; a correlated result will return to this chat. Do not claim acceptance is completion, poll in a loop, share object/file IDs as authority, or retry by creating another task. Recipients have no tools, external actions or onward delegation. Activity supports cancellation and safe delivery retries.`
export function communicationTools(
  app: Communication["Service"],
  source: (
    api: ToolExecutionApi
  ) => Source | Effect.Effect<Source, DelegationFailure>,
  run: Runner
) {
  return [
    defineTool({
      name: "discover_bots",
      description:
        "List other active bots owned by this account that can receive a bounded text-only internal task or question.",
      replay: "safe",
      parameters: Type.Object({}),
      execute: async (_, _api, context) => ({
        output: [
          {
            type: "text",
            text: JSON.stringify(
              await run(app.discover(), context.abortSignal)
            ),
          },
        ],
      }),
    }),
    defineTool({
      name: "delegate_bot",
      description:
        "Send another bot one bounded question or drafting task with explicit text context. Saves a durable dependency and returns acceptance immediately; findings arrive later in this chat. No object, file or outside-action grants. At most three tasks per originating request, ten-minute deadline. Requires existing tool permission.",
      replay: "safe",
      parameters: Type.Object({
        to: Type.String(),
        kind: Type.Union([Type.Literal("task"), Type.Literal("question")]),
        objective: Type.String({ minLength: 1, maxLength: 1000 }),
        context: Type.String({ maxLength: 12000 }),
      }),
      execute: async (input, api, context) => ({
        output: [
          {
            type: "text",
            text: JSON.stringify(
              await run(
                app.delegate(
                  Schema.decodeUnknownSync(DelegateInput)(input),
                  await run(
                    Effect.suspend(() => {
                      const value = source(api)
                      return Effect.isEffect(value)
                        ? value
                        : Effect.succeed(value)
                    }),
                    context.abortSignal
                  )
                ),
                context.abortSignal
              )
            ),
          },
        ],
      }),
    }),
    defineTool({
      name: "check_bot_task",
      description:
        "Read this bot's durable task outcome by task ID. Do not poll repeatedly while waiting; results resume the original task automatically.",
      replay: "safe",
      parameters: Type.Object({ id: Type.String({ maxLength: 180 }) }),
      execute: async (input, _api, context) => ({
        output: [
          {
            type: "text",
            text: JSON.stringify(
              await run(app.get(input.id), context.abortSignal)
            ),
          },
        ],
      }),
    }),
  ]
}
