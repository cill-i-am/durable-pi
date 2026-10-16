import { Type } from "@earendil-works/pi-ai"
import { defineTool } from "@earendil-works/pi-durable"
import { Schema, type Effect } from "effect"

import type { Routine } from "../contracts"
import { SaveRoutine } from "../contracts"
import type { Routines } from "../service"

async function operationId(task: string) {
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`routine:${task}`)
      )
    )
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`
}
const summary = ({ prompt: _prompt, ...routine }: Routine) => routine
const result = (value: unknown) => ({
  output: [{ type: "text" as const, text: JSON.stringify(value) }],
})
export function routineTools(
  store: Routines["Service"],
  wake: () => Promise<void>,
  run: <TResult, TError>(
    operation: Effect.Effect<TResult, TError>,
    signal?: AbortSignal
  ) => Promise<TResult>
) {
  return [
    defineTool({
      name: "list_routines",
      description:
        "List this bot's routines with current revisions, schedule and pause status. Use read_routine before editing. Schedules run on Cloudflare with the browser closed; existing tool approvals apply.",
      parameters: Type.Object({
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      replay: "safe",
      execute: async ({ offset = 0 }) => {
        const routines = await run(store.list())
        return result({
          routines: routines.slice(offset, offset + 20).map(summary),
          next: offset + 20 < routines.length ? offset + 20 : null,
        })
      },
    }),
    defineTool({
      name: "read_routine",
      description:
        "Read one of this bot's routines and its instructions before editing.",
      parameters: Type.Object({ id: Type.String() }),
      replay: "safe",
      execute: async ({ id }) =>
        result((await run(store.get(id))) ?? { error: "Routine not found." }),
    }),
    defineTool({
      name: "save_routine",
      description:
        "Create or edit a scheduled routine for this bot. Requires owner approval by default. schedule is JSON {type:'once',at:UnixMilliseconds} or {type:'interval',at:UnixMilliseconds,minutes:15..10080} or {type:'webhook'} for incoming events only. Webhook keys must be enabled by the owner in the UI; never ask for or disclose them in chat. A new first run must be in the future. Intervals are elapsed minutes, not timezone calendar rules. Reuse id and current expectedRevision when editing; omit id and use revision 0 for new. status active or paused. Missed intervals coalesce; at most one routine runs per bot, with a ten-minute budget. Existing tool grants and Ask approvals remain enforced. Outputs appear in this bot's conversation. No email or push notifications are sent automatically.",
      parameters: Type.Object({
        id: Type.Optional(Type.String()),
        expectedRevision: Type.Integer({ minimum: 0 }),
        title: Type.String({ minLength: 1, maxLength: 80 }),
        prompt: Type.String({ minLength: 1, maxLength: 12000 }),
        schedule: Type.String({ maxLength: 500 }),
        status: Type.Union([Type.Literal("active"), Type.Literal("paused")]),
      }),
      replay: "safe",
      execute: async (args, api, execution) => {
        const operation = await operationId(String(api.taskId))
        await wake()
        execution.abortSignal?.throwIfAborted()
        const change = await run(
          store.save(
            Schema.decodeUnknownSync(SaveRoutine)({
              ...args,
              id: args.id ?? operation,
              operationId: operation,
              schedule: JSON.parse(args.schedule) as unknown,
            })
          ),
          execution.abortSignal
        )
        await wake()
        return result(summary(change.routine))
      },
    }),
    defineTool({
      name: "set_routine_status",
      description:
        "Pause, resume or archive this bot's routine. Pausing cancels unadmitted work; an already admitted run can finish within its budget. Archive is recoverable by restoring to paused. Requires owner approval by default.",
      parameters: Type.Object({
        id: Type.String(),
        expectedRevision: Type.Integer({ minimum: 0 }),
        status: Type.Union([
          Type.Literal("active"),
          Type.Literal("paused"),
          Type.Literal("archived"),
        ]),
      }),
      replay: "safe",
      execute: async (args, api, execution) => {
        const operation = await operationId(String(api.taskId))
        await wake()
        execution.abortSignal?.throwIfAborted()
        const change = await run(
          store.setStatus({ ...args, operationId: operation }),
          execution.abortSignal
        )
        await wake()
        return result(summary(change.routine))
      },
    }),
  ]
}
