import { Effect } from "effect"
import { preserveFatal } from "../../shared/effect"
import type { RemoteToolResolution } from "../connection-ledger"
import type {
  ConnectionError,
  ConnectionStorageError,
  ConnectionTransportError,
} from "../connections"

/** The public resolution contract carries safe, actionable diagnostics. */
export const remoteToolResolution = <TRequirements>(
  work: Effect.Effect<
    RemoteToolResolution["tools"],
    ConnectionError | ConnectionStorageError | ConnectionTransportError,
    TRequirements
  >
): Effect.Effect<RemoteToolResolution, never, TRequirements> =>
  work.pipe(
    Effect.map((tools) => ({ tools, error: null })),
    preserveFatal,
    Effect.catchTags({
      ConnectionError: (error) =>
        Effect.succeed({ tools: [], error: error.message }),
      ConnectionTransportError: () =>
        Effect.succeed({
          tools: [],
          error:
            "A selected tool is unavailable or has changed. Refresh its connection.",
        }),
      ConnectionStorageError: () =>
        Effect.succeed({
          tools: [],
          error: "Could not load these tools. Reload and try again.",
        }),
    })
  )
