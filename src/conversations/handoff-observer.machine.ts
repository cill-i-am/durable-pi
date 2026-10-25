import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Deferred, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

/** Owns diagnostic admission, control, observation, transfer and expiry.
 * Native byte buffering and the response body remain pipe-owned. */
export function handoffObserverMachine(work: {
  admit: Effect.Effect<boolean>
  admitted: (accepted: boolean) => Effect.Effect<void>
  control: Effect.Effect<void>
  heartbeat: Effect.Effect<void>
  confirm: Effect.Effect<void>
  ended: Effect.Effect<void>
}) {
  const outcome = Schema.declare((value): value is Exit.Exit<void, unknown> =>
    Exit.isExit(value)
  )
  const ack = Schema.declare((value): value is Deferred.Deferred<void> =>
    Deferred.isDeferred(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({ transferred: Schema.Boolean, outcome }),
      events: { CANCEL: Schema.Struct({}), TRANSFER: Schema.Struct({ ack }) },
      output: outcome,
    },
    actors: {
      admit: createEffectLogic(Effect.exit(work.admit)),
      control: createEffectLogic(Effect.exit(work.control)),
      heartbeat: createEffectLogic(Effect.exit(work.heartbeat)),
      confirm: createEffectLogic(Effect.exit(work.confirm)),
      ended: createEffectLogic(work.ended),
    },
    actions: {
      admitted: ({ params }: { params?: unknown }) =>
        work.admitted(Schema.decodeUnknownSync(Schema.Boolean)(params)),
      transfer: ({ params }: { params?: unknown }) =>
        Deferred.succeed(Schema.decodeUnknownSync(ack)(params), undefined),
    },
  }).createMachine({
    id: "handoff-observer",
    initial: "open",
    context: {
      transferred: false,
      outcome: Exit.void as Exit.Exit<void, unknown>,
    },
    output: ({ context }) => context.outcome,
    on: {
      CANCEL: { target: ".settled" },
      TRANSFER: (args, enq) => {
        enq(args.actions.transfer, { ...args, params: args.event.ack })
        return { context: { ...args.context, transferred: true } }
      },
    },
    states: {
      open: {
        type: "parallel",
        after: { 60_000: { target: "settled" } },
        states: {
          disconnect: {
            invoke: {
              src: "ended",
              onDone: { target: "#handoff-observer.settled" },
            },
          },
          observation: {
            initial: "admitting",
            states: {
              admitting: {
                invoke: {
                  src: "admit",
                  onDone: (args, enq) => {
                    const accepted =
                      Exit.isSuccess(args.event.output) &&
                      args.event.output.value
                    enq(args.actions.admitted, { ...args, params: accepted })
                    return Exit.isFailure(args.event.output)
                      ? {
                          target: "#handoff-observer.settled",
                          context: {
                            ...args.context,
                            outcome: Exit.failCause(args.event.output.cause),
                          },
                        }
                      : {
                          target: accepted
                            ? "control"
                            : "#handoff-observer.settled",
                        }
                  },
                },
              },
              control: {
                invoke: {
                  src: "control",
                  onDone: ({ context, event }) =>
                    Exit.isFailure(event.output)
                      ? {
                          target: "#handoff-observer.settled",
                          context: { ...context, outcome: event.output },
                        }
                      : { target: "observing" },
                },
              },
              observing: {
                type: "parallel",
                states: {
                  heartbeat: {
                    initial: "waiting",
                    states: {
                      waiting: { after: { 1000: { target: "sending" } } },
                      sending: {
                        invoke: {
                          src: "heartbeat",
                          onDone: ({ context, event }) =>
                            Exit.isFailure(event.output)
                              ? {
                                  target: "#handoff-observer.settled",
                                  context: {
                                    ...context,
                                    outcome: event.output,
                                  },
                                }
                              : { target: "waiting" },
                        },
                      },
                    },
                  },
                  confirmation: {
                    initial: "waiting",
                    states: {
                      waiting: {
                        invoke: {
                          src: "confirm",
                          onDone: ({ context, event }) =>
                            Exit.isFailure(event.output)
                              ? {
                                  target: "#handoff-observer.settled",
                                  context: {
                                    ...context,
                                    outcome: event.output,
                                  },
                                }
                              : { target: "waiting", reenter: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      settled: { type: "final" },
    },
  })
}
