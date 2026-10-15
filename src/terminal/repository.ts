import type {
  CommandInput,
  CommandRun,
  CommandSummary,
  Checkpoint,
  TerminalNetworkPolicy,
} from "./contracts"

export type TerminalAuthority = {
  revision: number
  active: number
  revokedThrough: number
}
/** Persist admission before dispatch; never replay interrupted work. A finished
 * result and checkpoint/export must commit atomically under current authority. */
export interface TerminalLedger {
  networkPolicy: () => TerminalNetworkPolicy
  configureNetwork: (input: TerminalNetworkPolicy) => TerminalNetworkPolicy
  configure: (revision: number, active: boolean, revokeThrough?: number) => void
  authorized: (run: CommandRun) => boolean
  get: (id: string) => CommandRun | undefined
  list: () => CommandSummary[]
  checkpoint: () => Checkpoint | null
  exported: (id: string) => Checkpoint | null
  admit: (
    input: CommandInput,
    kind?: NonNullable<CommandRun["kind"]>,
    transfer?: CommandRun["transfer"]
  ) => CommandRun
  progress: (id: string, output: string) => void
  finish: (
    id: string,
    result: Pick<CommandRun, "status" | "exitCode" | "error">,
    checkpoint?: Checkpoint,
    exported?: Checkpoint
  ) => CommandRun
  cancel: (id: string) => CommandRun | null
  recover: () => void
}
