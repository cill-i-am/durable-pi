import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Deferred, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import {
  FamilyObservation,
  FamilyState,
  type FamilyAdmissionError,
  type FamilyDecision,
  type FamilyGeneration,
} from "./family"

type Reply = Deferred.Deferred<FamilyDecision, FamilyAdmissionError>
const Reply = Schema.declare((value): value is Reply =>
  Deferred.isDeferred(value)
)
const Response = Schema.Struct({
  waiters: Schema.Array(Reply),
  outcome: Schema.declare(
    (value): value is Exit.Exit<FamilyDecision, FamilyAdmissionError> =>
      Exit.isExit(value)
  ),
})

/** One host-scoped owner serializes generation changes. Live directory reads
 * remain concurrent, and epochs fence observations begun before a change. */
export function familyGenerationMachine(work: {
  fence: () => Effect.Effect<void, FamilyAdmissionError>
  write: (record: FamilyGeneration) => Effect.Effect<void>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        epoch: Schema.Number,
        state: Schema.NullOr(FamilyState),
        waiters: Schema.Array(Reply),
      }),
      events: {
        OBSERVED: Schema.Struct({ ...FamilyObservation.fields, reply: Reply }),
      },
    },
    actions: {
      reply: ({ params }: { params?: unknown }) => {
        const response = Schema.decodeUnknownSync(Response)(params)
        return Effect.forEach(
          response.waiters,
          (waiter) => Deferred.done(waiter, response.outcome),
          { discard: true }
        )
      },
    },
    actors: {
      fence: createEffectLogic(Effect.exit(Effect.suspend(work.fence))),
      write: createEffectLogic(({ input }: { input: string | null }) =>
        Effect.exit(
          work.write({
            schemaVersion: 1,
            workflowVersion: 1,
            membershipId: input,
          })
        )
      ),
    },
  }).createMachine({
    id: "family-generation",
    context: () => ({
      epoch: 0,
      state: null as FamilyState | null,
      waiters: [] as Reply[],
    }),
    initial: "ready",
    on: {
      OBSERVED: ({ context, event }) => ({
        context: { ...context, waiters: [...context.waiters, event.reply] },
      }),
    },
    states: {
      ready: {
        on: {
          OBSERVED: (args, enq) => {
            const { context, event, actions } = args
            if (event.epoch !== context.epoch) {
              enq(actions.reply, {
                ...args,
                params: {
                  waiters: [event.reply],
                  outcome: Exit.succeed({ type: "retry" }),
                },
              })
              return
            }
            const cleanup =
              (!event.state && event.previous !== null) ||
              (event.state &&
                event.previous !== undefined &&
                event.previous !== event.state.membershipId)
            if (
              cleanup ||
              event.needsMigration ||
              event.previous !== (event.state?.membershipId ?? null)
            )
              return {
                target: cleanup ? "fencing" : "persisting",
                context: {
                  epoch: context.epoch + 1,
                  state: event.state,
                  waiters: [event.reply],
                },
              }
            enq(actions.reply, {
              ...args,
              params: {
                waiters: [event.reply],
                outcome: Exit.succeed({ type: "admitted", state: event.state }),
              },
            })
          },
        },
      },
      fencing: {
        invoke: {
          src: "fence",
          onDone: (args, enq) => {
            const { context, event, actions } = args
            if (Exit.isFailure(event.output)) {
              enq(actions.reply, {
                ...args,
                params: {
                  waiters: context.waiters,
                  outcome: Exit.failCause(event.output.cause),
                },
              })
              return { target: "ready", context: { ...context, waiters: [] } }
            }
            return { target: "persisting" }
          },
        },
      },
      persisting: {
        invoke: {
          src: "write",
          input: ({ context }) => context.state?.membershipId ?? null,
          onDone: (args, enq) => {
            const { context, event, actions } = args
            enq(actions.reply, {
              ...args,
              params: {
                waiters: context.waiters,
                outcome: Exit.isFailure(event.output)
                  ? Exit.failCause(event.output.cause)
                  : Exit.succeed({ type: "retry" }),
              },
            })
            return { target: "ready", context: { ...context, waiters: [] } }
          },
        },
      },
    },
  })
}
