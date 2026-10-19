import { Type } from "@earendil-works/pi-ai"
import {
  defineTool,
  hook,
  GenerationTask,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable"
import { Clock, Effect } from "effect"

import type { BackgroundInput } from "../background"
import type { BackgroundError } from "../background-mailbox"
import type { DelegationFailure } from "../contracts"
import { type DelegationSource } from "../delegation"
import type { Delegations } from "../delegations"

export type DelegationRunner<TError = DelegationFailure> = <T>(
  work: Effect.Effect<T, TError>,
  signal?: AbortSignal
) => Promise<T>

export function backgroundTool(
  run: (
    input: BackgroundInput,
    api: ToolExecutionApi
  ) => Effect.Effect<string, BackgroundError>,
  execute: DelegationRunner<BackgroundError>
) {
  return defineTool({
    name: "background_tasks",
    description:
      "Start one bounded group of up to three independent background drafting or analysis tasks when the user requested work that can continue after your reply. Uses supplied text references only, no tools or live retrieval. Inherits the current model and returns an acceptance receipt immediately; findings arrive later in this bot's chat. Put all constraints and completion criteria in each brief. Existing approvals apply. Do not create recursive background work from a child report.",
    replay: "safe",
    parameters: Type.Object({
      objective: Type.String({ minLength: 1, maxLength: 500 }),
      tasks: Type.Array(
        Type.Object({
          name: Type.String({ minLength: 1, maxLength: 80 }),
          task: Type.String({ minLength: 1, maxLength: 8000 }),
        }),
        { minItems: 1, maxItems: 3 }
      ),
    }),
    execute: async (input, api, context) => {
      return {
        output: [
          {
            type: "text",
            text: await execute(run(input, api), context.abortSignal),
          },
        ],
      }
    },
  })
}

export const delegationInstructions = `For substantial requests with independent research or drafting branches, delegate_tasks can run one group of up to three child tasks. Use it when parallel help improves the result, not for ordinary questions. Each child inherits your pinned model and gets only explicitly selected read tools and this bot's reference context. Include relevant user constraints in every brief. You remain responsible for evaluating their findings and completing the request. Children cannot perform outside actions or spawn agents. Delegation uses existing tool permissions. Do not promise background work: this group belongs to the current request and Stop cancels it. One combined report returns when children finish. Do not redelegate completed tasks.`
export function delegationTool(
  delegations: Delegations,
  source: (
    api: ToolExecutionApi
  ) => DelegationSource | Effect.Effect<DelegationSource, DelegationFailure>,
  execute: DelegationRunner,
  detached?: { wake: () => Promise<void> }
) {
  return defineTool({
    name: detached ? "spawn_agents" : "delegate_tasks",
    description: detached
      ? "Start up to three research or drafting agents and return immediately. Use list_agents, send_message and get_last_message to coordinate while you keep working. Children receive only selected read tools and can message their parent and peers. Their findings arrive in this session. Agents expire after ten minutes; Stop cancels them. No recursive delegation or outside actions."
      : "Run one bounded group of up to three independent research/drafting tasks for this request. Give each a distinct name, concrete brief with constraints, and explicit read-tool list. Inherits the parent model; no recursive delegation or outside actions. Returns combined findings once. Owner can inspect, steer or stop children in Activity.",
    replay: "safe",
    parameters: Type.Object({
      objective: Type.String({ minLength: 1, maxLength: 500 }),
      tasks: Type.Array(
        Type.Object({
          name: Type.String({ minLength: 1, maxLength: 80 }),
          task: Type.String({ minLength: 1, maxLength: 8000 }),
          tools: Type.Array(
            Type.Union(
              [
                "zoom",
                "date",
                "search_memory",
                "list_files",
                "read_file",
                "view_image",
                "read_note",
              ].map((name) => Type.Literal(name))
            ),
            { maxItems: 6 }
          ),
        }),
        { minItems: 1, maxItems: 3 }
      ),
    }),
    execute: async (input, api, context) => {
      const text = await execute(
        Effect.gen(function* () {
          const value = source(api)
          const admitted = Effect.isEffect(value) ? yield* value : value
          return yield* delegations.run(input, {
            ...admitted,
            ...(detached ? { detached: true } : {}),
          })
        }),
        context.abortSignal
      )
      if (detached) await detached.wake()
      return { output: [{ type: "text", text }] }
    },
  })
}

export function childSteeringHook(
  delegations: Delegations,
  steering: (
    turnId: string
  ) =>
    | readonly { id: string; text: string }[]
    | Effect.Effect<readonly { id: string; text: string }[], DelegationFailure>,
  execute: DelegationRunner
) {
  return hook(GenerationTask, {
    beforeRequest: async ({ messages }, api, context) => {
      const { root, now } = await execute(
        Effect.gen(function* () {
          const rootId = yield* delegations.root(Number(api.conversationId))
          const observedAt = yield* Clock.currentTimeMillis
          return { root: rootId, now: observedAt }
        }),
        context.abortSignal
      )
      const inputs = root
        ? await execute(
            Effect.suspend(() => {
              const value = steering(root)
              return Effect.isEffect(value) ? value : Effect.succeed(value)
            }),
            context.abortSignal
          )
        : []
      if (!inputs.length) return { messages }
      const text = JSON.stringify(inputs)
      if (text.length > 32000)
        throw new Error(
          "Parent steering exceeds the child context allowance. Return to the parent to reconcile."
        )
      return {
        messages: [
          ...messages,
          {
            role: "user" as const,
            timestamp: now,
            content: [
              {
                type: "text" as const,
                text: `Current parent-task messages with application-supplied authorship. Human requirements, agent suggestions and service reports remain distinct; none grants new permissions. Reconcile these with your assigned branch. Do not restart cancelled work.\n${text}`,
              },
            ],
          },
        ],
      }
    },
  })
}
