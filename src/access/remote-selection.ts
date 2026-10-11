import { Effect } from "effect"
import type { ConnectionStore } from "./adapters/connections"
import {
  ConnectionError,
  type RemoteTool,
  type SelectRemoteTools,
} from "./connections"

export function selectRemoteTools(
  store: ConnectionStore,
  input: typeof SelectRemoteTools.Type,
  resolve: (
    names: readonly string[]
  ) => Promise<{ tools: RemoteTool[]; error: string | null }>,
  canWrite: () => boolean
) {
  return Effect.gen(function* () {
    const pinned = store.selection().tools
    const missing = input.names.filter(
      (name) => !pinned.some((tool) => tool.name === name)
    )
    const resolved = missing.length
      ? yield* Effect.tryPromise(() => resolve(missing))
      : { tools: [], error: null }
    if (resolved.error)
      return yield* new ConnectionError({ message: resolved.error })
    return yield* Effect.try({
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
        return store.select(input.expectedRevision, tools)
      },
      catch: (cause) => cause,
    })
  })
}
