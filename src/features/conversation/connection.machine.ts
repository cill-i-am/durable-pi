import type { StreamChunk } from "@tanstack/ai"
import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { ConversationCursor } from "@/conversations/contracts"

export class ConversationConnectionFailure extends Schema.TaggedError<ConversationConnectionFailure>()(
  "ConversationConnectionFailure",
  { error: Schema.Unknown, terminal: Schema.Boolean }
) {}
export const ConnectionChunk = Schema.declare(
  (value): value is StreamChunk =>
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
)
const reply = Schema.declare((value): value is Deferred.Deferred<void> =>
  Deferred.isDeferred(value)
)
const frame = Schema.Struct({
  chunk: ConnectionChunk,
  cursor: Schema.NullOr(Schema.toType(ConversationCursor)),
  attempt: Schema.Number,
  reply,
})
const delivery = Schema.Struct({ ...frame.fields, first: Schema.Boolean })
const context = Schema.Struct({
  failures: Schema.Number,
  attempt: Schema.Number,
  received: Schema.Boolean,
  cursor: Schema.NullOr(Schema.toType(ConversationCursor)),
  error: Schema.Unknown,
})

/** The application has one five-failure reconnect budget. Receipt of any frame
 * resets it; permission failures and scope closure cannot authorize another read. */
export function conversationConnectionMachine(work: {
  read: (
    cursor: ConversationCursor | null,
    attempt: number
  ) => Effect.Effect<void, ConversationConnectionFailure>
  publish: (
    chunk: StreamChunk,
    first: boolean,
    reply: Deferred.Deferred<void>
  ) => Effect.Effect<void>
  interrupted: Effect.Effect<void>
  finish: (error: unknown) => Effect.Effect<void>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: { context, events: { FRAME: frame, STOP: Schema.Struct({}) } },
    actors: {
      read: createEffectLogic(
        ({
          input,
        }: {
          input: { cursor: ConversationCursor | null; attempt: number }
        }) => Effect.exit(work.read(input.cursor, input.attempt))
      ),
      finish: createEffectLogic(({ input }: { input: unknown }) =>
        work.finish(input)
      ),
      delay: createEffectLogic(({ input }: { input: number }) =>
        Effect.andThen(
          input > 0 ? work.interrupted : Effect.void,
          Effect.sleep(Math.min(250 * 2 ** input, 4000))
        )
      ),
    },
    actions: {
      publish: ({ params }: { params?: unknown }) => {
        const value = Schema.decodeUnknownSync(delivery)(params)
        return work.publish(value.chunk, value.first, value.reply)
      },
      acknowledge: ({ params }: { params?: unknown }) =>
        Deferred.succeed(Schema.decodeUnknownSync(reply)(params), undefined),
    },
  }).createMachine({
    id: "conversation-connection",
    initial: "reading",
    context: () => ({
      failures: 0,
      attempt: 1,
      received: false,
      cursor: null,
      error: null,
    }),
    on: { STOP: { target: ".closed" } },
    states: {
      reading: {
        on: {
          FRAME: (args, enq) => {
            const { context, event } = args
            if (event.attempt !== context.attempt) {
              enq(args.actions.acknowledge, { ...args, params: event.reply })
              return {}
            }
            enq(args.actions.publish, {
              ...args,
              params: { ...event, first: !context.received },
            })
            return {
              context: {
                ...context,
                received: true,
                failures: 0,
                cursor: event.cursor ?? context.cursor,
              },
            }
          },
        },
        invoke: {
          src: "read",
          input: ({ context }) => context,
          onDone: (args) => {
            const { context, event } = args
            if (Exit.isSuccess(event.output) && context.received)
              return { target: "waiting" }
            if (Exit.isFailure(event.output)) {
              const cause = event.output.cause
              const failure =
                cause.reasons.length === 1 && cause.reasons[0]?._tag === "Fail"
                  ? cause.reasons[0].error
                  : undefined
              if (
                !failure ||
                Cause.hasDies(cause) ||
                Cause.hasInterrupts(cause) ||
                failure.terminal
              )
                return {
                  target: "failed",
                  context: { ...context, error: failure?.error ?? cause },
                }
            }
            const failures = context.failures + 1
            if (failures >= 5)
              return {
                target: "failed",
                context: {
                  ...context,
                  failures,
                  error: new Error(
                    "Could not reconnect. Reconnect to try again."
                  ),
                },
              }
            return { target: "waiting", context: { ...context, failures } }
          },
        },
      },
      waiting: {
        invoke: {
          src: "delay",
          input: ({ context }) => context.failures,
          onDone: ({ context }) => ({
            target: "reading",
            context: {
              ...context,
              attempt: context.attempt + 1,
              received: false,
            },
          }),
        },
      },
      failed: {
        invoke: {
          src: "finish",
          input: ({ context }: { context: { error: unknown } }) =>
            context.error,
          onDone: { target: "done" },
        },
      },
      closed: {
        invoke: {
          src: "finish",
          input: () => null,
          onDone: { target: "done" },
        },
      },
      done: { type: "final" },
    },
  })
}
