import { Schema, Effect } from "effect"
import type {
  ConnectionFailure,
  RemoteSelectionRepository,
  RemoteToolResolution,
} from "./connection-ledger"
import { ConnectionError, type SelectRemoteTools } from "./connections"

export function selectRemoteTools(
  store: RemoteSelectionRepository,
  input: typeof SelectRemoteTools.Type,
  resolve: (
    names: readonly string[]
  ) => Effect.Effect<RemoteToolResolution, ConnectionFailure>,
  canWrite: () => boolean
) {
  return Effect.gen(function* () {
    const pinned = (yield* store.selection()).tools
    const missing = input.names.filter(
      (name) => !pinned.some((tool) => tool.name === name)
    )
    const resolved = missing.length
      ? yield* resolve(missing)
      : { tools: [], error: null }
    if (resolved.error)
      return yield* new ConnectionError({ message: resolved.error })
    const selected = yield* Effect.try({
      try: () => {
        if (!canWrite())
          throw new ConnectionError({
            message: "Restore this bot before changing its tools.",
          })
        const tools = input.names.map((name) => {
          const tool = [...pinned, ...resolved.tools].find(
            (value) => value.name === name
          )
          if (!tool)
            throw new ConnectionError({
              message:
                "A selected tool changed or disconnected. Reload the connections.",
            })
          return tool
        })
        return tools
      },
      catch: (cause) => {
        const connectionError =
          Schema.decodeUnknownOption(ConnectionError)(cause)
        if (connectionError._tag === "Some") return connectionError.value
        throw cause
      },
    })
    return yield* store.select(input.expectedRevision, selected, canWrite)
  }).pipe(Effect.withSpan("Access.selectRemoteTools"))
}
