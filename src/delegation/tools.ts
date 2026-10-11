import { Effect } from "effect"
import {
  defineTool,
  hook,
  GenerationTask,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable"
import { Type } from "@earendil-works/pi-ai"
import type { Delegations } from "./delegations"
import { validateBrief, type DelegationSource } from "./delegation"
import { backgroundBrief, type BackgroundInput } from "./background"
import type { DelegationFailure } from "./contracts"

export function backgroundTool(
  run: (
    input: BackgroundInput,
    api: ToolExecutionApi
  ) => Effect.Effect<string, DelegationFailure>
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
      backgroundBrief(input)
      return {
        content: [
          {
            type: "text",
            text: await Effect.runPromise(run(input, api), {
              signal: context.abortSignal,
            }),
          },
        ],
      }
    },
  })
}

export const delegationInstructions = `For substantial requests with independent research or drafting branches, delegate_tasks can run one group of up to three child tasks. Use it when parallel help improves the result, not for ordinary questions. Each child inherits your pinned model and gets only explicitly selected read tools and this bot's reference context. Include relevant user constraints in every brief. You remain responsible for evaluating their findings and completing the request. Children cannot perform outside actions or spawn agents. Delegation uses existing tool permissions. Do not promise background work: this group belongs to the current request and Stop cancels it. One combined report returns when children finish. Do not redelegate completed tasks.`
export function delegationTool(
  delegations: Delegations,
  source: (api: ToolExecutionApi) => DelegationSource
) {
  return defineTool({
    name: "delegate_tasks",
    description:
      "Run one bounded group of up to three independent research/drafting tasks for this request. Give each a distinct name, concrete brief with constraints, and explicit read-tool list. Inherits the parent model; no recursive delegation or outside actions. Returns combined findings once. Owner can inspect, steer or stop children in Activity.",
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
                "read_note",
              ].map((name) => Type.Literal(name))
            ),
            { maxItems: 6 }
          ),
        }),
        { minItems: 1, maxItems: 3 }
      ),
    }),
    execute: async (input, api, context) => ({
      content: [
        {
          type: "text",
          text: await Effect.runPromise(
            delegations.run(validateBrief(input), source(api)),
            { signal: context.abortSignal }
          ),
        },
      ],
    }),
  })
}

export function childSteeringHook(
  delegations: Delegations,
  steering: (turnId: string) => readonly { id: string; text: string }[]
) {
  return hook(GenerationTask, {
    beforeRequest: async ({ messages }, api, context) => {
      const root = await Effect.runPromise(
        delegations.root(Number(api.conversationId)),
        { signal: context.abortSignal }
      )
      const inputs = root ? steering(root) : []
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
            timestamp: Date.now(),
            content: [
              {
                type: "text" as const,
                text: `Current parent-task steering (original user requirements; no new permissions). Reconcile these with your assigned branch. Do not restart cancelled work.\n${text}`,
              },
            ],
          },
        ],
      }
    },
  })
}
