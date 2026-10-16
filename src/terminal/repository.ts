import type { Effect } from "effect"
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
    revokeThrough?: number
  ) => Effect.Effect<void, TerminalStorageError | TerminalFailure>
  authorized: (run: CommandRun) => Effect.Effect<boolean, TerminalStorageError>
  get: (
    id: string
  ) => Effect.Effect<CommandRun | undefined, TerminalStorageError>
  list: () => Effect.Effect<CommandSummary[], TerminalStorageError>
  checkpoint: () => Effect.Effect<Checkpoint | null, TerminalStorageError>
  exported: (
    id: string
  ) => Effect.Effect<Checkpoint | null, TerminalStorageError>
  admit: (
    input: CommandInput,
    kind?: NonNullable<CommandRun["kind"]>,
    transfer?: CommandRun["transfer"]
  ) => Effect.Effect<CommandRun, TerminalFailure | TerminalStorageError>
  progress: (
    id: string,
    output: string
  ) => Effect.Effect<void, TerminalStorageError | TerminalFailure>
  finish: (
    id: string,
    result: Pick<CommandRun, "status" | "exitCode" | "error">,
    checkpoint?: Checkpoint,
    exported?: Checkpoint
  ) => Effect.Effect<CommandRun, TerminalFailure | TerminalStorageError>
  cancel: (
    id: string
  ) => Effect.Effect<CommandRun | null, TerminalFailure | TerminalStorageError>
  recover: () => Effect.Effect<void, TerminalStorageError>
}
