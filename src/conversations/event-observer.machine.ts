import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Clock, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { ChatState } from "./contracts"

export function conversationObserverMachine<E, R>(work: {
  changed: Effect.Effect<void, never, R>
  active: Effect.Effect<string | undefined, E, R>
  release: Effect.Effect<void, E, R>
  watch: (id: string) => Effect.Effect<void, E, R>
  snapshot: Effect.Effect<ChatState, E, R>
  publish: (
    current: ChatState,
    previous: ChatState | undefined
  ) => Effect.Effect<{ accepted: boolean; at: number }, E, R>
  heartbeat: Effect.Effect<boolean, E, R>
}) {
  const Outcome = Schema.declare((value): value is Exit.Exit<void, E> =>
    Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        session: Schema.UndefinedOr(Schema.String),
        selected: Schema.UndefinedOr(Schema.String),
        previous: Schema.UndefinedOr(Schema.toType(ChatState)),
        current: Schema.UndefinedOr(Schema.toType(ChatState)),
        dirty: Schema.Boolean,
        leading: Schema.Boolean,
        publishedAt: Schema.Number,
        outcome: Outcome,
      }),
      events: { CANCEL: Schema.Struct({}) },
      output: Outcome,
    },
    actors: {
      changed: createEffectLogic(work.changed),
      active: createEffectLogic(Effect.exit(work.active)),
      release: createEffectLogic(Effect.exit(work.release)),
      watch: createEffectLogic(({ input }: { input: string }) =>
        Effect.exit(work.watch(input))
      ),
      snapshot: createEffectLogic(Effect.exit(work.snapshot)),
      publish: createEffectLogic(
        ({
          input,
        }: {
          input: { current: ChatState; previous: ChatState | undefined }
        }) => Effect.exit(work.publish(input.current, input.previous))
      ),
      heartbeat: createEffectLogic(Effect.exit(work.heartbeat)),
      coalesce: createEffectLogic(({ input }: { input: number }) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => Effect.sleep(Math.max(0, input + 80 - now)))
        )
      ),
    },
  }).createMachine({
    id: "conversation-observer",
    initial: "active",
    context: () => ({
      session: undefined,
      selected: undefined,
      previous: undefined,
      current: undefined,
      dirty: false,
      leading: true,
      publishedAt: 0,
      outcome: Exit.void as Exit.Exit<void, E>,
    }),
    output: ({ context }) => context.outcome,
    on: { CANCEL: { target: ".settled" } },
    states: {
      active: {
        type: "parallel",
        after: { 60_000: { target: "settled" } },
        states: {
          changes: {
            initial: "listening",
            states: {
              listening: {
                invoke: {
                  src: "changed",
                  onDone: ({ context }) => ({
                    target: "notified",
                    context: { ...context, dirty: true },
                  }),
                },
              },
              notified: { always: { target: "listening" } },
            },
          },
          heartbeat: {
            initial: "waiting",
            states: {
              waiting: { after: { 15_000: { target: "sending" } } },
              sending: {
                invoke: {
                  src: "heartbeat",
                  onDone: ({ context, event }) =>
                    Exit.isFailure(event.output)
                      ? {
                          target: "#conversation-observer.settled",
                          context: {
                            ...context,
                            outcome: Exit.failCause(event.output.cause),
                          },
                        }
                      : event.output.value
                        ? {
                            target: "waiting",
                            context: { ...context, dirty: true },
                          }
                        : { target: "#conversation-observer.settled" },
                },
              },
            },
          },
          refresh: {
            initial: "checking",
            states: {
              checking: {
                invoke: {
                  src: "active",
                  onDone: ({ context, event }) =>
                    Exit.isFailure(event.output)
                      ? {
                          target: "#conversation-observer.settled",
                          context: {
                            ...context,
                            outcome: Exit.failCause(event.output.cause),
                          },
                        }
                      : {
                          target:
                            event.output.value === context.session
                              ? "snapshotting"
                              : "releasing",
                          context: { ...context, selected: event.output.value },
                        },
                },
              },
              releasing: {
                invoke: {
                  src: "release",
                  onDone: ({ context, event }) =>
                    Exit.isFailure(event.output)
                      ? {
                          target: "#conversation-observer.settled",
                          context: {
                            ...context,
                            outcome: Exit.failCause(event.output.cause),
                          },
                        }
                      : {
                          target: context.selected
                            ? "watching"
                            : "snapshotting",
                          context: { ...context, session: undefined },
                        },
                },
              },
              watching: {
                invoke: {
                  src: "watch",
                  input: ({ context }) => context.selected!,
                  onDone: ({ context, event }) =>
                    Exit.isFailure(event.output)
                      ? {
                          target: "#conversation-observer.settled",
                          context: {
                            ...context,
                            outcome: Exit.failCause(event.output.cause),
                          },
                        }
                      : {
                          target: "snapshotting",
                          context: { ...context, session: context.selected },
                        },
                },
              },
              snapshotting: {
                invoke: {
                  src: "snapshot",
                  onDone: ({ context, event }) =>
                    Exit.isFailure(event.output)
                      ? {
                          target: "#conversation-observer.settled",
                          context: {
                            ...context,
                            outcome: Exit.failCause(event.output.cause),
                          },
                        }
                      : {
                          target: "publishing",
                          context: { ...context, current: event.output.value },
                        },
                },
              },
              publishing: {
                invoke: {
                  src: "publish",
                  input: ({ context }) => ({
                    current: context.current!,
                    previous: context.previous,
                  }),
                  onDone: ({ context, event }) =>
                    Exit.isFailure(event.output)
                      ? {
                          target: "#conversation-observer.settled",
                          context: {
                            ...context,
                            outcome: Exit.failCause(event.output.cause),
                          },
                        }
                      : !event.output.value.accepted
                        ? { target: "#conversation-observer.settled" }
                        : {
                            target: context.leading ? "waiting" : "coalescing",
                            context: {
                              ...context,
                              previous: context.current,
                              publishedAt: event.output.value.at,
                              leading: false,
                            },
                          },
                },
              },
              waiting: {
                always: ({ context }) =>
                  context.dirty
                    ? {
                        target: "checking",
                        context: { ...context, dirty: false },
                      }
                    : undefined,
              },
              coalescing: {
                invoke: {
                  src: "coalesce",
                  input: ({ context }) => context.publishedAt,
                  onDone: { target: "waiting" },
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
