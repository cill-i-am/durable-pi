import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { AccessState, Approval, ToolPolicy } from "@/access/contracts"

import {
  accessFailureMessage,
  futurePermissionCurrent,
  sameApproval,
} from "./decision"

export const ApprovalView = Schema.Struct({
  agentId: Schema.String,
  approval: Approval,
  disabled: Schema.Boolean,
  policy: Schema.NullOr(ToolPolicy),
})
export type ApprovalView = typeof ApprovalView.Type
export const ApprovalRequest = Schema.Struct({
  view: ApprovalView,
  approve: Schema.Boolean,
  remember: Schema.Boolean,
})
export type ApprovalRequest = typeof ApprovalRequest.Type
const confirmed = Schema.Struct({
  approval: Approval,
  revision: Schema.Number,
  policy: Schema.NullOr(ToolPolicy),
  approve: Schema.Boolean,
  remember: Schema.Boolean,
})
const context = Schema.Struct({
  view: ApprovalView,
  request: Schema.NullOr(ApprovalRequest),
  confirmed: Schema.NullOr(confirmed),
  error: Schema.String,
  failure: Schema.UndefinedOr(Schema.Unknown),
})
export const sameApprovalView = (a: ApprovalView, b: ApprovalView) =>
  a.agentId === b.agentId &&
  sameApproval(a.approval, b.approval) &&
  a.approval.revision === b.approval.revision
function permitted(view: ApprovalView, request: ApprovalRequest) {
  return (
    sameApprovalView(view, request.view) &&
    !view.disabled &&
    view.approval.status === "pending" &&
    (!request.remember ||
      (request.approve &&
        view.policy?.name === view.approval.tool &&
        view.policy.mode !== "deny" &&
        view.policy.revision === request.view.policy?.revision))
  )
}
export function approvalMachine(
  work: (
    request: ApprovalRequest
  ) => Effect.Effect<AccessState, unknown, Scope.Scope>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: ApprovalView,
      context,
      events: { VIEW: ApprovalView, SUBMIT: ApprovalRequest },
    },
    actors: {
      submit: createEffectLogic(({ input }: { input: ApprovalRequest }) =>
        Effect.exit(work(input))
      ),
    },
  }).createMachine({
    id: "approval-ui",
    initial: "ready",
    context: ({ input }) => ({
      view: input,
      request: null,
      confirmed: null,
      error: "",
      failure: undefined,
    }),
    on: {
      VIEW: ({ context, event }) => ({
        context: {
          ...context,
          view: Schema.decodeUnknownSync(ApprovalView)(event),
          confirmed: sameApprovalView(context.view, event)
            ? context.confirmed?.remember &&
              !futurePermissionCurrent(context.confirmed, event.policy)
              ? { ...context.confirmed, remember: false }
              : context.confirmed
            : null,
        },
      }),
    },
    states: {
      ready: {
        on: {
          SUBMIT: ({ context, event }) => {
            const request = Schema.decodeUnknownSync(ApprovalRequest)(event)
            return permitted(context.view, request) && !context.confirmed
              ? {
                  target: "submitting",
                  context: {
                    ...context,
                    request,
                    error: "",
                    failure: undefined,
                  },
                }
              : undefined
          },
        },
      },
      submitting: {
        invoke: {
          src: "submit",
          input: ({ context }) => context.request!,
          onDone: ({ context, event }) => {
            const request = context.request!
            if (!sameApprovalView(context.view, request.view))
              return {
                target: "ready",
                context: {
                  ...context,
                  request: null,
                  error: "",
                  failure: Exit.isFailure(event.output)
                    ? event.output.cause
                    : undefined,
                },
              }
            if (Exit.isFailure(event.output))
              return {
                target: "uncertain",
                context: {
                  ...context,
                  error: accessFailureMessage(
                    event.output.cause,
                    "The decision could not be confirmed. Check the action status or retry the same decision."
                  ),
                  failure: event.output.cause,
                },
              }
            if (
              request.remember &&
              event.output.value.tools.find(
                (tool) => tool.name === request.view.approval.tool
              )?.mode !== "allow"
            )
              return {
                target: "uncertain",
                context: {
                  ...context,
                  error:
                    "Tool access changed. Refresh before allowing future calls.",
                },
              }
            const decision = {
              approval: request.view.approval,
              revision: request.view.approval.revision,
              approve: request.approve,
              remember: request.remember,
              policy:
                event.output.value.tools.find(
                  (tool) => tool.name === request.view.approval.tool
                ) ?? null,
            }
            return {
              target: "ready",
              context: {
                ...context,
                request: null,
                error: "",
                confirmed: {
                  ...decision,
                  remember: futurePermissionCurrent(
                    decision,
                    context.view.policy
                  ),
                },
              },
            }
          },
        },
      },
      uncertain: {
        always: ({ context }) =>
          !sameApprovalView(context.view, context.request!.view) ||
          context.view.approval.status !== "pending"
            ? {
                target: "ready",
                context: { ...context, request: null, error: "" },
              }
            : undefined,
        on: {
          SUBMIT: ({ context, event }) => {
            const request = Schema.decodeUnknownSync(ApprovalRequest)(event)
            return permitted(context.view, context.request!) &&
              sameApprovalView(context.view, request.view) &&
              request.approve === context.request?.approve &&
              request.remember === context.request.remember
              ? {
                  target: "submitting",
                  context: { ...context, error: "", failure: undefined },
                }
              : undefined
          },
        },
      },
    },
  })
}
