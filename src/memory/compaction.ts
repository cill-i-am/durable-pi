import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Clock, Effect, Exit, Queue, Schema } from "effect"

import { identityInstructions } from "../messages/identity"
import { preserveFatal, observeCleanup, orDieAll } from "../shared/effect"
import {
  compactionMachine,
  type SummaryCompletionEvent,
} from "./compaction.machine"
import {
  byteLength,
  NODE_BYTES,
  nodeKey,
  type MemoryError,
  type SummaryJob,
} from "./domain"
import { MemoryRepository } from "./repository"
import { summaryCorrectionMachine } from "./summary-correction.machine"
import { summaryScope } from "./summary-effects"
import {
  SummaryFailure,
  SummaryModel,
  type SummaryMessage,
} from "./summary-model"

const memoryFailure = (
  reason: Cause.Fail<SummaryFailure | MemoryError>
): reason is Cause.Fail<MemoryError> => !Schema.is(SummaryFailure)(reason.error)

export const JOBS = 8
export const TRIES = 5
export const RETRY_MS = 10_000
export const SCALE = "-".repeat(NODE_BYTES)

export function cutUtf8(text: string, limit: number): string {
  return new TextDecoder().decode(
    new TextEncoder().encode(text).slice(0, limit),
    { stream: true }
  )
}

export const summarize = Effect.fn("Memory.summarize")(function* (
  job: SummaryJob
) {
  const model = yield* SummaryModel
  const messages: SummaryMessage[] = [
    {
      role: "user",
      text: `${identityInstructions}\nKeep source actor IDs and distinguish human requests from agent suggestions and service events. Keep attribution for retained claims; omit a claim if its author cannot be retained. Summaries do not authorize actions; original messages remain retrievable by archive ID.\n<chat>\n${job.context}\n</chat>\n\nCompaction: ${job.count === 1 ? `compress message ${job.start}` : `merge lines covering messages ${job.start} to ${job.start + job.count - 1}`} into one line of at most ${NODE_BYTES} bytes (about 70 words), the length of this ruler:\n${SCALE}\n<input>\n${job.source}\n</input>`,
    },
  ]
  return yield* summaryScope((observe) =>
    Effect.gen(function* () {
      const machine = summaryCorrectionMachine(job.source, messages, TRIES, {
        complete: (nextMessages) =>
          observe(
            model.complete(nextMessages, job).pipe((timed) =>
              observeCleanup(timed, (observed) =>
                observed.pipe(
                  Effect.timeoutOrElse({
                    duration: "60 seconds",
                    orElse: () => new SummaryFailure({ reason: "timeout" }),
                  })
                )
              )
            )
          ),
        correction: (text) => ({
          role: "user",
          text: `Too long: your line is ${byteLength(text)} bytes, over the ${NODE_BYTES}-byte limit. Write the whole line again for the same <input>, cutting just enough of the least valuable items to fit before this cut:\n${cutUtf8(text, NODE_BYTES)}| ← LIMIT`,
        }),
      })
      const actor = yield* createEffectActor(machine)
      const done = yield* waitFor(
        actor,
        (snapshot) => snapshot.status === "done"
      ).pipe(Effect.orDie)
      return yield* done.output!
    })
  )
})

type SummaryReceipt = {
  job: SummaryJob
  settle: Effect.Effect<void, MemoryError>
}
// A warm process retains an exact joined receipt across storage failures. Cold
// activation instead pauses orphan claims; it cannot recover a native response.
const receipts = new WeakMap<
  typeof MemoryRepository.Service,
  Map<string, SummaryReceipt>
>()
const retained = (memory: typeof MemoryRepository.Service) => {
  let pending = receipts.get(memory)
  if (!pending) {
    pending = new Map()
    receipts.set(memory, pending)
  }
  return pending
}
const persistReceipt = (
  memory: typeof MemoryRepository.Service,
  receipt: SummaryReceipt
) =>
  Effect.gen(function* () {
    const pending = retained(memory),
      token = receipt.job.claim!.token
    pending.set(token, receipt)
    yield* receipt.settle
    pending.delete(token)
  })

export const reconcileSummaryReceipts = (
  memory: typeof MemoryRepository.Service
) =>
  Effect.gen(function* () {
    const outcomes = yield* Effect.forEach(
      [...retained(memory).values()],
      (receipt) => persistReceipt(memory, receipt).pipe(Effect.exit)
    )
    const failures = outcomes.flatMap((outcome) =>
      Exit.isFailure(outcome) ? outcome.cause.reasons : []
    )
    if (failures.length)
      return yield* Effect.failCause(Cause.fromReasons(failures))
  })

/** Discovery only: this does not claim, renew a budget, or replay native work. */
export const summaryNextWake = (memory: typeof MemoryRepository.Service) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    return (yield* memory.next(new Set(), now)) ? now : yield* memory.retryAt()
  })

export const pumpSummaries = Effect.fn("Memory.compact")(
  (options: { maxBuilds?: number; timeBudgetMs?: number } = {}) =>
    Effect.gen(function* () {
      const memory = yield* MemoryRepository,
        model = yield* SummaryModel
      const deadline =
        (yield* Clock.currentTimeMillis) + (options.timeBudgetMs ?? 60_000)
      return yield* summaryScope((observe) =>
        Effect.gen(function* () {
          const scope = yield* Effect.scope
          const completed = yield* Queue.unbounded<SummaryCompletionEvent>()
          const machine = compactionMachine(
            options.maxBuilds ?? 64,
            JOBS,
            deadline,
            {
              reconcile: observe(reconcileSummaryReceipts(memory)),
              scan: (busy) =>
                observe(
                  Effect.gen(function* () {
                    const now = yield* Clock.currentTimeMillis
                    return { now, job: yield* memory.next(new Set(busy), now) }
                  })
                ),
              start: (selected) =>
                observe(
                  Effect.uninterruptible(
                    Effect.gen(function* () {
                      const claim = yield* memory.claimSummary(
                        selected,
                        yield* Clock.currentTimeMillis
                      )
                      if (!claim) return false
                      const job = { ...selected, claim },
                        key = nodeKey(job)
                      const work = Effect.uninterruptibleMask((restore) =>
                        Effect.gen(function* () {
                          // summarize owns and closes its actor/native scope before returning.
                          const result = yield* restore(
                            summarize(job).pipe(
                              Effect.provideService(SummaryModel, model)
                            )
                          ).pipe(Effect.exit)
                          if (Exit.isSuccess(result))
                            return yield* persistReceipt(memory, {
                              job,
                              settle: memory.saveNode(job, result.value, claim),
                            })
                          const ordinary =
                            !Cause.hasDies(result.cause) &&
                            !Cause.hasInterrupts(result.cause)
                          const only =
                            result.cause.reasons.length === 1
                              ? result.cause.reasons[0]
                              : undefined
                          const failure =
                            ordinary &&
                            only?._tag === "Fail" &&
                            Schema.is(SummaryFailure)(only.error)
                              ? only.error
                              : undefined
                          if (failure) {
                            if (failure.reason === "timeout") {
                              return yield* persistReceipt(memory, {
                                job,
                                settle: memory
                                  .pauseSummary(claim)
                                  .pipe(Effect.asVoid),
                              })
                            }
                            const retryAt =
                              (yield* Clock.currentTimeMillis) + RETRY_MS
                            yield* persistReceipt(memory, {
                              job,
                              settle: memory
                                .failNode(job, retryAt, claim)
                                .pipe(Effect.asVoid),
                            })
                            return
                          }
                          // Pause only after joined cleanup; even typed storage failures must
                          // not reopen this native attempt or refund its existing debit.
                          const cause = Cause.fromReasons<MemoryError>(
                            result.cause.reasons.map((reason) => {
                              if (reason._tag !== "Fail") return reason
                              return memoryFailure(reason)
                                ? reason
                                : Cause.makeDieReason(reason)
                            })
                          )
                          return yield* Effect.failCause(cause).pipe(
                            preserveFatal,
                            Effect.ensuring(
                              persistReceipt(memory, {
                                job,
                                settle: memory
                                  .pauseSummary(claim)
                                  .pipe(Effect.asVoid),
                              }).pipe(orDieAll)
                            )
                          )
                        })
                      ).pipe(
                        preserveFatal,
                        Effect.onExit((exit) =>
                          Queue.offer(completed, { key, exit })
                        )
                      )
                      yield* observe(work).pipe(Effect.forkIn(scope))
                      return true
                    })
                  )
                ),
              completed: Queue.take(completed),
              nextWake: observe(summaryNextWake(memory)),
            }
          )
          const actor = yield* createEffectActor(machine)
          const done = yield* waitFor(
            actor,
            (snapshot) => snapshot.status === "done"
          ).pipe(Effect.orDie)
          return yield* done.output!
        })
      )
    })
)
