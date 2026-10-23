import { createEffectActor, send, waitFor } from "@xstate/effect"
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
  Scope,
  Semaphore,
} from "effect"

import { orDieAll, preserveFatal } from "../shared/effect"
import {
  CodeOutput,
  CodeRun,
  ExecutionFailure,
  RunId,
  RunInput,
} from "./contracts"
import type { ExecutionStorageError } from "./contracts"
import { admitExecution, unavailableOutput } from "./domain"
import { executeRun } from "./driver"
import type { ExecutionOperations, ExecutionTask } from "./execution"
import { ExecutorUnavailable, type CodeExecutor } from "./executor"
import { executionHostMachine } from "./host.machine"
import type { ExecutionLedger } from "./ledger"
import {
  advanceExecutionRecord,
  type ExecutionEvent,
  type ExecutionRecord,
} from "./run.machine"

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
const receipt = Schema.decodeUnknownSync(CodeRun)

export const makeExecutions = (
  ledger: ExecutionLedger,
  executor: CodeExecutor,
  writable: () => Effect.Effect<boolean, ExecutionStorageError>
) =>
  Effect.gen(function* () {
    // Initialization is masked until the finalizer below owns both detached scopes.
    // Detached scopes are closed in order by the owning Layer finalizer. Admission
    // must stop before joining children, not in an earlier LIFO finalizer after them.
    const hostScope = yield* Scope.make()
    const workScope = yield* Scope.make()
    const host = yield* createEffectActor(executionHostMachine).pipe(
      Scope.provide(hostScope)
    )
    const admission = yield* Semaphore.make(1)
    const active = new Map<
      string,
      Fiber.Fiber<CodeRun, ExecutionStorageError>
    >()
    yield* Effect.addFinalizer((exit) =>
      Effect.gen(function* () {
        yield* send(host, { type: "CLOSE" })
        yield* waitFor(host, (state) => state.matches("closing")).pipe(
          Effect.orDie
        )
        // A claim already in progress must either reject or register its owner before
        // the child scope closes. The transaction rechecks the host after acquiring SQL.
        yield* admission.withPermit(Effect.void)
        yield* Scope.close(workScope, exit)
        yield* send(host, { type: "CLOSED" })
        yield* waitFor(host, (state) => state.status === "done").pipe(
          Effect.orDie
        )
        const failure = host.getSnapshot().context.failure
        if (failure) return yield* Effect.failCause(failure).pipe(orDieAll)
      }).pipe(Effect.ensuring(Scope.close(hostScope, exit)))
    )
    const ensureOpen = () =>
      Effect.suspend(
        (): Effect.Effect<void, ExecutionFailure | ExecutionStorageError> => {
          const state = host.getSnapshot()
          if (state.matches("failed"))
            return Effect.failCause(state.context.failure!)
          if (!state.matches("open"))
            return Effect.fail(
              new ExecutionFailure({
                message: "The execution host has stopped.",
              })
            )
          return Effect.void
        }
      )
    const update = (id: string, event: ExecutionEvent) =>
      ledger.atomic(() =>
        Effect.gen(function* () {
          const saved = yield* ledger.get(id)
          if (!saved) throw new Error("An admitted execution disappeared")
          const next = advanceExecutionRecord(saved, event)
          if (next.revision !== saved.revision) yield* ledger.put(next)
          return next
        })
      )
    const finish = (
      run: ExecutionRecord,
      kind: "CANCEL" | "INTERRUPT" | CodeOutput
    ) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const next = yield* update(
          run.id,
          typeof kind === "string"
            ? {
                type: kind,
                attemptId: run.attemptId,
                revision: run.revision,
                now,
              }
            : {
                type: "FINISH",
                attemptId: run.attemptId,
                revision: run.revision,
                output: kind,
                now,
              }
        )
        return receipt(next)
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
                return receipt(saved)
              })
            )
          return Effect.failCause(exit.cause)
        })
      )
    const start = Effect.fn("Execution.start")((raw: RunInput) =>
      Effect.gen(function* () {
        const input = yield* decode(RunInput, raw)
        yield* ensureOpen()
        return yield* admission.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* ensureOpen()
              const now = yield* Clock.currentTimeMillis
              const admitted = yield* ledger.atomic(() =>
                Effect.gen(function* () {
                  yield* ensureOpen()
                  const previous = yield* ledger.get(input.id)
                  const counts = yield* ledger.counts()
                  const allowed = yield* writable()
                  yield* ensureOpen()
                  const result = admitExecution(
                    input,
                    previous,
                    counts,
                    allowed,
                    active.size > 0,
                    now,
                    crypto.randomUUID()
                  )
                  if (result._tag === "Success" && result.success.fresh)
                    yield* ledger.put(result.success.run)
                  return result
                })
              )
              const { run, fresh } = yield* Effect.fromResult(admitted)
              const pending = active.get(run.id)
              if (pending)
                return {
                  run: receipt(run),
                  completion: completion(pending, run.id),
                }
              if (!fresh)
                return {
                  run: receipt(run),
                  completion: Effect.succeed(receipt(run)),
                }
              const begin = yield* Deferred.make<void>()
              const perform = Deferred.await(begin).pipe(
                Effect.andThen(
                  executeRun({
                    authorize: Effect.suspend(() =>
                      host.getSnapshot().matches("open")
                        ? writable()
                        : Effect.succeed(false)
                    ),
                    execute: Effect.gen(function* () {
                      // Authorization is a separate actor stage. Recheck at the
                      // consequential dispatch boundary after its mailbox handoff.
                      const allowed = yield* ledger.atomic(() =>
                        Effect.gen(function* () {
                          const current = yield* ledger.get(run.id)
                          if (
                            !current ||
                            current.status !== "running" ||
                            current.attemptId !== run.attemptId ||
                            current.revision !== run.revision ||
                            current.occupancy.state !== "held" ||
                            current.occupancy.ownerId !== run.attemptId
                          )
                            return false
                          const writableNow = yield* writable()
                          return (
                            writableNow && host.getSnapshot().matches("open")
                          )
                        })
                      )
                      if (!allowed) return null
                      return yield* Effect.suspend(() =>
                        executor.run(run.input)
                      ).pipe(
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
                    }),
                    publish: (output) => finish(run, output),
                    cancel: finish(run, "CANCEL"),
                  })
                ),
                Effect.onInterrupt(() =>
                  finish(run, "INTERRUPT").pipe(orDieAll)
                ),
                Effect.onExit((exit) =>
                  update(run.id, {
                    type: "RELEASE",
                    attemptId: run.attemptId,
                    confirmed:
                      Exit.isSuccess(exit) ||
                      (!Cause.hasDies(exit.cause) &&
                        !Cause.hasFails(exit.cause)),
                  }).pipe(Effect.asVoid)
                ),
                Effect.onExit((exit) =>
                  Effect.gen(function* () {
                    if (
                      Exit.isFailure(exit) &&
                      (Cause.hasDies(exit.cause) || Cause.hasFails(exit.cause))
                    ) {
                      yield* send(host, { type: "FAILED", cause: exit.cause })
                      yield* waitFor(
                        host,
                        (state) => state.context.failure === exit.cause
                      ).pipe(Effect.orDie)
                    }
                    active.delete(run.id)
                  })
                )
              )
              const fiber = yield* Effect.forkIn(
                Effect.interruptible(perform),
                workScope
              )
              active.set(run.id, fiber)
              yield* Deferred.succeed(begin, undefined)
              return {
                run: receipt(run),
                completion: completion(fiber, run.id),
              } satisfies ExecutionTask
            })
          )
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
            const saved = yield* finish(found, "CANCEL")
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
      get: Effect.fn("Execution.get")((id: string) =>
        ledger
          .get(id)
          .pipe(Effect.map((run) => (run ? receipt(run) : undefined)))
      ),
      start,
      cancel,
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
        admission.withPermit(
          Effect.gen(function* () {
            yield* ensureOpen()
            if (active.size)
              return yield* new ExecutionFailure({
                message: "Wait for the current run before recovery.",
              })
            const now = yield* Clock.currentTimeMillis
            yield* ledger.atomic(() =>
              Effect.gen(function* () {
                yield* ensureOpen()
                for (const run of yield* ledger.running())
                  yield* ledger.put(
                    advanceExecutionRecord(run, { type: "RECOVER", now })
                  )
              })
            )
          })
        )
      ),
    } satisfies ExecutionOperations
  }).pipe(Effect.uninterruptible)
export const executionApplication = (
  ledger: ExecutionLedger,
  executor: CodeExecutor,
  writable: () => Effect.Effect<boolean, ExecutionStorageError>
) => Layer.effect(Executions, makeExecutions(ledger, executor, writable))
