import type { Effect } from "effect"

import type { CommandRecord } from "./command.machine"
import type {
  CommandInput,
  CommandRun,
  CommandSummary,
  Checkpoint,
  TerminalNetworkPolicy,
  TerminalFailure,
  TerminalStorageError,
} from "./contracts"

export type TerminalAuthority = {
  revision: number
  active: number
  revokedThrough: number
}
/** Persist admission before dispatch; never replay interrupted work. TValue finished
 * result and checkpoint/export must commit atomically under current authority. */
export interface TerminalLedger {
  networkPolicy: () => Effect.Effect<
    TerminalNetworkPolicy,
    TerminalStorageError
  >
  configureNetwork: (
    input: TerminalNetworkPolicy
  ) => Effect.Effect<
    TerminalNetworkPolicy,
    TerminalFailure | TerminalStorageError
  >
  configure: (
    revision: number,
    active: boolean,
    revokeThrough?: number,
    committed?: (authority: TerminalAuthority) => void
  ) => Effect.Effect<void, TerminalStorageError | TerminalFailure>
  authorized: (run: CommandRun) => Effect.Effect<boolean, TerminalStorageError>
  get: (
    id: string
  ) => Effect.Effect<CommandRecord | undefined, TerminalStorageError>
  list: () => Effect.Effect<CommandSummary[], TerminalStorageError>
  checkpoint: () => Effect.Effect<Checkpoint | null, TerminalStorageError>
  exported: (
    id: string
  ) => Effect.Effect<Checkpoint | null, TerminalStorageError>
  claim: (
    input: CommandInput,
    kind: NonNullable<CommandRun["kind"]>,
    transfer: CommandRun["transfer"],
    attemptId: string
  ) => Effect.Effect<
    { run: CommandRecord; fresh: boolean },
    TerminalFailure | TerminalStorageError
  >
  blocked: () => Effect.Effect<boolean, TerminalStorageError>
  occupied: () => Effect.Effect<boolean, TerminalStorageError>
  cleaning: (ownerId: string) => Effect.Effect<void, TerminalStorageError>
  release: (
    ownerId: string,
    confirmed: boolean
  ) => Effect.Effect<void, TerminalStorageError>
  progress: (
    id: string,
    output: string,
    attemptId: string
  ) => Effect.Effect<void, TerminalStorageError | TerminalFailure>
  finish: (
    id: string,
    result: Pick<CommandRun, "status" | "exitCode" | "error">,
    checkpoint?: Checkpoint,
    exported?: Checkpoint,
    attemptId?: string
  ) => Effect.Effect<CommandRun, TerminalFailure | TerminalStorageError>
  cancelled: (id: string) => Effect.Effect<boolean, TerminalStorageError>
  cancel: (
    id: string,
    committed?: () => void
  ) => Effect.Effect<CommandRun | null, TerminalFailure | TerminalStorageError>
  recover: (ownerId?: string) => Effect.Effect<void, TerminalStorageError>
}
