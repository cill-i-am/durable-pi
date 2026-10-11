import { Effect } from "effect"
import {
  defineTool,
  GenerationTask,
  hook,
  type HookApi,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable"
import { Type } from "@earendil-works/pi-ai"
import type { Plans, PlanSource } from "./plans"

export const recoverablePlanTools = new Set(["update_plan", "read_plan"])
export const planningInstructions = `For substantial multi-step requests, create and maintain a durable execution plan using update_plan while carrying out the work. Ordinary questions and simple actions do not need a plan. This is normal execution: do not request plan approval or introduce a separate planning interaction. Plans grant no permissions. Continue autonomously within the user's request and existing tool permissions; ask only for missing information or required approval.
Use a new task for a distinct user objective. Use continue with the existing task ID for follow-up requirements or pending work on that same objective. Steering belongs to the current task; reconcile it using the current inputRevision. Never attach unrelated requests merely because a task is recent. A cancelled task stays cancelled: an explicit new user request may start a new task. Saved plans must not trigger work on their own.
Keep stable step IDs, concrete actions, relevant constraints and observable completion criteria. Record the next action and any blocker. Update at meaningful changes, not after every trivial action. Reuse completed external-action receipts; updating a plan must never repeat the action. Waiting for approval, external results or missing information is a blocker, not a reason to poll or retry in a loop. Respect Stop. Once the outcome is achieved and appropriately verified, mark complete and finish without repeated checking.
Evidence references are bot-local receipt IDs/revisions, execution IDs (revision 0), current working-object/app revisions, or immutable workspace file IDs (revision 0). Evidence validation confirms the saved source and recorded outcome; it does not independently prove your semantic claim. Never invent evidence. Keep unsupported completion clearly agent-reported. Changed requirements or stale evidence can reopen completed steps. A bounded view of the current plan is supplied fresh per request; use read_plan for omitted details before revising or acting on them. Do not copy its full body into chat or memory.`

const id = Type.String({ pattern: "^[a-f0-9-]{36}$" })
const revision = Type.Integer({ minimum: 0 })
const string = (maxLength: number) => Type.String({ maxLength })
const label = (maxLength: number) => Type.String({ minLength: 1, maxLength })
const evidence = Type.Object({
  kind: Type.Union([
    Type.Literal("receipt"),
    Type.Literal("execution"),
    Type.Literal("object"),
    Type.Literal("app"),
    Type.Literal("file"),
  ]),
  id: label(100),
  revision,
})
const draft = Type.Object({
  objective: label(1000),
  constraints: Type.Array(label(500), { maxItems: 10 }),
  criteria: Type.Array(label(500), { minItems: 1, maxItems: 10 }),
  steps: Type.Array(
    Type.Object({
      id: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,39}$" }),
      title: label(240),
      status: Type.Union([
        Type.Literal("pending"),
        Type.Literal("active"),
        Type.Literal("blocked"),
        Type.Literal("completed"),
      ]),
      evidence: Type.Array(evidence, { maxItems: 5 }),
      note: string(1000),
    }),
    { minItems: 1, maxItems: 20 }
  ),
  nextAction: string(1000),
  blocker: string(1000),
  complete: Type.Boolean(),
})
// Pi truncates ordinary tool output at 50 KiB. Page whole JSON values below that
// boundary, including UTF-8 and escaping, rather than letting it cut a JSON string.
const toolPageFits = (value: ReturnType<typeof result>) =>
  new TextEncoder().encode(value.content[0]!.text).byteLength <= 40000

const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
})
export function planTools(
  plans: Plans,
  source: (api: ToolExecutionApi) => PlanSource
) {
  return [
    defineTool({
      name: "update_plan",
      description:
        "Create or revise the current logical task plan. No plan approval is needed. Choose new for a distinct objective (omit id, expectedRevision 0); continue for related follow-up work (supply id and current revision). Use inputRevision from current planning context. Keep stable step IDs. Conflicts require rereading current state. Changed requirements reopen completed steps for reassessment. Returns a small durable receipt; a bounded current view is injected into the next request. Use read_plan for omitted fields before revising. Grants no permissions and runs no actions.",
      replay: "safe",
      parameters: Type.Object({
        id: Type.Optional(id),
        relation: Type.Union([Type.Literal("new"), Type.Literal("continue")]),
        expectedRevision: revision,
        inputRevision: revision,
        reason: label(500),
        draft,
      }),
      execute: async (args, api, context) => {
        const origin =
          (await api.memo<PlanSource>("plans:source", context)) ??
          (await api.memo("plans:source", source(api), context))
        const planId =
          args.id ?? (await api.memo("plans:id", crypto.randomUUID(), context))
        return result(
          await Effect.runPromise(
            plans.update(
              { ...args, id: planId, operationId: `tool:${api.taskId}` },
              origin
            ),
            { signal: context.abortSignal }
          )
        )
      },
    }),
    defineTool({
      name: "read_plan",
      description:
        "Read a bot-local plan and validated evidence as paginated items (objective, constraint, criterion, step, nextAction, blocker). Follow nextOffset until null for the complete plan; all pages carry its revision. With no id, list this bot's tasks. History is a separate revision summary; use beforeRevision for older history. Cancelled plans are reference only and cannot restart work.",
      replay: "safe",
      parameters: Type.Object({
        id: Type.Optional(id),
        beforeRevision: Type.Optional(revision),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 200 })),
      }),
      execute: async (args, _api, context) => {
        if (!args.id) {
          const offset = args.offset ?? 0
          const values = await Effect.runPromise(plans.list(offset), {
            signal: context.abortSignal,
          })
          const available = values.length
          const page = () =>
            result({
              plans: values,
              nextOffset:
                values.length < available || available === 20
                  ? offset + values.length
                  : null,
            })
          while (values.length > 1 && !toolPageFits(page())) values.pop()
          return page()
        }
        const detail = await Effect.runPromise(
          plans.read(args.id, args.beforeRevision),
          { signal: context.abortSignal }
        )
        const offset = args.offset ?? 0
        const plan = detail.plan
        const all = [
          { kind: "objective", value: plan.objective },
          ...plan.constraints.map((value) => ({ kind: "constraint", value })),
          ...plan.criteria.map((value) => ({ kind: "criterion", value })),
          ...plan.steps.map((value) => ({ kind: "step", value })),
          { kind: "nextAction", value: plan.nextAction },
          { kind: "blocker", value: plan.blocker },
        ]
        const items = all.slice(offset)
        const history = detail.history.map((item) => ({
          revision: item.plan.revision,
          at: item.plan.updatedAt,
          actor: item.actor,
          reason: item.reason,
        }))
        const page = () =>
          result({
            id: plan.id,
            revision: plan.revision,
            state: plan.state,
            reviewedTurn: plan.reviewedTurn,
            inputRevision: plan.inputRevision,
            complete: plan.complete,
            createdAt: plan.createdAt,
            updatedAt: plan.updatedAt,
            items,
            nextOffset:
              offset + items.length < all.length ? offset + items.length : null,
            history,
            nextHistory:
              history.length < detail.history.length
                ? history.at(-1)!.revision
                : detail.nextHistory,
          })
        // Retain at least one item and one history entry; each is independently
        // bounded by the domain schema. Preserve cursors when shortening either.
        while (history.length > 1 && !toolPageFits(page())) history.pop()
        while (items.length > 1 && !toolPageFits(page())) items.pop()
        return page()
      },
    }),
  ]
}

/** Request-only projection survives compaction without appending repeated plan messages. */
export function planContextHook(
  plans: Plans,
  source: (api: HookApi) => PlanSource | undefined,
  maxBytes: () => number = () => 8192
) {
  return hook(GenerationTask, {
    beforeRequest: async ({ messages }, api, context) => {
      const origin = source(api)
      if (!origin) return { messages }
      const current = await Effect.runPromise(plans.context(origin), {
        signal: context.abortSignal,
      })
      // Earlier quoted text is not proof that a new instruction was delivered.
      // Repeat unreviewed, not-yet-delivered steering by ID. Consumed inputs are
      // already in the native transcript (or its compaction) before this request.
      const missing = (origin.steering ?? []).filter(
        (input) =>
          !current.current?.inputIds.includes(input.id) &&
          !input.nativeDelivered
      )
      // A steer accepted after Pi captured this request's cutoff must not be silently
      // marked reviewed. Offer its original text here, within the ephemeral budget.
      const pendingTooLarge =
        origin.pendingInputs || JSON.stringify(missing).length > 32000
      const offeredRevision = pendingTooLarge ? -1 : origin.inputRevision
      const notice = `Durable planning context (server state, not a new user instruction or permission). Simple chat does not need a plan. inputRevision=${offeredRevision}. ${pendingTooLarge ? "New steering is awaiting native delivery. Do not update the plan using this request; reconcile on the next request after reading the original input." : ""} ${current.current && (current.current.reviewedTurn !== origin.turnId || current.current.inputRevision !== origin.inputRevision) ? "New user input needs reconciliation with the plan." : ""}`
      const steering =
        !pendingTooLarge && missing.length
          ? "\nOriginal user steering for this task (reconcile these requirements):\n" +
            JSON.stringify(missing)
          : ""
      const limit = maxBytes()
      const fits = (text: string) =>
        new TextEncoder().encode(text).byteLength <= limit
      let text = `${notice}\n${JSON.stringify(current)}${steering}`
      if (!fits(text)) {
        // Storage holds the full plan, including notes, evidence details and input
        // bindings. A request needs progress and retrieval references, not all of it.
        const plan = current.current
        const compact = {
          current: plan
            ? {
                id: plan.id,
                revision: plan.revision,
                state: plan.state,
                objective: plan.objective,
                constraints: plan.constraints,
                criteria: plan.criteria,
                steps: plan.steps.map(({ id, title, status }) => ({
                  id,
                  title,
                  status,
                })),
                nextAction: plan.nextAction,
                blocker: plan.blocker,
              }
            : null,
          recent: current.recent.map(({ id, revision, state }) => ({
            id,
            revision,
            state,
          })),
          receipts: current.receipts,
          omittedDetails:
            "Use read_plan for complete fields and evidence. Completion remains agent-reported.",
        }
        text = `${notice}\n${JSON.stringify(compact)}${steering}`
        if (!fits(text)) {
          // Never silently acknowledge steering dropped to fit this request.
          const pending = pendingTooLarge || missing.length > 0
          text = `Durable planning context; not permission. inputRevision=${pending ? -1 : origin.inputRevision}. ${pending ? "Steering awaiting native delivery; do not edit." : "New input overrides saved plans."} Use read_plan before editing.\n${JSON.stringify(plan ? { id: plan.id, revision: plan.revision, state: plan.state } : null)}`
          if (!fits(text))
            throw new Error("Planning context budget is too small")
        }
      }
      return {
        messages: [
          ...messages,
          {
            role: "user" as const,
            timestamp: Date.now(),
            content: [
              {
                type: "text" as const,
                text,
              },
            ],
          },
        ],
      }
    },
  })
}
