import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schema,
} from "effect"
import { orDieAll, preserveFatal } from "../shared/effect"
import { CodeOutput, ExecutionFailure, RunId, RunInput } from "./contracts"
import type { CodeRun, ExecutionStorageError } from "./contracts"
import { ExecutorUnavailable, type CodeExecutor } from "./executor"
import type { ExecutionLedger } from "./ledger"
import type { ExecutionOperations, ExecutionTask } from "./execution"
import { admitExecution, finishExecution, unavailableOutput } from "./domain"

export class Executions extends Context.Service<
  Executions,
  ExecutionOperations
>()("durable-pi/execution/Executions") {}

const decode = <T>(schema: Schema.ConstraintDecoder<T>, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(
      () => new ExecutionFailure({ message: "Invalid execution request." })
    )
  )

export const makeExecutions = (
  ledger: ExecutionLedger,
  executor: CodeExecutor,
  writable: () => Effect.Effect<boolean, ExecutionStorageError>
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const active = new Map<
      string,
      Fiber.Fiber<CodeRun, ExecutionStorageError>
    >()
    let closed = false
    let fatal: Cause.Cause<ExecutionStorageError> | undefined
    // forkIn joins children before this earlier finalizer. Retain their failed
    // exits because native scope interruption discards child cleanup defects.
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        closed = true
        return fatal ? Effect.failCause(fatal).pipe(orDieAll) : Effect.void
      })
    )
    const finish = (
      id: string,
      status: Exclude<CodeRun["status"], "running">,
      output: CodeOutput | null
    ) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        return yield* ledger.atomic(() =>
          Effect.gen(function* () {
            const run = yield* ledger.get(id)
            if (!run) throw new Error("An admitted execution disappeared")
            const next = finishExecution(run, status, output, now)
            if (next !== run) yield* ledger.put(next)
            return next
          })
        )
      })
    const completion = (
      fiber: Fiber.Fiber<CodeRun, ExecutionStorageError>,
      id: string
    ) =>
      Fiber.await(fiber).pipe(
        Effect.flatMap((exit) => {
          if (Exit.isSuccess(exit)) return Effect.succeed(exit.value)
          if (
            Cause.hasInterrupts(exit.cause) &&
            !Cause.hasDies(exit.cause) &&
            !Cause.hasFails(exit.cause)
          )
            return ledger.get(id).pipe(
              Effect.map((saved) => {
                if (!saved || saved.status === "running")
                  throw new Error("Interrupted execution was not sealed")
                return saved
              })
            )
          return Effect.failCause(exit.cause)
        })
      )
    const start = Effect.fn("Execution.start")((raw: RunInput) =>
      Effect.gen(function* () {
        const input = yield* decode(RunInput, raw)
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (closed)
              return yield* new ExecutionFailure({
                message: "The execution host has stopped.",
              })
            if (fatal) return yield* Effect.failCause(fatal)
            const now = yield* Clock.currentTimeMillis
            const admission = yield* ledger.atomic(() =>
              Effect.gen(function* () {
                const previous = yield* ledger.get(input.id)
                const counts = yield* ledger.counts()
                const allowed = yield* writable()
                const result = admitExecution(
                  input,
                  previous,
                  counts,
                  allowed,
                  active.size > 0,
                  now
                )
                if (result._tag === "Success" && result.success.fresh)
                  yield* ledger.put(result.success.run)
                return result
              })
            )
            const { run, fresh } = yield* Effect.fromResult(admission)
            const pending = active.get(run.id)
            if (pending) return { run, completion: completion(pending, run.id) }
            if (!fresh) return { run, completion: Effect.succeed(run) }
            const begin = yield* Deferred.make<void>()
            const perform = Effect.gen(function* () {
              yield* Deferred.await(begin)
              if (!(yield* writable()))
                return yield* finish(run.id, "cancelled", null)
              const output = yield* executor.run(run.input).pipe(
                Effect.flatMap((value) =>
                  Schema.decodeUnknownEffect(CodeOutput)(value).pipe(
                    Effect.mapError(() => new ExecutorUnavailable())
                  )
                ),
                preserveFatal,
                Effect.catchTag("ExecutorUnavailable", () =>
                  Effect.succeed(unavailableOutput())
                )
              )
              return yield* finish(
                run.id,
                output.error ? "failed" : "succeeded",
                output
              )
            }).pipe(
              Effect.onInterrupt(() =>
                finish(run.id, "interrupted", null).pipe(orDieAll)
              ),
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (
                    Exit.isFailure(exit) &&
                    (Cause.hasDies(exit.cause) || Cause.hasFails(exit.cause))
                  )
                    fatal = exit.cause
                  active.delete(run.id)
                })
              )
            )
            const fiber = yield* Effect.forkIn(
              Effect.interruptible(perform),
              scope
            )
            active.set(run.id, fiber)
            yield* Deferred.succeed(begin, undefined)
            return {
              run,
              completion: completion(fiber, run.id),
            } satisfies ExecutionTask
          })
        )
      })
    )
    const cancel = Effect.fn("Execution.cancel")((raw: string) =>
      Effect.gen(function* () {
        const id = yield* decode(RunId, raw)
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const found = yield* ledger.get(id)
            if (!found)
              return yield* new ExecutionFailure({ message: "Run not found." })
            const saved = yield* finish(id, "cancelled", null)
            const pending = active.get(id)
            if (pending) {
              yield* Fiber.interrupt(pending)
              return yield* completion(pending, id)
            }
            return saved
          })
        )
      })
    )
    return {
      list: Effect.fn("Execution.list")(() => ledger.list()),
      get: Effect.fn("Execution.get")((id: string) => ledger.get(id)),
      start,
      cancel,
      // 4.0.1 attaches RunOptions.signal after initial evaluation. Yield before
      // durable admission so an already-aborted host call cannot create an intent.
      run: Effect.fn("Execution.run")((input: RunInput) =>
        Effect.yieldNow.pipe(
          Effect.andThen(
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const task = yield* start(input)
                return yield* restore(task.completion).pipe(
                  Effect.onInterrupt(() => cancel(input.id).pipe(orDieAll))
                )
              })
            )
          )
        )
      ),
      recover: Effect.fn("Execution.recover")(() =>
        Effect.gen(function* () {
          if (active.size)
            return yield* new ExecutionFailure({
              message: "Wait for the current run before recovery.",
            })
          const now = yield* Clock.currentTimeMillis
          yield* ledger.atomic(() =>
            Effect.gen(function* () {
              for (const run of yield* ledger.running())
                yield* ledger.put(
                  finishExecution(run, "interrupted", null, now)
                )
            })
          )
        })
      ),
    } satisfies ExecutionOperations
  })

export const executionApplication = (
  ledger: ExecutionLedger,
  executor: CodeExecutor,
  writable: () => Effect.Effect<boolean, ExecutionStorageError>
) => Layer.effect(Executions, makeExecutions(ledger, executor, writable))
