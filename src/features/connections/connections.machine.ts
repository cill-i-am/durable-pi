import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema, type Cause, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import {
  ChangeConnection,
  ConnectionList,
  NewConnection,
  SelectRemoteTools,
  ToolSelection,
} from "@/access/connections"

export const ConnectionsView = Schema.Struct({
  agentId: Schema.UndefinedOr(Schema.String),
  open: Schema.Boolean,
})
export type ConnectionsView = typeof ConnectionsView.Type
export const ConnectionCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("add"), body: NewConnection }),
  Schema.Struct({
    action: Schema.Literals(["refresh", "reconnect", "disconnect"]),
    body: ChangeConnection,
  }),
  Schema.Struct({ action: Schema.Literal("select"), body: SelectRemoteTools }),
])
export type ConnectionCommand = typeof ConnectionCommand.Type
export const ConnectionRequest = Schema.Struct({
  requestId: Schema.String,
  agentId: Schema.UndefinedOr(Schema.String),
  command: ConnectionCommand,
})
export type ConnectionRequest = typeof ConnectionRequest.Type
const catalog = Schema.Struct({
  library: ConnectionList,
  selection: ToolSelection,
})
export type ConnectionCatalog = typeof catalog.Type
const result = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("library"), value: ConnectionList }),
  Schema.Struct({ kind: Schema.Literal("selection"), value: ToolSelection }),
])
export type ConnectionResult = typeof result.Type
export type ConnectionsWork = {
  read: () => Effect.Effect<ConnectionCatalog, unknown, Scope.Scope>
  command: (
    input: ConnectionCommand
  ) => Effect.Effect<ConnectionResult, unknown, Scope.Scope>
}
const context = Schema.Struct({
  view: ConnectionsView,
  catalog: Schema.NullOr(catalog),
  request: Schema.NullOr(ConnectionRequest),
  error: Schema.String,
  failure: Schema.UndefinedOr(Schema.Unknown),
})
type Context = typeof context.Type
function currentRequest(current: Context, input: ConnectionRequest) {
  if (
    input.agentId !== current.view.agentId ||
    !current.catalog ||
    !current.view.open
  )
    return false
  const command = input.command
  if ((command.action === "select") !== (current.view.agentId !== undefined))
    return false
  if (command.action === "add")
    return !current.catalog.library.connections.some(
      (connection) =>
        connection.id === command.body.id &&
        (connection.name !== command.body.name ||
          connection.url !== command.body.url)
    )
  if (command.action === "select")
    return command.body.expectedRevision === current.catalog.selection.revision
  return current.catalog.library.connections.some(
    (connection) =>
      connection.id === command.body.id &&
      connection.revision === command.body.expectedRevision
  )
}
export function connectionsMachine(work: ConnectionsWork) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: ConnectionsView,
      context,
      events: {
        VIEW: Schema.Struct({ open: Schema.Boolean }),
        REFRESH: Schema.Struct({}),
        COMMAND: ConnectionRequest,
      },
      emitted: {
        settled: Schema.Struct({
          requestId: Schema.String,
          ok: Schema.Boolean,
        }),
      },
    },
    actors: {
      read: createEffectLogic(() => Effect.exit(work.read())),
      command: createEffectLogic(({ input }: { input: ConnectionCommand }) =>
        Effect.exit(work.command(input))
      ),
    },
  }).createMachine({
    id: "connections-ui",
    initial: "choosing",
    context: ({ input }) => ({
      view: input,
      catalog: null,
      request: null,
      error: "",
      failure: undefined,
    }),
    on: {
      VIEW: ({ context, event }) => ({
        context: { ...context, view: { ...context.view, open: event.open } },
      }),
      COMMAND: ({ event }, enq) => {
        enq.emit({ type: "settled", requestId: event.requestId, ok: false })
      },
    },
    states: {
      choosing: {
        always: ({ context }) => ({
          target: context.view.open ? "loading" : "hidden",
        }),
      },
      hidden: {
        always: ({ context }) =>
          context.view.open ? { target: "loading" } : undefined,
      },
      loading: {
        always: ({ context }) =>
          !context.view.open ? { target: "hidden" } : undefined,
        on: { REFRESH: { target: "loading", reenter: true } },
        invoke: {
          src: "read",
          onDone: ({ context, event }) =>
            Exit.isSuccess(event.output)
              ? {
                  target: "ready",
                  context: {
                    ...context,
                    catalog: event.output.value,
                    request: null,
                    error: "",
                    failure: undefined,
                  },
                }
              : {
                  target: "unavailable",
                  context: {
                    ...context,
                    error: connectionFailureMessage(
                      event.output.cause,
                      "Could not load connections. Reload to check their current status."
                    ),
                    failure: event.output.cause,
                  },
                },
        },
      },
      unavailable: {
        always: ({ context }) =>
          !context.view.open ? { target: "hidden" } : undefined,
        on: { REFRESH: { target: "loading" } },
      },
      ready: {
        always: ({ context }) =>
          !context.view.open ? { target: "hidden" } : undefined,
        on: {
          REFRESH: { target: "loading" },
          COMMAND: ({ context, event }, enq) => {
            const input = Schema.decodeUnknownSync(ConnectionRequest)(event)
            if (!currentRequest(context, input)) {
              enq.emit({
                type: "settled",
                requestId: input.requestId,
                ok: false,
              })
              return
            }
            return {
              target: "mutating",
              context: {
                ...context,
                request: input,
                error: "",
                failure: undefined,
              },
            }
          },
        },
      },
      mutating: {
        invoke: {
          src: "command",
          input: ({ context }) => context.request!.command,
          onDone: ({ context, event }, enq) => {
            const ok = Exit.isSuccess(event.output)
            enq.emit({
              type: "settled",
              requestId: context.request!.requestId,
              ok,
            })
            if (Exit.isFailure(event.output))
              return {
                target: "uncertain",
                context: {
                  ...context,
                  error: connectionFailureMessage(
                    event.output.cause,
                    "The change could not be confirmed. Reload to check the result, or retry the same request."
                  ),
                  failure: event.output.cause,
                },
              }
            const value = event.output.value
            return {
              target: "ready",
              context: {
                ...context,
                catalog:
                  value.kind === "library"
                    ? { ...context.catalog!, library: value.value }
                    : { ...context.catalog!, selection: value.value },
                request: null,
                error: "",
                failure: undefined,
              },
            }
          },
        },
      },
      uncertain: {
        on: {
          REFRESH: { target: "loading" },
          COMMAND: ({ context, event }, enq) => {
            const input = Schema.decodeUnknownSync(ConnectionRequest)(event)
            if (
              !currentRequest(context, input) ||
              JSON.stringify(input.command) !==
                JSON.stringify(context.request!.command)
            ) {
              enq.emit({
                type: "settled",
                requestId: input.requestId,
                ok: false,
              })
              return
            }
            return {
              target: "mutating",
              context: {
                ...context,
                request: input,
                error: "",
                failure: undefined,
              },
            }
          },
        },
      },
    },
  })
}

const hasMessage = Schema.is(Schema.Struct({ message: Schema.String }))
function connectionFailureMessage(
  cause: Cause.Cause<unknown>,
  fallback: string
) {
  const failure = cause.reasons.find((reason) => reason._tag === "Fail")
  return failure?._tag === "Fail" && hasMessage(failure.error)
    ? `${failure.error.message} ${fallback}`
    : fallback
}
