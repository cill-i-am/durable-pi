import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Deferred, Effect, Exit, Schema } from "effect"
import { matchesState } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

export type NativeOwnerReply = Deferred.Deferred<Exit.Exit<void, unknown>>
export type NativeRetireReply = Deferred.Deferred<Exit.Exit<boolean, unknown>>
export interface NativeStart {
  unrestricted: boolean
  signal: AbortSignal | undefined
  reply: NativeOwnerReply
}
const reply = Schema.declare((value): value is NativeOwnerReply =>
  Deferred.isDeferred(value)
)
const retireReply = Schema.declare((value): value is NativeRetireReply =>
  Deferred.isDeferred(value)
)
const start = Schema.Struct({
  unrestricted: Schema.Boolean,
  signal: Schema.UndefinedOr(Schema.instanceOf(AbortSignal)),
  reply,
})
const retirement = Schema.Struct({ epoch: Schema.Number, reply: retireReply })
const outcome = Schema.declare((value): value is Exit.Exit<void, unknown> =>
  Exit.isExit(value)
)
const retired = Schema.declare((value): value is Exit.Exit<boolean, unknown> =>
  Exit.isExit(value)
)

/** The native token/fence remain durable authority. This local owner joins
 * acquisition and retirement before releasing or starting that capability. */
export function nativeOwnerMachine<E>(work: {
  acquire: (request: NativeStart) => Effect.Effect<void, E>
  start: (request: NativeStart) => Effect.Effect<void, E>
  close: Effect.Effect<void, E>
  retire: (epoch: number) => Effect.Effect<boolean, E>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        request: Schema.NullOr(start),
        closing: Schema.Array(reply),
        retirement: Schema.NullOr(retirement),
      }),
      events: {
        START: start,
        CLOSE: Schema.Struct({ reply }),
        RETIRE: retirement,
      },
    },
    actors: {
      acquire: createEffectLogic(({ input }: { input: NativeStart }) =>
        Effect.exit(work.acquire(input))
      ),
      start: createEffectLogic(({ input }: { input: NativeStart }) =>
        Effect.exit(work.start(input))
      ),
      close: createEffectLogic(Effect.exit(work.close)),
      retire: createEffectLogic(({ input }: { input: number }) =>
        Effect.exit(work.retire(input))
      ),
    },
    actions: {
      respond: ({ params }: { params?: unknown }) => {
        const value = Schema.decodeUnknownSync(
          Schema.Struct({ reply, outcome })
        )(params)
        return Deferred.succeed(value.reply, value.outcome)
      },
      retired: ({ params }: { params?: unknown }) => {
        const value = Schema.decodeUnknownSync(
          Schema.Struct({ reply: retireReply, outcome: retired })
        )(params)
        return Deferred.succeed(value.reply, value.outcome)
      },
    },
  }).createMachine({
    id: "native-container-owner",
    type: "parallel",
    context: { request: null, closing: [], retirement: null },
    on: {
      START: (args, enq) => {
        if (
          !matchesState({ resource: "idle" }, args.value) ||
          args.context.closing.length
        ) {
          enq(args.actions.respond, {
            ...args,
            params: {
              reply: args.event.reply,
              outcome: Exit.fail(
                new Error("Terminal capacity owner is busy or awaiting cleanup")
              ),
            },
          })
          return
        }
        return {
          target: ".resource.acquiring",
          context: { ...args.context, request: args.event },
        }
      },
      CLOSE: ({ context, event, value }) => ({
        ...(matchesState({ resource: "idle" }, value) ||
        matchesState({ resource: "blocked" }, value)
          ? { target: ".resource.closing" }
          : {}),
        context: { ...context, closing: [...context.closing, event.reply] },
      }),
      RETIRE: (args, enq) => {
        if (
          args.context.retirement ||
          args.context.closing.length ||
          matchesState({ resource: "starting" }, args.value) ||
          matchesState({ resource: "blocked" }, args.value)
        ) {
          enq(args.actions.retired, {
            ...args,
            params: { reply: args.event.reply, outcome: Exit.succeed(false) },
          })
          return
        }
        return {
          target: ".retirement.retiring",
          context: { ...args.context, retirement: args.event },
        }
      },
    },
    states: {
      resource: {
        initial: "idle",
        states: {
          idle: {},
          blocked: {},
          acquiring: {
            invoke: {
              src: "acquire",
              input: ({ context }) => context.request!,
              onDone: (args, enq) => {
                if (Exit.isSuccess(args.event.output))
                  return { target: "ready" }
                enq(args.actions.respond, {
                  ...args,
                  params: {
                    reply: args.context.request!.reply,
                    outcome: args.event.output,
                  },
                })
                return {
                  target: args.context.closing.length ? "closing" : "idle",
                  context: { ...args.context, request: null },
                }
              },
            },
          },
          ready: {
            always: (args, enq) => {
              if (args.context.closing.length) {
                enq(args.actions.respond, {
                  ...args,
                  params: {
                    reply: args.context.request!.reply,
                    outcome: Exit.fail(
                      new Error(
                        "Terminal capacity lease was retired before start"
                      )
                    ),
                  },
                })
                return {
                  target: "closing",
                  context: { ...args.context, request: null },
                }
              }
              if (!args.context.retirement) return { target: "starting" }
            },
          },
          starting: {
            invoke: {
              src: "start",
              input: ({ context }) => context.request!,
              onDone: (args, enq) => {
                enq(args.actions.respond, {
                  ...args,
                  params: {
                    reply: args.context.request!.reply,
                    outcome: args.event.output,
                  },
                })
                return {
                  target: args.context.closing.length ? "closing" : "idle",
                  context: { ...args.context, request: null },
                }
              },
            },
          },
          closing: {
            initial: "joining",
            states: {
              joining: {
                always: ({ context }) =>
                  context.retirement ? undefined : { target: "destroying" },
              },
              destroying: {
                invoke: {
                  src: "close",
                  onDone: (args, enq) => {
                    for (const reply of args.context.closing)
                      enq(args.actions.respond, {
                        ...args,
                        params: { reply, outcome: args.event.output },
                      })
                    return {
                      target: Exit.isSuccess(args.event.output)
                        ? "#native-container-owner.resource.idle"
                        : "#native-container-owner.resource.blocked",
                      context: { ...args.context, closing: [] },
                    }
                  },
                },
              },
            },
          },
        },
      },
      retirement: {
        initial: "idle",
        states: {
          idle: {},
          retiring: {
            invoke: {
              src: "retire",
              input: ({ context }) => context.retirement!.epoch,
              onDone: (args, enq) => {
                enq(args.actions.retired, {
                  ...args,
                  params: {
                    reply: args.context.retirement!.reply,
                    outcome: args.event.output,
                  },
                })
                return {
                  target: "idle",
                  context: { ...args.context, retirement: null },
                }
              },
            },
          },
        },
      },
    },
  })
}
