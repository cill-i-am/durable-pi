import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Deferred, Effect, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { FamilySnapshot } from "../../family/contracts"

const reply = Schema.declare((value): value is Deferred.Deferred<void> =>
  Deferred.isDeferred(value)
)
export type FamilyRead =
  | { type: "ready"; family: FamilySnapshot }
  | { type: "ended" }
  | { type: "failed"; error: string }
const context = Schema.Struct({
  family: Schema.NullOr(FamilySnapshot),
  error: Schema.String,
  queued: Schema.Boolean,
  replies: Schema.Array(reply),
})
export function familyAccessMachine(ports: {
  read: Effect.Effect<FamilyRead>
  signOut: Effect.Effect<boolean>
  leave: Effect.Effect<void>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context,
      events: {
        REFRESH: Schema.Struct({ reply: Schema.NullOr(reply) }),
        SIGN_OUT: Schema.Struct({}),
      },
    },
    actors: {
      read: createEffectLogic(() => ports.read),
      signOut: createEffectLogic(() => ports.signOut),
    },
    actions: {
      answer: ({ params }: { params?: unknown }) =>
        Effect.forEach(
          Schema.decodeUnknownSync(Schema.Array(reply))(params),
          (reply) => Deferred.succeed(reply, undefined),
          { discard: true }
        ),
      leave: (_args: unknown) => ports.leave,
    },
  }).createMachine({
    id: "family-access",
    context: { family: null, error: "", queued: false, replies: [] },
    initial: "loading",
    on: {
      REFRESH: (args, enq) => {
        if (args.event.reply)
          enq(args.actions.answer, { ...args, params: [args.event.reply] })
        return {}
      },
    },
    states: {
      loading: {
        on: {
          REFRESH: ({ context, event }) => ({
            context: {
              ...context,
              queued: true,
              replies: event.reply
                ? [...context.replies, event.reply]
                : context.replies,
            },
          }),
        },
        invoke: {
          src: "read",
          onDone: (args, enq) => {
            const { context, event } = args
            if (context.queued && event.output.type !== "ended")
              return {
                target: "loading",
                reenter: true,
                context: { ...context, queued: false },
              }
            enq(args.actions.answer, { ...args, params: context.replies })
            const result = event.output
            return {
              target: result.type,
              context: {
                ...context,
                replies: [],
                family:
                  result.type === "ended"
                    ? null
                    : result.type === "ready"
                      ? result.family
                      : context.family,
                error: result.type === "failed" ? result.error : "",
              },
            }
          },
        },
      },
      ready: {
        after: { 30_000: { target: "loading" } },
        on: {
          REFRESH: ({ context, event }) => ({
            target: "loading",
            context: { ...context, replies: event.reply ? [event.reply] : [] },
          }),
        },
      },
      failed: {
        after: { 30_000: { target: "loading" } },
        on: {
          REFRESH: ({ context, event }) => ({
            target: "loading",
            context: { ...context, replies: event.reply ? [event.reply] : [] },
          }),
        },
      },
      ended: { on: { SIGN_OUT: { target: "signingOut" } } },
      signingOut: {
        invoke: {
          src: "signOut",
          onDone: (args, enq) => {
            if (args.event.output) enq(args.actions.leave, args)
            return {
              target: "ended",
              context: {
                ...args.context,
                error: args.event.output
                  ? ""
                  : "Could not sign out. Please try again.",
              },
            }
          },
        },
      },
    },
  })
}
