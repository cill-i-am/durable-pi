import type { CodeRun, RunSummary } from "./contracts"

/** Every read and publication in the synchronous callback shares one native commit. */
export interface ExecutionLedger {
  atomic: <T>(body: () => T) => T
  list: () => RunSummary[]
  get: (id: string) => CodeRun | undefined
  counts: () => { total: number; running: number }
  running: () => CodeRun[]
  put: (run: CodeRun) => void
}
