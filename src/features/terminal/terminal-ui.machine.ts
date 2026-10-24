import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import {
  CommandInput,
  CommandRun,
  TerminalNetworkPolicy,
  TerminalState,
} from "@/terminal/contracts"

const Attempt = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("command"), input: CommandInput }),
  Schema.Struct({
    kind: Schema.Literal("session"),
    input: Schema.Struct({ id: Schema.String }),
  }),
  Schema.Struct({
    kind: Schema.Literal("import"),
    input: Schema.Struct({ id: Schema.String, fileId: Schema.String }),
  }),
  Schema.Struct({
    kind: Schema.Literal("export"),
    input: Schema.Struct({ id: Schema.String, path: Schema.String }),
  }),
])
export type TerminalAttempt = typeof Attempt.Type
export const TerminalIntent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("start"), attempt: Attempt }),
  Schema.Struct({ type: Schema.Literal("retry") }),
  Schema.Struct({ type: Schema.Literal("cancelPending") }),
  Schema.Struct({ type: Schema.Literal("cancel"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("save") }),
  Schema.Struct({ type: Schema.Literal("cleanup") }),
  Schema.Struct({
    type: Schema.Literal("network"),
    policy: TerminalNetworkPolicy,
  }),
])
export type TerminalIntent = typeof TerminalIntent.Type
const Request = Schema.Struct({
  ticket: Schema.String,
  selected: Schema.NullOr(Schema.String),
  viewRevision: Schema.Number,
  path: Schema.String,
  body: Schema.Unknown,
  kind: Schema.Literals(["run", "cancelPending", "save", "cleanup", "network"]),
})
export type TerminalRequest = typeof Request.Type
const Result = Schema.Struct({
  history: Schema.NullOr(TerminalState),
  run: Schema.NullOr(CommandRun),
})
export type TerminalResult = typeof Result.Type
const context = Schema.Struct({
  agentId: Schema.String,
  selected: Schema.NullOr(Schema.String),
  viewRevision: Schema.Number,
  visible: Schema.Boolean,
  history: Schema.NullOr(TerminalState),
  detail: Schema.NullOr(CommandRun),
  pending: Schema.NullOr(Attempt),
  request: Schema.NullOr(Request),
  error: Schema.String,
  failure: Schema.Unknown,
})
type Context = typeof context.Type
const hasMessage = Schema.is(Schema.Struct({ message: Schema.String }))
const errorMessage = (cause: Cause.Cause<unknown>, fallback: string) => {
  const failure = cause.reasons.find((reason) => reason._tag === "Fail")
  return failure?._tag === "Fail" && hasMessage(failure.error)
    ? failure.error.message
    : fallback
}
const attemptPath = (attempt: TerminalAttempt) =>
  attempt.kind === "command"
    ? "terminal/run"
    : attempt.kind === "session"
      ? "terminal/session"
      : attempt.kind === "import"
        ? "terminal/files/import"
        : "terminal/export"
function prepare(
  current: Context,
  ticket: string,
  intent: TerminalIntent
): { request: TerminalRequest; pending: TerminalAttempt | null } | undefined {
  const command = (
    path: string,
    body: unknown,
    kind: TerminalRequest["kind"],
    pending = current.pending
  ) => ({
    request: {
      ticket,
      selected: current.selected,
      viewRevision: current.viewRevision,
      path,
      body,
      kind,
    },
    pending,
  })
  if (intent.type === "start" || intent.type === "retry") {
    const pending =
      current.pending ?? (intent.type === "start" ? intent.attempt : null)
    if (
      !pending ||
      (intent.type === "start" &&
        current.pending &&
        intent.attempt.kind !== current.pending.kind)
    )
      return
    return command(attemptPath(pending), pending.input, "run", pending)
  }
  if (intent.type === "cancelPending")
    return current.pending
      ? command(
          `terminal/${encodeURIComponent(current.pending.input.id)}/cancel`,
          {},
          "cancelPending"
        )
      : undefined
  if (intent.type === "cancel")
    return command(
      `terminal/${encodeURIComponent(intent.id)}/cancel`,
      {},
      "run"
    )
  if (intent.type === "save")
    return current.history?.session
      ? command(
          `terminal/session/${encodeURIComponent(current.history.session.id)}/save`,
          {},
          "save"
        )
      : undefined
  if (intent.type === "network")
    return command("terminal/network", intent.policy, "network")
  return command("terminal/cleanup", {}, "cleanup")
}
export type TerminalWork = {
  read: (
    selected: string | null
  ) => Effect.Effect<TerminalResult, unknown, Scope.Scope>
  command: (
    request: TerminalRequest
  ) => Effect.Effect<TerminalResult, unknown, Scope.Scope>
}
export function terminalUiMachine(work: TerminalWork) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: Schema.Struct({
        agentId: Schema.String,
        selected: Schema.NullOr(Schema.String),
        visible: Schema.Boolean,
      }),
      context,
      events: {
        INVALID: Schema.Struct({ message: Schema.String }),
        COMMAND: Schema.Struct({
          ticket: Schema.String,
          intent: TerminalIntent,
        }),
        SELECT: Schema.Struct({ selected: Schema.NullOr(Schema.String) }),
        REFRESH: Schema.Struct({}),
        VISIBILITY: Schema.Struct({ visible: Schema.Boolean }),
      },
      emitted: {
        settled: Schema.Struct({ ticket: Schema.String, ok: Schema.Boolean }),
        selected: Schema.Struct({ id: Schema.String }),
      },
    },
    actors: {
      read: createEffectLogic(({ input }: { input: string | null }) =>
        Effect.exit(work.read(input))
      ),
      command: createEffectLogic(({ input }: { input: TerminalRequest }) =>
        Effect.exit(work.command(input))
      ),
    },
  }).createMachine({
    id: "terminal-ui",
    type: "parallel",
    context: ({ input }) => ({
      ...input,
      viewRevision: 0,
      history: null,
      detail: null,
      pending: null,
      request: null,
      error: "",
      failure: undefined,
    }),
    on: {
      INVALID: ({ context, event }) => ({
        context: { ...context, error: event.message },
      }),
    },
    states: {
      observation: {
        initial: "choosing",
        on: {
          SELECT: ({ context, event }) =>
            event.selected === context.selected
              ? undefined
              : {
                  target: context.request
                    ? ".paused"
                    : context.visible
                      ? ".loading"
                      : ".hidden",
                  context: {
                    ...context,
                    selected: event.selected,
                    viewRevision: context.viewRevision + 1,
                    detail: null,
                    error: "",
                  },
                },
          REFRESH: ({ context }) => ({
            target: context.request ? ".paused" : ".loading",
            context: { ...context, error: "" },
          }),
          VISIBILITY: ({ context, event }) => ({
            target: context.request
              ? ".paused"
              : event.visible
                ? ".loading"
                : ".hidden",
            context: { ...context, visible: event.visible },
          }),
        },
        states: {
          choosing: {
            always: ({ context }) => ({
              target: context.visible ? "loading" : "hidden",
            }),
          },
          loading: {
            always: ({ context }) =>
              context.request ? { target: "paused" } : undefined,
            invoke: {
              src: "read",
              input: ({ context }) => context.selected,
              onDone: ({ context, event }) =>
                Exit.isSuccess(event.output)
                  ? {
                      target: "waiting",
                      context: {
                        ...context,
                        history: event.output.value.history,
                        detail: event.output.value.run,
                      },
                    }
                  : {
                      target: "waiting",
                      context: {
                        ...context,
                        error: errorMessage(
                          event.output.cause,
                          "Could not load runs."
                        ),
                        failure: event.output.cause,
                      },
                    },
            },
          },
          waiting: {
            always: ({ context }) =>
              context.request ? { target: "paused" } : undefined,
            after: { 2500: { target: "loading" } },
          },
          hidden: {
            always: ({ context }) =>
              context.request ? { target: "paused" } : undefined,
          },
          paused: {
            always: ({ context }) =>
              context.request
                ? undefined
                : { target: context.visible ? "loading" : "hidden" },
          },
        },
      },
      mutation: {
        initial: "idle",
        states: {
          idle: {
            on: {
              COMMAND: ({ context, event }, enq) => {
                const next = prepare(context, event.ticket, event.intent)
                if (!next) {
                  enq.emit({ type: "settled", ticket: event.ticket, ok: false })
                  return
                }
                return {
                  target: "requesting",
                  context: {
                    ...context,
                    ...next,
                    error: "",
                    failure: undefined,
                  },
                }
              },
            },
          },
          requesting: {
            on: {
              COMMAND: ({ event }, enq) => {
                enq.emit({ type: "settled", ticket: event.ticket, ok: false })
              },
            },
            invoke: {
              src: "command",
              input: ({ context }) => context.request!,
              onDone: ({ context, event }, enq) => {
                const request = context.request!,
                  ok = Exit.isSuccess(event.output)
                enq.emit({ type: "settled", ticket: request.ticket, ok })
                if (Exit.isFailure(event.output))
                  return {
                    target: "idle",
                    context: {
                      ...context,
                      request: null,
                      failure: event.output.cause,
                      error: errorMessage(
                        event.output.cause,
                        request.kind === "cancelPending"
                          ? "Cancellation is unconfirmed. Retry cancelling this request."
                          : request.kind === "save"
                            ? "Save could not be confirmed. Check the saved command status before starting again."
                            : "The request failed. Retry the same run."
                      ),
                    },
                  }
                const run = event.output.value.run,
                  history = event.output.value.history ?? context.history
                const sameView = context.viewRevision === request.viewRevision
                if (run && sameView) enq.emit({ type: "selected", id: run.id })
                return {
                  target: "idle",
                  context: {
                    ...context,
                    request: null,
                    pending:
                      (request.kind === "run" &&
                        run?.id === context.pending?.input.id) ||
                      request.kind === "cancelPending"
                        ? null
                        : context.pending,
                    error: "",
                    selected: sameView
                      ? (run?.id ?? context.selected)
                      : context.selected,
                    detail: sameView ? (run ?? context.detail) : context.detail,
                    history:
                      run && history
                        ? {
                            ...history,
                            busy: true,
                            runs: [
                              { ...run, label: run.command.slice(0, 100) },
                              ...history.runs.filter(
                                (value) => value.id !== run.id
                              ),
                            ].slice(0, 20),
                          }
                        : history,
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
