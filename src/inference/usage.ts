import { Clock, Context, Effect, Layer } from "effect"
import type { ResolvedRoute } from "./policy"
import { finishAttempt, recordUsage, restartError } from "./usage-domain"
import type {
  AccountUsage,
  Attempt,
  TerminalOutcome,
  UsageReport,
  UsageTotals,
  UsageStorageError,
} from "./usage-domain"
import type { UsageLedger } from "./usage-ledger"

export interface InferenceObservation {
  readonly id: string
  readonly turnId: string | null
  usage: (report: UsageReport) => Effect.Effect<void, UsageStorageError>
  end: (
    outcome: TerminalOutcome,
    error?: string | null
  ) => Effect.Effect<Attempt | undefined, UsageStorageError>
}
export class InferenceUsage extends Context.Service<
  InferenceUsage,
  {
    start: (
      route: ResolvedRoute,
      turnId: string | null,
      purpose: string
    ) => Effect.Effect<InferenceObservation, UsageStorageError>
    recover: () => Effect.Effect<number, UsageStorageError>
    recent: () => Effect.Effect<readonly Attempt[], UsageStorageError>
    totals: (turnId: string) => Effect.Effect<UsageTotals, UsageStorageError>
    accountTotals: () => Effect.Effect<AccountUsage, UsageStorageError>
  }
>()("durable-pi/InferenceUsage") {}

export function usageApplication(ledger: UsageLedger, uuid: () => string) {
  const service = InferenceUsage.of({
    start: Effect.fn("InferenceUsage.start")(
      function* (route, turnId, purpose) {
        const now = yield* Clock.currentTimeMillis
        const id = uuid()
        yield* ledger.insert({
          id,
          route,
          turnId,
          purpose,
          startedAt: new Date(now).toISOString(),
          finishedAt: null,
          outcome: "running",
          error: null,
          reportedModel: null,
          input: null,
          cached: null,
          output: null,
        })
        return {
          id,
          turnId,
          usage: Effect.fn("InferenceUsage.report")(function* (report) {
            const at = new Date(yield* Clock.currentTimeMillis).toISOString()
            yield* ledger.atomic(() =>
              Effect.gen(function* () {
                const current = yield* ledger.read(id)
                if (yield* ledger.report(report, at))
                  yield* ledger.put(recordUsage(current, report))
              })
            )
          }),
          end: Effect.fn("InferenceUsage.finish")(function* (
            outcome,
            error = null
          ) {
            const at = new Date(yield* Clock.currentTimeMillis).toISOString()
            return yield* ledger.atomic(() =>
              Effect.gen(function* () {
                const current = yield* ledger.read(id)
                const finished = finishAttempt(current, outcome, error, at)
                if (finished) yield* ledger.put(finished)
                return finished
              })
            )
          }),
        } satisfies InferenceObservation
      }
    ),
    recover: Effect.fn("InferenceUsage.recover")(function* () {
      const at = new Date(yield* Clock.currentTimeMillis).toISOString()
      return yield* ledger.atomic(() =>
        Effect.gen(function* () {
          const running = yield* ledger.running()
          for (const attempt of running) {
            const finished = finishAttempt(
              attempt,
              "interrupted",
              restartError,
              at
            )
            if (finished) yield* ledger.put(finished)
          }
          return running.length
        })
      )
    }),
    recent: () => ledger.recent(),
    totals: (turnId) => ledger.totals(turnId),
    accountTotals: () => ledger.accountTotals(),
  })
  return Layer.effect(
    InferenceUsage,
    service.recover().pipe(Effect.as(service))
  )
}
