import type { Effect } from "effect"

import type {
  NewConnection,
  SavedConnection,
  RemoteTool,
  ToolSelection,
  ConnectionError,
  ConnectionStorageError,
} from "./connections"

export interface ConnectionLedger {
  list: () => Effect.Effect<SavedConnection[], ConnectionFailure>
  get: (
    id: string
  ) => Effect.Effect<SavedConnection | undefined, ConnectionFailure>
  add: (
    input: NewConnection,
    eligible: () => boolean
  ) => Effect.Effect<SavedConnection, ConnectionFailure>
  change: (
    id: string,
    expectedRevision: number,
    active: boolean,
    eligible: () => boolean
  ) => Effect.Effect<SavedConnection, ConnectionFailure>
  selection: () => Effect.Effect<ToolSelection, ConnectionFailure>
  select: (
    expectedRevision: number,
    tools: readonly RemoteTool[],
    canWrite?: () => Effect.Effect<boolean, ConnectionFailure>
  ) => Effect.Effect<ToolSelection, ConnectionFailure>
}
export type ConnectionFailure = ConnectionError | ConnectionStorageError
export type RemoteToolResolution = { tools: RemoteTool[]; error: string | null }
export interface RemoteSelectionRepository {
  selection: () => Effect.Effect<ToolSelection, ConnectionFailure>
  select: (
    expectedRevision: number,
    tools: readonly RemoteTool[],
    canWrite: () => Effect.Effect<boolean, ConnectionFailure>
  ) => Effect.Effect<ToolSelection, ConnectionFailure>
}
