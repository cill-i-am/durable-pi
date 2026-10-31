import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { CodeRun, RunHistory, RunInput, RunId } from "@/execution/contracts"

const View = Schema.Struct({
  agentId: Schema.String,
  selected: Schema.NullOr(Schema.String),
  visible: Schema.Boolean,
})
export type ExecutionView = typeof View.Type
const Command = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("run"), input: RunInput }),
  Schema.Struct({ kind: Schema.Literal("cancel"), id: RunId }),
])
export type ExecutionCommand = typeof Command.Type
const Selection = Schema.Struct({
  id: Schema.String,
  expected: Schema.NullOr(Schema.String),
})
const Loaded = Schema.Struct({
  ...RunHistory.fields,
  detail: Schema.NullOr(CodeRun),
})
export type ExecutionLoaded = typeof Loaded.Type
const context = Schema.Struct({
  view: View,
  revision: Schema.Int,
  requestRevision: Schema.Int,
  requestSelection: Schema.NullOr(Schema.String),
  request: Schema.NullOr(Command),
  attempt: Schema.NullOr(RunInput),
  loaded: Schema.Boolean,
  runs: RunHistory.fields.runs,
  detail: Schema.NullOr(CodeRun),
  error: Schema.String,
  failure: Schema.UndefinedOr(Schema.Unknown),
})
type Context = typeof context.Type
export type ExecutionWork = {
  read: (
    view: ExecutionView
  ) => Effect.Effect<ExecutionLoaded, unknown, Scope.Scope>
  command: (
    request: ExecutionCommand
  ) => Effect.Effect<CodeRun, unknown, Scope.Scope>
  select: (selection: typeof Selection.Type) => Effect.Effect<void>
}
const message = (cause: Cause.Cause<unknown>, fallback: string) => {
  const reason = cause.reasons.find((value) => value._tag === "Fail")
  return reason?._tag === "Fail" &&
    typeof reason.error === "object" &&
    reason.error !== null &&
    "message" in reason.error &&
    typeof reason.error.message === "string"
    ? reason.error.message
    : fallback
}
const admitted = (state: Context, request: ExecutionCommand) => ({
  target: "requesting",
  context: {
    ...state,
    request,
    requestRevision: state.revision,
    requestSelection: state.view.selected,
    attempt: request.kind === "run" ? request.input : state.attempt,
    error: "",
    failure: undefined,
  },
})

/** Separate observation and immutable command regions. Polls never renew a command. */
export function executionMachine(work: ExecutionWork) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: View,
      context,
      events: {
        VIEW: Schema.Struct({ selected: Schema.NullOr(Schema.String) }),
        VISIBILITY: Schema.Struct({ visible: Schema.Boolean }),
        REFRESH: Schema.Struct({}),
        START: Schema.Struct({
          id: RunId,
          code: Schema.String,
          data: Schema.String,
        }),
        CANCEL: Schema.Struct({ id: RunId }),
      },
    },
    actors: {
      read: createEffectLogic(({ input }: { input: ExecutionView }) =>
        Effect.exit(work.read(input))
      ),
      command: createEffectLogic(({ input }: { input: ExecutionCommand }) =>
        Effect.exit(work.command(input))
      ),
    },
    actions: {
      select: ({ params }: { params?: unknown }) =>
        work.select(Schema.decodeUnknownSync(Selection)(params)),
    },
  }).createMachine({
    id: "execution-ui",
    type: "parallel",
    context: ({ input }) => ({
      view: input,
      revision: 0,
      requestRevision: 0,
      requestSelection: null,
      request: null,
      attempt: null,
      loaded: false,
      runs: [],
      detail: null,
      error: "",
      failure: undefined,
    }),
    states: {
      resource: {
        initial: "choosing",
        on: {
          VIEW: ({ context, event }) =>
            event.selected === context.view.selected
              ? undefined
              : {
                  target: context.request
                    ? ".paused"
                    : context.view.visible
                      ? ".loading"
                      : ".hidden",
                  reenter: true,
                  context: {
                    ...context,
                    view: { ...context.view, selected: event.selected },
                    revision: context.revision + 1,
                    detail: null,
                    error: "",
                  },
                },
          VISIBILITY: ({ context, event }) =>
            event.visible === context.view.visible
              ? undefined
              : {
                  target: context.request
                    ? ".paused"
                    : event.visible
                      ? ".loading"
                      : ".hidden",
                  context: {
                    ...context,
                    view: { ...context.view, visible: event.visible },
                  },
                },
        },
        states: {
          choosing: {
            always: ({ context }) => ({
              target: context.request
                ? "paused"
                : context.view.visible
                  ? "loading"
                  : "hidden",
            }),
          },
          loading: {
            always: ({ context }) =>
              context.request ? { target: "paused" } : undefined,
            invoke: {
              src: "read",
              input: ({ context }) => context.view,
              onDone: ({ context, event }) =>
                Exit.isFailure(event.output)
                  ? {
                      target: context.view.visible ? "waiting" : "hidden",
                      context: {
                        ...context,
                        error: message(
                          event.output.cause,
                          "Could not load runs."
                        ),
                        failure: event.output.cause,
                      },
                    }
                  : {
                      target: context.view.visible ? "waiting" : "hidden",
                      context: {
                        ...context,
                        loaded: true,
                        error: "",
                        runs: event.output.value.runs,
                        detail: event.output.value.detail,
                      },
                    },
            },
          },
          waiting: {
            always: ({ context }) =>
              context.request ? { target: "paused" } : undefined,
            after: { 2500: { target: "loading" } },
            on: {
              REFRESH: ({ context }) => ({
                target: "loading",
                context: { ...context, error: "" },
              }),
            },
          },
          paused: {
            always: ({ context }) =>
              context.request ? undefined : { target: "choosing" },
          },
          hidden: {
            always: ({ context }) =>
              context.request ? { target: "paused" } : undefined,
            on: {
              REFRESH: ({ context }) => ({
                target: "loading",
                context: { ...context, error: "" },
              }),
            },
          },
        },
      },
      command: {
        initial: "ready",
        states: {
          ready: {
            on: {
              START: ({ context, event }) => {
                if (context.attempt)
                  return admitted(context, {
                    kind: "run",
                    input: context.attempt,
                  })
                if (context.runs.some((run) => run.status === "running")) return
                try {
                  const input = Schema.decodeUnknownSync(RunInput)(event)
                  return admitted(context, { kind: "run", input })
                } catch {
                  return {
                    context: {
                      ...context,
                      error:
                        "Use valid JSON input and code within the displayed size limits.",
                    },
                  }
                }
              },
              CANCEL: ({ context, event }) =>
                admitted(context, { kind: "cancel", id: event.id }),
            },
          },
          requesting: {
            invoke: {
              src: "command",
              input: ({ context }) => context.request!,
              onDone: (args, enq) => {
                const { context, event, actions } = args
                const target = "ready"
                if (Exit.isFailure(event.output))
                  return {
                    target,
                    context: {
                      ...context,
                      request: null,
                      error: message(
                        event.output.cause,
                        "The request failed. Retry the same run."
                      ),
                      failure: event.output.cause,
                    },
                  }
                const run = event.output.value
                const current = context.revision === context.requestRevision
                if (current)
                  enq(actions.select, {
                    ...args,
                    params: { id: run.id, expected: context.requestSelection },
                  })
                return {
                  target,
                  context: {
                    ...context,
                    request: null,
                    attempt:
                      context.attempt?.id === run.id ? null : context.attempt,
                    runs: [
                      run,
                      ...context.runs.filter((value) => value.id !== run.id),
                    ].slice(0, 50),
                    detail:
                      current || context.view.selected === run.id
                        ? run
                        : context.detail,
                    error: "",
                    failure: undefined,
                  },
                }
              },
            },
          },
        },
      },
    },
  })
}
