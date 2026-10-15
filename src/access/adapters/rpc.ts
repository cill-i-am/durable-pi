import { Cause, Exit, Schema } from "effect"
import {
  ConnectionError,
  ConnectionStorageError,
  ConnectionTransportError,
  RemoteTool,
  RemoteToolResult,
  SelectRemoteTools,
} from "../connections"
import { rpcOutcome } from "../../shared/rpc-outcome"
import { nativeOperation } from "../../shared/interop"

const ToolSnapshot = Schema.Struct({
  ...RemoteTool.fields,
  parameters: Schema.Record(Schema.String, Schema.Json),
})
const ResolvedTools = Schema.Array(ToolSnapshot)
export const ConnectionRequest = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Resolve"),
    names: SelectRemoteTools.fields.names,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Call"),
    name: Schema.String.check(Schema.isPattern(/^mcp_[a-f0-9]{40}$/)),
    argumentsJson: Schema.String.check(Schema.isMaxLength(64_000)),
  }),
])
export const ConnectionResult = Schema.Union([ResolvedTools, RemoteToolResult])
export const ConnectionFailure = Schema.Union([
  ConnectionError,
  ConnectionStorageError,
  ConnectionTransportError,
])
const outcome = rpcOutcome(
  ConnectionResult,
  ConnectionFailure,
  "Connected tool operation failed unexpectedly."
)
export const ConnectionOutcome = {
  ...outcome,
  encode: (
    exit: Exit.Exit<typeof ConnectionResult.Type, unknown>
  ): Schema.Json =>
    outcome.encode(
      Exit.isSuccess(exit)
        ? exit
        : Exit.failCause(
            Cause.map(exit.cause, (cause) => {
              const known = Schema.decodeUnknownOption(ConnectionFailure)(cause)
              if (known._tag === "None") return cause
              switch (known.value._tag) {
                case "ConnectionError":
                  return known.value
                case "ConnectionStorageError":
                  return new ConnectionStorageError({
                    operation: known.value.operation,
                    cause: "Remote connection storage failed.",
                  })
                case "ConnectionTransportError":
                  return new ConnectionTransportError({
                    operation: known.value.operation,
                    cause: "Remote connection transport failed.",
                  })
              }
            })
          )
    ),
}
export function connectionRpc(stub: {
  connectionsV1: (input: typeof ConnectionRequest.Type) => Promise<unknown>
}) {
  return {
    resolve: (names: (typeof SelectRemoteTools.Type)["names"]) =>
      stub
        .connectionsV1({ _tag: "Resolve", names })
        .then((raw) => [...ConnectionOutcome.unwrap(raw, ResolvedTools)]),
    call: (name: string, argumentsJson: string) =>
      stub
        .connectionsV1({ _tag: "Call", name, argumentsJson })
        .then((raw) => ConnectionOutcome.unwrap(raw, RemoteToolResult)),
  }
}
export const connectionNative = <T>(start: () => Promise<T>) =>
  nativeOperation(start, (cause, channel) => {
    const known = Schema.decodeUnknownOption(ConnectionFailure)(cause)
    if (known._tag === "Some") return known.value
    if (channel === "failure" || Schema.isSchemaError(cause)) throw cause
    return new ConnectionTransportError({
      operation: "call connection owner",
      cause,
    })
  })
