import { Type } from "@earendil-works/pi-ai"
import { defineTool } from "@earendil-works/pi-durable"

import type { TaskCommand } from "../commands"

export const taskInstructions =
  "Use list_tasks to inspect real saved work across your account's agents. Use stop_task only when the user asks to stop specific work; copy its exact stable handle from list_tasks. Ask which task if the target is ambiguous. A stop acknowledgement records intent; report the returned state, and never claim it undoes completed actions. Do not repeatedly poll. Request-owned child research stops with its parent request."
export function taskTools(
  run: (command: TaskCommand, signal?: AbortSignal) => Promise<string>
) {
  return [
    defineTool({
      name: "list_tasks",
      description:
        "List unfinished requests, bot-to-bot tasks and background groups, with actual state and stable stop handles. Choose all or one agent ID/slug. Read-only; do not poll repeatedly.",
      replay: "safe",
      parameters: Type.Object({
        agent: Type.Optional(Type.String({ maxLength: 100 })),
      }),
      execute: async (input, _api, context) => ({
        output: [
          {
            type: "text",
            text: await run(
              { action: "status", agent: input.agent ?? "all" },
              context.abortSignal
            ),
          },
        ],
      }),
    }),
    defineTool({
      name: "stop_task",
      description:
        "Request cancellation of the exact task the user wants stopped. Copy its stable handle from list_tasks. Works across agents within this account. Does not undo completed effects or stop future work.",
      replay: "safe",
      parameters: Type.Object({
        handle: Type.String({ minLength: 1, maxLength: 260 }),
      }),
      execute: async (input, _api, context) => ({
        output: [
          {
            type: "text",
            text: await run(
              { action: "stop", handle: input.handle },
              context.abortSignal
            ),
          },
        ],
      }),
    }),
  ]
}
