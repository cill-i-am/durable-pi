import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { AgentId, AgentProfile } from "@/agents/contracts"

const fields = Schema.Struct({
  name: Schema.String,
  instructions: Schema.String,
})
const attempt = Schema.Struct({
  ...fields.fields,
  id: Schema.toType(AgentId),
  revision: Schema.Number,
  action: Schema.Literals(["create", "update"]),
})
export type AgentSave = typeof attempt.Type
const context = Schema.Struct({
  id: Schema.toType(AgentId),
  draft: fields,
  revision: Schema.Number,
  existing: Schema.Boolean,
  attempt: Schema.NullOr(attempt),
  receipt: Schema.NullOr(Schema.toType(AgentProfile)),
  error: Schema.String,
  failure: Schema.Unknown,
})
const errorMessage = Schema.Struct({ message: Schema.String })
const rejectedRequest = Schema.Struct({ status: Schema.Number })
function message(cause: Cause.Cause<unknown>) {
  const reason = cause.reasons.find((reason) => reason._tag === "Fail")
  return reason?._tag === "Fail" && Schema.is(errorMessage)(reason.error)
    ? reason.error.message
    : "Could not confirm this save. Try saving again to check the same request."
}
function rejected(cause: Cause.Cause<unknown>) {
  const reason = cause.reasons.length === 1 ? cause.reasons[0] : undefined
  return (
    reason?._tag === "Fail" &&
    Schema.is(rejectedRequest)(reason.error) &&
    reason.error.status >= 400 &&
    reason.error.status < 500 &&
    reason.error.status !== 408
  )
}

/** The acknowledgement belongs to its immutable fields, never to later edits.
 * A known receipt can only retry list reconciliation, not creation. */
export function agentEditorMachine(work: {
  save: (input: AgentSave) => Effect.Effect<AgentProfile, unknown>
  reconcile: (profile: AgentProfile) => Effect.Effect<void, unknown>
  close: Effect.Effect<void>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: Schema.Struct({
        id: Schema.toType(AgentId),
        agent: Schema.NullOr(Schema.toType(AgentProfile)),
      }),
      context,
      events: {
        CHANGE: Schema.Struct({
          field: Schema.Literals(["name", "instructions"]),
          value: Schema.String,
        }),
        SAVE: Schema.Struct({}),
        RECONCILE: Schema.Struct({}),
        DISMISS: Schema.Struct({}),
      },
    },
    actors: {
      save: createEffectLogic(({ input }: { input: AgentSave }) =>
        Effect.exit(work.save(input))
      ),
      reconcile: createEffectLogic(({ input }: { input: AgentProfile }) =>
        Effect.exit(work.reconcile(input))
      ),
      close: createEffectLogic(() => work.close),
    },
  }).createMachine({
    id: "agent-editor",
    initial: "ready",
    context: ({ input }) => ({
      id: input.id,
      draft: {
        name: input.agent?.name ?? "",
        instructions: input.agent?.instructions ?? "",
      },
      revision: 0,
      existing: input.agent !== null,
      attempt: null,
      receipt: null,
      error: "",
      failure: null,
    }),
    on: {
      CHANGE: ({ context, event }) => ({
        context: {
          ...context,
          draft: { ...context.draft, [event.field]: event.value },
          revision: context.revision + 1,
        },
      }),
    },
    states: {
      ready: {
        on: {
          SAVE: ({ context }) =>
            context.draft.name.trim()
              ? {
                  target: "saving",
                  context: {
                    ...context,
                    error: "",
                    failure: null,
                    attempt: context.attempt ?? {
                      id: context.id,
                      name: context.draft.name.trim(),
                      instructions: context.draft.instructions,
                      revision: context.revision,
                      action: context.existing ? "update" : "create",
                    },
                  },
                }
              : {},
          DISMISS: { target: "closing" },
        },
      },
      saving: {
        invoke: {
          src: "save",
          input: ({ context }) => context.attempt!,
          onDone: ({ context, event }) =>
            Exit.isSuccess(event.output)
              ? {
                  target: "reconciling",
                  context: {
                    ...context,
                    receipt: event.output.value,
                    existing: true,
                  },
                }
              : {
                  target: "ready",
                  context: {
                    ...context,
                    error: message(event.output.cause),
                    attempt: rejected(event.output.cause)
                      ? null
                      : context.attempt,
                    failure: event.output.cause,
                  },
                },
        },
      },
      reconciling: {
        invoke: {
          src: "reconcile",
          input: ({ context }) => context.receipt!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "refreshFailed",
                  context: {
                    ...context,
                    error:
                      "Agent saved, but the list could not refresh. Try refreshing it.",
                    failure: event.output.cause,
                  },
                }
              : context.revision === context.attempt!.revision
                ? { target: "closing" }
                : {
                    target: "ready",
                    context: {
                      ...context,
                      attempt: null,
                      error: "",
                      failure: null,
                    },
                  },
        },
      },
      refreshFailed: {
        on: {
          RECONCILE: { target: "reconciling" },
          DISMISS: { target: "closing" },
        },
      },
      closing: { invoke: { src: "close", onDone: { target: "closed" } } },
      closed: { type: "final" },
    },
  })
}
