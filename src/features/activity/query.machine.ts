import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

export const ActivityQueryView = Schema.Struct({
  key: Schema.String,
  interval: Schema.NullOr(Schema.Number.check(Schema.isGreaterThan(0))),
  auto: Schema.Boolean,
  visible: Schema.Boolean,
})
export type ActivityQueryView = typeof ActivityQueryView.Type
export type ActivityQueryWork = {
  read: (input: unknown) => Effect.Effect<unknown, unknown, Scope.Scope>
  merge?: (previous: unknown, result: unknown) => unknown
  terminal?: (data: unknown) => boolean
  message?: (cause: Cause.Cause<unknown>) => string
}
const context = Schema.Struct({
  view: ActivityQueryView,
  data: Schema.Unknown,
  request: Schema.Unknown,
  queued: Schema.Boolean,
  error: Schema.String,
  failure: Schema.UndefinedOr(Schema.Unknown),
})
type QueryContext = typeof context.Type
export function activityQueryMachine(work: ActivityQueryWork) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: ActivityQueryView,
      context,
      events: {
        REFRESH: Schema.Struct({ key: Schema.String, input: Schema.Unknown }),
        CLEAR: Schema.Struct({ key: Schema.String }),
        WAKE: Schema.Struct({}),
        VISIBILITY: Schema.Struct({ visible: Schema.Boolean }),
      },
    },
    actors: {
      read: createEffectLogic(({ input }: { input: unknown }) =>
        Effect.exit(Effect.scoped(work.read(input)))
      ),
      wait: createEffectLogic(({ input }: { input: number }) =>
        Effect.sleep(input)
      ),
    },
  }).createMachine({
    id: "activity-query",
    initial: "starting",
    context: ({ input }) => ({
      view: input,
      data: null,
      request: null,
      queued: false,
      error: "",
      failure: undefined,
    }),
    on: {
      VISIBILITY: ({ context, event }) => ({
        context: {
          ...context,
          view: { ...context.view, visible: event.visible },
        },
      }),
      REFRESH: ({ context, event }) =>
        event.key === context.view.key
          ? {
              target: ".reading",
              context: {
                ...context,
                request: event.input,
                queued: false,
                error: "",
                failure: undefined,
              },
            }
          : undefined,
      CLEAR: ({ context, event }) =>
        event.key === context.view.key
          ? {
              target: ".idle",
              context: {
                ...context,
                data: null,
                error: "",
                failure: undefined,
                queued: false,
              },
            }
          : undefined,
    },
    states: {
      starting: {
        always: ({ context }) => ({
          target: !context.view.auto
            ? "idle"
            : context.view.visible
              ? "reading"
              : "hidden",
        }),
      },
      reading: {
        on: {
          // Refresh invalidations coalesce behind the current native read. A
          // pagination button cannot enqueue the same cursor twice.
          REFRESH: ({ context, event }) =>
            event.key === context.view.key && context.view.interval !== null
              ? { context: { ...context, queued: true } }
              : undefined,
          CLEAR: {},
          WAKE: {},
        },
        invoke: {
          src: "read",
          input: ({ context }: { context: QueryContext }) => context.request,
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output)) {
              const cause = event.output.cause
              return {
                target:
                  Cause.hasDies(cause) || Cause.hasInterrupts(cause)
                    ? "failed"
                    : "afterRead",
                context: {
                  ...context,
                  error:
                    work.message?.(cause) ?? "Activity could not reconnect.",
                  failure: cause,
                },
              }
            }
            return {
              target: "afterRead",
              context: {
                ...context,
                data: work.merge
                  ? work.merge(context.data, event.output.value)
                  : event.output.value,
                error: "",
                failure: undefined,
              },
            }
          },
        },
      },
      afterRead: {
        always: ({ context }) =>
          context.queued
            ? { target: "reading", context: { ...context, queued: false } }
            : {
                target:
                  context.view.interval === null ||
                  (!context.error && work.terminal?.(context.data))
                    ? "idle"
                    : context.view.visible
                      ? "waiting"
                      : "hidden",
              },
      },
      waiting: {
        always: ({ context }) =>
          !context.view.visible ? { target: "hidden" } : undefined,
        on: { WAKE: { target: "reading" } },
        invoke: {
          src: "wait",
          input: ({ context }) => context.view.interval!,
          onDone: { target: "reading" },
        },
      },
      hidden: {
        always: ({ context }) =>
          context.view.visible ? { target: "reading" } : undefined,
      },
      idle: {},
      failed: {},
    },
  })
}
