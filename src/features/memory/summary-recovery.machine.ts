import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { CompactionRecovery } from "@/conversations/contracts"
import { SummaryIssue } from "@/memory/domain"

export const SummaryRecoveryView = Schema.Struct({
  issues: Schema.Array(SummaryIssue),
  recovery: Schema.NullOr(CompactionRecovery),
})
export type SummaryRecoveryView = typeof SummaryRecoveryView.Type
export const SummaryRecoveryRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("summary"),
    start: SummaryIssue.fields.start,
    count: SummaryIssue.fields.count,
    attempts: SummaryIssue.fields.attempts,
  }),
  Schema.Struct({ kind: Schema.Literal("scheduler"), epoch: Schema.String }),
])
export type SummaryRecoveryRequest = typeof SummaryRecoveryRequest.Type
export const recoveryRequestKey = (request: SummaryRecoveryRequest) =>
  request.kind === "scheduler"
    ? `scheduler:${request.epoch}`
    : `summary:${request.start}+${request.count}:${request.attempts}`
export const currentRecoveryRequest = (
  view: SummaryRecoveryView,
  request: SummaryRecoveryRequest
) =>
  request.kind === "scheduler"
    ? view.recovery?.epoch === request.epoch
    : view.issues.some(
        (issue) =>
          issue.retryAt === null &&
          issue.start === request.start &&
          issue.count === request.count &&
          issue.attempts === request.attempts
      )
const outcome = Schema.declare((value): value is Exit.Exit<void, unknown> =>
  Exit.isExit(value)
)
const context = Schema.Struct({
  view: SummaryRecoveryView,
  request: Schema.NullOr(SummaryRecoveryRequest),
  outcome: Schema.UndefinedOr(outcome),
  acknowledged: Schema.Array(SummaryRecoveryRequest),
})

/** One explicit command at a time. Server views alone own recovery facts. */
export function summaryRecoveryMachine(
  request: (
    input: SummaryRecoveryRequest
  ) => Effect.Effect<void, unknown, Scope.Scope>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: SummaryRecoveryView,
      context,
      events: {
        SUBMIT: Schema.Struct({ request: SummaryRecoveryRequest }),
        VIEW: SummaryRecoveryView,
      },
    },
    actors: {
      request: createEffectLogic(
        ({ input }: { input: SummaryRecoveryRequest }) =>
          Effect.exit(request(input))
      ),
    },
  }).createMachine({
    id: "memory-summary-recovery",
    initial: "ready",
    context: ({ input }) => ({
      view: input,
      request: null,
      outcome: undefined,
      acknowledged: [],
    }),
    on: {
      VIEW: ({ context, event }) => {
        const view = Schema.decodeUnknownSync(SummaryRecoveryView)(event)
        return {
          context: {
            ...context,
            view,
            acknowledged: context.acknowledged.filter((request) =>
              currentRecoveryRequest(view, request)
            ),
          },
        }
      },
    },
    states: {
      ready: {
        on: {
          SUBMIT: ({ context, event }) =>
            currentRecoveryRequest(context.view, event.request) &&
            !context.acknowledged.some(
              (request) =>
                recoveryRequestKey(request) ===
                recoveryRequestKey(event.request)
            )
              ? {
                  target: "requesting",
                  context: {
                    ...context,
                    request: event.request,
                    outcome: undefined,
                  },
                }
              : undefined,
        },
      },
      requesting: {
        invoke: {
          src: "request",
          input: ({ context }) => context.request!,
          onDone: ({ context, event }) => ({
            target: "ready",
            context: {
              ...context,
              outcome: event.output,
              acknowledged:
                Exit.isSuccess(event.output) &&
                context.request?.kind === "scheduler" &&
                currentRecoveryRequest(context.view, context.request!)
                  ? [...context.acknowledged, context.request!]
                  : context.acknowledged,
            },
          }),
        },
      },
    },
  })
}
