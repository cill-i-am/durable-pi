import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema } from "effect"
import { describeExecutableEffect, initialTransition, transition } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

export type ModelStreamOutcome = {
  reason: "ended" | "cancelled" | "overflow" | "expired"
}
const outcome = Schema.declare((value): value is Exit.Exit<void> =>
  Exit.isExit(value)
)

/** Host shutdown is an interrupted execution, distinct from an SDK caller
 * requesting an ordinary aborted message. The machine retains that fact while
 * native cleanup joins and combines it with any cleanup failure. */
const interrupted = (context: {
  reason: ModelStreamOutcome["reason"]
  outcome: Exit.Exit<void>
}) => ({
  ...context,
  reason: context.reason === "ended" ? ("cancelled" as const) : context.reason,
  outcome: Exit.isFailure(context.outcome)
    ? Cause.hasInterrupts(context.outcome.cause)
      ? context.outcome
      : Exit.failCause(Cause.combine(context.outcome.cause, Cause.interrupt()))
    : Exit.interrupt(),
})

/** One invocation owns acquisition, each read, bounded publication, and joined
 * native release. Stopping revokes further reads without releasing occupancy. */
export function modelStreamRequestMachine(work: {
  stopped: () => boolean
  acquire: Effect.Effect<void>
  read: Effect.Effect<"ended" | "terminal" | "event">
  publish: Effect.Effect<boolean>
  close: Effect.Effect<void>
  abort: Effect.Effect<void>
  lifetime: number
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      output: Schema.declare(
        (
          value
        ): value is ModelStreamOutcome & {
          exit: Exit.Exit<void>
        } =>
          typeof value === "object" &&
          value !== null &&
          "exit" in value &&
          Exit.isExit(value.exit)
      ),
      events: {
        STOP: Schema.Struct({}),
        INTERRUPT: Schema.Struct({}),
        OVERFLOW: Schema.Struct({}),
        EXPIRE: Schema.Struct({}),
      },
      context: Schema.Struct({
        reason: Schema.Literals(["ended", "cancelled", "overflow", "expired"]),
        outcome,
      }),
    },
    actors: {
      acquire: createEffectLogic(Effect.exit(work.acquire)),
      read: createEffectLogic(Effect.exit(work.read)),
      publish: createEffectLogic(Effect.exit(work.publish)),
      close: createEffectLogic(Effect.exit(work.close)),
    },
    actions: { abort: (_args: unknown) => work.abort },
  }).createMachine({
    id: "model-stream-request",
    initial: "active",
    context: () => ({
      reason: "ended" as ModelStreamOutcome["reason"],
      outcome: Exit.void as Exit.Exit<void>,
    }),
    output: ({ context }) => ({
      reason: context.reason,
      exit: context.outcome,
    }),
    after: {
      [work.lifetime]: (args, enq) => {
        enq(args.actions.abort, args)
        return {
          target: ".closing",
          context: {
            ...args.context,
            reason:
              args.context.reason === "overflow"
                ? ("overflow" as const)
                : ("expired" as const),
          },
        }
      },
    },
    states: {
      active: {
        initial: "checking",
        on: {
          INTERRUPT: (args, enq) => {
            enq(args.actions.abort, args)
            return { target: "closing", context: interrupted(args.context) }
          },
          STOP: (args, enq) => {
            enq(args.actions.abort, args)
            return {
              target: "closing",
              context: { ...args.context, reason: "cancelled" as const },
            }
          },
          OVERFLOW: (args, enq) => {
            enq(args.actions.abort, args)
            return {
              target: "closing",
              context: { ...args.context, reason: "overflow" as const },
            }
          },
          EXPIRE: (args, enq) => {
            enq(args.actions.abort, args)
            return {
              target: "closing",
              context: {
                ...args.context,
                reason:
                  args.context.reason === "overflow"
                    ? ("overflow" as const)
                    : ("expired" as const),
              },
            }
          },
        },
        states: {
          checking: {
            always: ({ context }) =>
              work.stopped()
                ? {
                    target: "#model-stream-request.closing",
                    context: { ...context, reason: "cancelled" as const },
                  }
                : { target: "acquiring" },
          },
          acquiring: {
            invoke: {
              src: "acquire",
              onDone: ({ context, event }) =>
                Exit.isFailure(event.output)
                  ? {
                      target: "#model-stream-request.closing",
                      context: { ...context, outcome: event.output },
                    }
                  : work.stopped()
                    ? {
                        target: "#model-stream-request.closing",
                        context: { ...context, reason: "cancelled" as const },
                      }
                    : { target: "reading" },
            },
          },
          reading: {
            invoke: {
              src: "read",
              onDone: ({ context, event }) => {
                if (Exit.isFailure(event.output))
                  return {
                    target: "#model-stream-request.closing",
                    context: { ...context, outcome: event.output },
                  }
                if (work.stopped())
                  return {
                    target: "#model-stream-request.closing",
                    context: { ...context, reason: "cancelled" as const },
                  }
                return {
                  target:
                    event.output.value === "event"
                      ? "publishing"
                      : "#model-stream-request.closing",
                }
              },
            },
          },
          publishing: {
            invoke: {
              src: "publish",
              onDone: ({ context, event }) =>
                Exit.isFailure(event.output)
                  ? {
                      target: "#model-stream-request.closing",
                      context: { ...context, outcome: event.output },
                    }
                  : event.output.value
                    ? { target: "reading" }
                    : {
                        target: "#model-stream-request.closing",
                        context: { ...context, reason: "overflow" as const },
                      },
            },
          },
        },
      },
      closing: {
        on: {
          INTERRUPT: ({ context }) => ({ context: interrupted(context) }),
          STOP: {},
          OVERFLOW: ({ context }) => ({
            context: { ...context, reason: "overflow" as const },
          }),
          EXPIRE: ({ context }) => ({
            context: {
              ...context,
              reason:
                context.reason === "overflow"
                  ? ("overflow" as const)
                  : ("expired" as const),
            },
          }),
        },
        invoke: {
          src: "close",
          onDone: ({ context, event }) => ({
            target: "closed",
            context: {
              ...context,
              outcome: Exit.isFailure(event.output)
                ? Exit.isFailure(context.outcome)
                  ? Exit.failCause(
                      Cause.combine(context.outcome.cause, event.output.cause)
                    )
                  : event.output
                : context.outcome,
            },
          }),
        },
      },
      closed: { type: "final" },
    },
  })
}

export type ModelStreamTask = {
  id: string
  run: (refusal?: string) => Effect.Effect<void>
}
const taskValue = Schema.declare(
  (value): value is ModelStreamTask =>
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "run" in value &&
    typeof value.run === "function"
)
const launchValue = Schema.Struct({
  task: taskValue,
  refusal: Schema.UndefinedOr(Schema.String),
})
const failureValue = Schema.declare((value): value is Cause.Cause<never> =>
  Cause.isCause(value)
)
const unavailable = "Model requests are currently unavailable."
const capacity =
  "Too many model requests are active. Wait for some work to finish."

/** The mailbox serializes admission with shutdown. Refusals own completion work
 * too, so they stay in the drain set without consuming a provider slot. */
export function modelStreamsMachine(work: {
  maximum: number
  launch: (task: ModelStreamTask, refusal?: string) => Effect.Effect<void>
  abort: Effect.Effect<void>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        active: Schema.Array(
          Schema.Struct({ id: Schema.String, native: Schema.Boolean })
        ),
        fatal: Schema.UndefinedOr(failureValue),
      }),
      events: {
        START: Schema.Struct({ task: taskValue }),
        RELEASE: Schema.Struct({ id: Schema.String, exit: outcome }),
        CLOSE: Schema.Struct({}),
      },
    },
    actions: {
      launch: ({ params }: { params?: unknown }) => {
        const { task, refusal } = Schema.decodeUnknownSync(launchValue)(params)
        return work.launch(task, refusal)
      },
      abort: (_args: unknown) => work.abort,
    },
  }).createMachine({
    id: "model-streams-owner",
    initial: "accepting",
    context: () => ({
      active: [] as readonly { id: string; native: boolean }[],
      fatal: undefined as Cause.Cause<never> | undefined,
    }),
    on: {
      START: (args, enq) => {
        if (
          args.context.active.some((entry) => entry.id === args.event.task.id)
        )
          return
        enq(args.actions.launch, {
          ...args,
          params: { task: args.event.task, refusal: unavailable },
        })
        return {
          context: {
            ...args.context,
            active: [
              ...args.context.active,
              { id: args.event.task.id, native: false },
            ],
          },
        }
      },
      RELEASE: ({ context, event }) => {
        if (!context.active.some((entry) => entry.id === event.id)) return {}
        const fatal =
          Exit.isFailure(event.exit) && Cause.hasDies(event.exit.cause)
            ? context.fatal
              ? Cause.combine(context.fatal, event.exit.cause)
              : event.exit.cause
            : context.fatal
        return {
          context: {
            active: context.active.filter((entry) => entry.id !== event.id),
            fatal,
          },
        }
      },
      CLOSE: (args, enq) => {
        enq(args.actions.abort, args)
        return { target: ".draining" }
      },
    },
    states: {
      accepting: {
        always: ({ context }) =>
          context.fatal ? { target: "unavailable" } : undefined,
        on: {
          START: (args, enq) => {
            if (
              args.context.active.some(
                (entry) => entry.id === args.event.task.id
              )
            )
              return
            const native =
              args.context.active.filter((entry) => entry.native).length <
              work.maximum
            enq(args.actions.launch, {
              ...args,
              params: {
                task: args.event.task,
                refusal: native ? undefined : capacity,
              },
            })
            return {
              context: {
                ...args.context,
                active: [
                  ...args.context.active,
                  { id: args.event.task.id, native },
                ],
              },
            }
          },
        },
      },
      unavailable: {},
      draining: {
        on: {
          CLOSE: (args, enq) => {
            enq(args.actions.abort, args)
          },
        },
      },
    },
  })
}

/** The SDK facade needs a synchronous reservation before enqueuing its request.
 * This machine keeps reusing a request object from dispatching it again. */
const requestReservationMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: { events: { CLAIM: Schema.Struct({}) } },
}).createMachine({
  initial: "new",
  states: { new: { on: { CLAIM: { target: "owned" } } }, owned: {} },
})
export const newModelRequestReservation = () =>
  initialTransition(requestReservationMachine)[0]
export const claimModelRequest = (
  state: ReturnType<typeof newModelRequestReservation>
) => transition(requestReservationMachine, state, { type: "CLAIM" })[0]

/** Iterator ownership and result-only draining share one native queue. An
 * observer cannot silently steal events from an already admitted consumer. */
const streamConsumerMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    events: {
      ITERATE: Schema.Struct({}),
      RESULT: Schema.Struct({}),
      RELEASE: Schema.Struct({}),
    },
    emitted: { DRAIN: Schema.Struct({}), ITERATE: Schema.Struct({}) },
  },
}).createMachine({
  initial: "unclaimed",
  states: {
    unclaimed: {
      on: {
        ITERATE: (_args, enq) => {
          enq.emit({ type: "ITERATE" })
          return { target: "iterating" }
        },
        RESULT: (_args, enq) => {
          enq.emit({ type: "DRAIN" })
          return { target: "draining" }
        },
      },
    },
    iterating: { on: { RESULT: {}, RELEASE: { target: "released" } } },
    draining: { on: { RESULT: {}, RELEASE: { target: "released" } } },
    released: { on: { RESULT: {} } },
  },
})
export const newModelStreamConsumer = () =>
  initialTransition(streamConsumerMachine)[0]
export function consumeModelStream(
  state: ReturnType<typeof newModelStreamConsumer>,
  type: "ITERATE" | "RESULT" | "RELEASE"
) {
  const [next, effects] = transition(streamConsumerMachine, state, { type })
  return {
    state: next,
    commands: effects.flatMap((effect) => {
      const descriptor = describeExecutableEffect(effect)
      return descriptor.kind === "emit"
        ? [
            Schema.decodeUnknownSync(Schema.Struct({ type: Schema.String }))(
              descriptor.event
            ).type,
          ]
        : []
    }),
  }
}
