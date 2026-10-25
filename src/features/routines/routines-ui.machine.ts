import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import {
  RoutineChange,
  RoutineId,
  RoutineList,
  RunRoutineNow,
  SaveRoutine,
  SetRoutineStatus,
} from "@/routines/contracts"

export const RoutineCommand = Schema.Union([
  Schema.Struct({ path: Schema.Literal("save"), body: SaveRoutine }),
  Schema.Struct({ path: Schema.Literal("status"), body: SetRoutineStatus }),
  Schema.Struct({ path: Schema.Literal("run"), body: RunRoutineNow }),
])
export type RoutineCommand = typeof RoutineCommand.Type

/** Admitted data must outlive changes to the caller's draft objects. */
function snapshotCommand(input: RoutineCommand): RoutineCommand {
  switch (input.path) {
    case "save":
      return {
        path: input.path,
        body: { ...input.body, schedule: { ...input.body.schedule } },
      }
    case "status":
      return { path: input.path, body: { ...input.body } }
    case "run":
      return { path: input.path, body: { ...input.body } }
  }
}
const commandEvent = Schema.Struct({
  change: RoutineCommand,
  view: Schema.String,
})
const stateContext = Schema.Struct({
  data: Schema.NullOr(RoutineList),
  attempt: Schema.NullOr(RoutineCommand),
  stopId: Schema.NullOr(RoutineId),
  view: Schema.String,
  viewRevision: Schema.Int,
  admittedViewRevision: Schema.Int,
  visible: Schema.Boolean,
  failures: Schema.Int,
  error: Schema.String,
  failure: Schema.Unknown,
})
export function routineFailure(cause: Cause.Cause<unknown>, fallback: string) {
  const value = cause.reasons.find((reason) => reason._tag === "Fail")
  return value &&
    Schema.is(Schema.Struct({ message: Schema.String }))(value.error)
    ? value.error.message
    : fallback
}
export function mergeRoutineChange(
  data: RoutineList | null,
  result: RoutineChange
): RoutineList {
  const current = data ?? { routines: [], runs: [] }
  return {
    routines: current.routines.some((r) => r.id === result.routine.id)
      ? current.routines.map((r) =>
          r.id === result.routine.id && r.revision <= result.routine.revision
            ? result.routine
            : r
        )
      : [result.routine, ...current.routines],
    runs:
      result.run && !current.runs.some((r) => r.id === result.run!.id)
        ? [result.run, ...current.runs].slice(0, 200)
        : current.runs,
  }
}
export interface RoutinesWork {
  read: () => Effect.Effect<RoutineList, unknown>
  change: (input: RoutineCommand) => Effect.Effect<RoutineChange, unknown>
  resolve: (
    input: RoutineCommand
  ) => Effect.Effect<{ applied: boolean; data: RoutineList }, unknown>
  stop: (id: string) => Effect.Effect<RoutineList, unknown>
}
/** One command keeps its immutable operation until acknowledgement or exact
 * cancellation plus an authoritative read. Polling never retries commands. */
export function routinesUiMachine(work: RoutinesWork) {
  const available = {
    SEND: ({
      context,
      event,
    }: {
      context: typeof stateContext.Type
      event: typeof commandEvent.Type
    }) => {
      return !context.stopId && !context.attempt && event.view === context.view
        ? {
            target: "submitting",
            context: {
              ...context,
              attempt: snapshotCommand(event.change),
              admittedViewRevision: context.viewRevision,
              error: "",
              failure: null,
            },
          }
        : undefined
    },
    RETRY: ({ context }: { context: typeof stateContext.Type }) =>
      context.attempt
        ? {
            target: "submitting",
            context: { ...context, error: "", failure: null },
          }
        : undefined,
    RESOLVE: ({ context }: { context: typeof stateContext.Type }) =>
      context.attempt
        ? {
            target: "resolving",
            context: { ...context, error: "", failure: null },
          }
        : undefined,
    STOP: ({
      context,
      event,
    }: {
      context: typeof stateContext.Type
      event: { id: string }
    }) =>
      !context.attempt && !context.stopId
        ? {
            target: "stopping",
            context: { ...context, stopId: event.id, error: "", failure: null },
          }
        : undefined,
    RETRY_STOP: ({ context }: { context: typeof stateContext.Type }) =>
      context.stopId
        ? {
            target: "stopping",
            context: { ...context, error: "", failure: null },
          }
        : undefined,
    REFRESH: {
      target: "loading",
      context: ({ context }: { context: typeof stateContext.Type }) => ({
        ...context,
        failures: 0,
        error: "",
      }),
    },
  }
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: Schema.Struct({
        view: Schema.String,
        visible: Schema.optionalKey(Schema.Boolean),
      }),
      context: stateContext,
      events: {
        SEND: commandEvent,
        RESOLVE: Schema.Struct({}),
        RETRY: Schema.Struct({}),
        RETRY_STOP: Schema.Struct({}),
        STOP: Schema.Struct({ id: RoutineId }),
        REFRESH: Schema.Struct({}),
        VIEW: Schema.Struct({ view: Schema.String }),
        VISIBLE: Schema.Struct({ visible: Schema.Boolean }),
      },
      emitted: {
        applied: Schema.Struct({ view: Schema.String, revision: Schema.Int }),
      },
    },
    actors: {
      read: createEffectLogic(() => Effect.exit(work.read())),
      change: createEffectLogic(({ input }: { input: RoutineCommand }) =>
        Effect.exit(work.change(input))
      ),
      resolve: createEffectLogic(({ input }: { input: RoutineCommand }) =>
        Effect.exit(work.resolve(input))
      ),
      stop: createEffectLogic(({ input }: { input: string }) =>
        Effect.exit(work.stop(input))
      ),
    },
  }).createMachine({
    id: "routines-ui",
    initial: "initializing",
    context: ({ input }) => ({
      data: null,
      attempt: null,
      stopId: null,
      view: input.view,
      viewRevision: 0,
      admittedViewRevision: 0,
      visible: input.visible ?? true,
      failures: 0,
      error: "",
      failure: null,
    }),
    on: {
      VIEW: ({ context, event }) => ({
        context: {
          ...context,
          view: event.view,
          viewRevision:
            context.viewRevision + (context.view === event.view ? 0 : 1),
        },
      }),
      VISIBLE: ({ context, event }) => ({
        context: { ...context, visible: event.visible },
      }),
    },
    states: {
      initializing: {
        always: ({ context }) => ({
          target: context.visible ? "loading" : "waiting",
        }),
      },
      loading: {
        on: { ...available, REFRESH: {} },
        invoke: {
          src: "read",
          onDone: ({ context, event }) =>
            Exit.isSuccess(event.output)
              ? {
                  target: "waiting",
                  context: {
                    ...context,
                    data: event.output.value,
                    failures: 0,
                    error:
                      context.attempt || context.stopId ? context.error : "",
                    failure: null,
                  },
                }
              : {
                  target: "waiting",
                  context: {
                    ...context,
                    failures: context.failures + 1,
                    error: routineFailure(
                      event.output.cause,
                      "Could not load routines. Retry routines."
                    ),
                    failure: event.output.cause,
                  },
                },
        },
      },
      waiting: {
        on: available,
        after: {
          4000: ({ context }) => ({
            target: context.visible ? "loading" : "waiting",
            reenter: true,
          }),
        },
      },
      uncertain: {
        on: available,
        after: {
          4000: ({ context }) => ({
            target: context.visible ? "loading" : "uncertain",
            reenter: true,
          }),
        },
      },
      submitting: {
        invoke: {
          src: "change",
          input: ({ context }) => context.attempt!,
          onDone: ({ context, event }, enq) => {
            if (Exit.isFailure(event.output))
              return {
                target: "uncertain",
                context: {
                  ...context,
                  error: routineFailure(
                    event.output.cause,
                    "The change was not confirmed. Retry or resolve the same request."
                  ),
                  failure: event.output.cause,
                },
              }
            if (context.viewRevision === context.admittedViewRevision)
              enq.emit({
                type: "applied",
                view: context.view,
                revision: context.viewRevision,
              })
            return {
              target: "loading",
              context: {
                ...context,
                data: mergeRoutineChange(context.data, event.output.value),
                attempt: null,
                failures: 0,
                error: "",
                failure: null,
              },
            }
          },
        },
      },
      resolving: {
        invoke: {
          src: "resolve",
          input: ({ context }) => context.attempt!,
          onDone: ({ context, event }, enq) => {
            if (Exit.isFailure(event.output))
              return {
                target: "uncertain",
                context: {
                  ...context,
                  error: routineFailure(
                    event.output.cause,
                    "Could not resolve the change and load current routines. Retry resolving."
                  ),
                  failure: event.output.cause,
                },
              }
            if (
              event.output.value.applied &&
              context.viewRevision === context.admittedViewRevision
            )
              enq.emit({
                type: "applied",
                view: context.view,
                revision: context.viewRevision,
              })
            return {
              target: "waiting",
              context: {
                ...context,
                data: event.output.value.data,
                attempt: null,
                failures: 0,
                error: event.output.value.applied
                  ? "The previous change was already saved."
                  : "The unconfirmed change was cancelled. You can edit or try again.",
                failure: null,
              },
            }
          },
        },
      },
      stopping: {
        invoke: {
          src: "stop",
          input: ({ context }) => context.stopId!,
          onDone: ({ context, event }) =>
            Exit.isSuccess(event.output)
              ? {
                  target: "waiting",
                  context: {
                    ...context,
                    data: event.output.value,
                    stopId: null,
                    failures: 0,
                    error: "",
                    failure: null,
                  },
                }
              : {
                  target: "uncertain",
                  context: {
                    ...context,
                    error: routineFailure(
                      event.output.cause,
                      "Stop was not confirmed. Retry stopping the same run."
                    ),
                    failure: event.output.cause,
                  },
                },
        },
      },
    },
  })
}
