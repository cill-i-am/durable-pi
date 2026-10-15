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
  list: () => SavedConnection[]
  get: (id: string) => SavedConnection | undefined
  add: (input: NewConnection) => SavedConnection
  change: (
    id: string,
    expectedRevision: number,
    active: boolean
  ) => SavedConnection
  selection: () => ToolSelection
  select: (
    expectedRevision: number,
    tools: readonly RemoteTool[]
  ) => ToolSelection
}
export type ConnectionFailure = ConnectionError | ConnectionStorageError
export type RemoteToolResolution = { tools: RemoteTool[]; error: string | null }
export interface RemoteSelectionRepository {
  selection: () => Effect.Effect<ToolSelection, ConnectionFailure>
  select: (
    expectedRevision: number,
    tools: readonly RemoteTool[],
    canWrite: () => boolean
  ) => Effect.Effect<ToolSelection, ConnectionFailure>
}
