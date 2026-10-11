import { Effect, Schema } from "effect"
import {
  CodeOutput,
  ExecutionFailure,
  RunInput,
  type CodeRun,
  type CodeInput,
  type RunSummary,
} from "./contracts"

export interface ExecutionRepository {
  list: () => RunSummary[]
  get: (id: string) => CodeRun | undefined
  admit: (input: RunInput) => CodeRun
  finish: (
    id: string,
    status: CodeRun["status"],
    output: CodeOutput | null
  ) => CodeRun
  recover: () => void
}
export interface CodeExecutor {
  run: (input: CodeInput, signal: AbortSignal) => Promise<CodeOutput>
}

/** Each bot owns durable intent/results. Generated code receives only its explicit JSON input. */
export class Executions {
  private readonly active = new Map<
    string,
    { controller: AbortController; completion: Promise<CodeRun> }
  >()
  constructor(
    readonly repository: ExecutionRepository,
    private readonly executor: CodeExecutor,
    private readonly writable: () => boolean
  ) {}
  recover() {
    this.repository.recover()
  }
  start(input: RunInput, signal?: AbortSignal) {
    return Effect.try({
      try: () => {
        if (signal?.aborted)
          throw new ExecutionFailure({ message: "This run was stopped." })
        const decoded = Schema.decodeUnknownSync(RunInput)(input)
        const existing = this.repository.get(decoded.id)
        if (!existing && !this.writable())
          throw new ExecutionFailure({
            message: "Restore this bot before running code.",
          })
        const run = this.repository.admit(decoded)
        const pending = this.active.get(run.id)
        if (!pending && (existing || run.status !== "running"))
          return { run, completion: Promise.resolve(run) }
        const controller = pending?.controller ?? new AbortController()
        const stop = () => {
          this.repository.finish(run.id, "cancelled", null)
          controller.abort()
        }
        signal?.addEventListener("abort", stop, { once: true })
        const work =
          pending?.completion ??
          this.perform(run, controller.signal).finally(() => {
            this.active.delete(run.id)
          })
        const completion = work.finally(() =>
          signal?.removeEventListener("abort", stop)
        )
        if (!pending) this.active.set(run.id, { controller, completion })
        return { run, completion }
      },
      catch: (cause) =>
        cause instanceof ExecutionFailure
          ? cause
          : new ExecutionFailure({ message: "Invalid execution request." }),
    })
  }
  private async perform(run: CodeRun, signal: AbortSignal): Promise<CodeRun> {
    const stopped = () => signal.aborted
    // Admission is synchronous and durable before the asynchronous dispatch.
    await Promise.resolve()
    if (stopped() || !this.writable())
      return this.repository.finish(run.id, "cancelled", null)
    try {
      const output = Schema.decodeUnknownSync(CodeOutput)(
        await this.executor.run(run.input, signal)
      )
      return this.repository.finish(
        run.id,
        stopped() ? "cancelled" : output.error ? "failed" : "succeeded",
        stopped() ? null : output
      )
    } catch {
      return this.repository.finish(
        run.id,
        stopped() ? "cancelled" : "failed",
        stopped()
          ? null
          : {
              result: "",
              logs: "",
              error:
                "Execution could not finish. It may have exceeded its time, memory or output limit. Inspect the code before starting a new run.",
            }
      )
    }
  }
  cancel(id: string) {
    return Effect.try({
      try: () => {
        const run = this.repository.get(id)
        if (!run) throw new ExecutionFailure({ message: "Run not found." })
        this.repository.finish(id, "cancelled", null)
        this.active.get(id)?.controller.abort()
        return this.repository.get(id)!
      },
      catch: (cause) =>
        cause instanceof ExecutionFailure
          ? cause
          : new ExecutionFailure({ message: "Invalid execution request." }),
    })
  }
  async run(
    input: RunInput,
    signal: AbortSignal = new AbortController().signal
  ) {
    const operation = await Effect.runPromise(this.start(input, signal))
    return operation.completion
  }
}
