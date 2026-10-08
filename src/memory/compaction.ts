import type { Exit } from "effect"
import { Clock, Effect, Queue } from "effect"
import {
  byteLength,
  NODE_BYTES,
  nodeKey,
  type MemoryError,
  type SummaryJob,
} from "./domain"
import { MemoryRepository } from "./repository"
import {
  SummaryFailure,
  SummaryModel,
  type SummaryMessage,
} from "./summary-model"

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
  if (byteLength(job.source) <= NODE_BYTES) return job.source
  const model = yield* SummaryModel
  const messages: SummaryMessage[] = [
    {
      role: "user",
      text: `<chat>\n${job.context}\n</chat>\n\nCompaction: ${job.count === 1 ? `compress message ${job.start}` : `merge lines covering messages ${job.start} to ${job.start + job.count - 1}`} into one line of at most ${NODE_BYTES} bytes (about 70 words), the length of this ruler:\n${SCALE}\n<input>\n${job.source}\n</input>`,
    },
  ]
  let best: string | undefined
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const text = (yield* model.complete(messages).pipe(
      Effect.timeoutOrElse({
        duration: "60 seconds",
        orElse: () => new SummaryFailure({ reason: "timeout" }),
      })
    )).trim()
    if (!text) return yield* new SummaryFailure({ reason: "empty" })
    if (best === undefined || byteLength(text) < byteLength(best)) best = text
    if (byteLength(text) <= NODE_BYTES) break
    messages.push(
      { role: "assistant", text },
      {
        role: "user",
        text: `Too long: your line is ${byteLength(text)} bytes, over the ${NODE_BYTES}-byte limit. Write the whole line again for the same <input>, cutting just enough of the least valuable items to fit before this cut:\n${cutUtf8(text, NODE_BYTES)}| ← LIMIT`,
      }
    )
  }
  return best!
})

/**
 * One scoped job owns the dynamic work set. A completion queue refills slots
 * without Promise.race (which cannot cancel siblings or propagate defects).
 * Cooldowns are persisted; Lifecycle, not an in-memory sleep, owns the wake.
 */
export const pumpSummaries = Effect.fn("Memory.compact")(function* (
  options: {
    maxBuilds?: number
    timeBudgetMs?: number
  } = {}
) {
  const memory = yield* MemoryRepository
  const maxBuilds = options.maxBuilds ?? 64
  const deadline =
    (yield* Clock.currentTimeMillis) + (options.timeBudgetMs ?? 60_000)
  const completed = yield* Queue.unbounded<{
    key: string
    exit: Exit.Exit<void, MemoryError>
  }>()
  const busy = new Set<string>()
  let started = 0
  for (;;) {
    while (busy.size < JOBS && started < maxBuilds) {
      const now = yield* Clock.currentTimeMillis
      if (now >= deadline) break
      const job = yield* memory.next(busy, now)
      if (!job) break
      const key = nodeKey(job)
      busy.add(key)
      started++
      yield* summarize(job).pipe(
        // Only provider failures become retryable nodes. A storage failure,
        // defect or interruption must never be mistaken for model downtime.
        Effect.matchEffect({
          onSuccess: (text) => memory.saveNode(job, text),
          onFailure: (error) =>
            Effect.gen(function* () {
              const retryAt = (yield* Clock.currentTimeMillis) + RETRY_MS
              if (yield* memory.failNode(job, retryAt))
                yield* Effect.logWarning("Memory summary deferred").pipe(
                  Effect.annotateLogs({
                    range: key,
                    reason: error.reason,
                    retryAt,
                  })
                )
            }),
        }),
        Effect.onExit((exit) => Queue.offer(completed, { key, exit })),
        Effect.forkScoped
      )
    }
    if (!busy.size) break
    const result = yield* Queue.take(completed)
    busy.delete(result.key)
    yield* result.exit
  }
  const now = yield* Clock.currentTimeMillis
  return (yield* memory.next(new Set(), now)) ? now : yield* memory.retryAt()
}, Effect.scoped)
