import { Effect } from "effect"

import { SqliteUsage } from "../src/inference/adapters/usage-sqlite"
import { InferenceUsage, usageApplication } from "../src/inference/usage"
import type {
  TerminalOutcome,
  InferenceTimings,
  UsageReport,
} from "../src/inference/usage-domain"
import type { Sqlite } from "../src/storage/sqlite"

export function usageFixture(db: Sqlite) {
  const service = Effect.runSync(
    InferenceUsage.pipe(
      Effect.provide(
        usageApplication(new SqliteUsage(db), () => crypto.randomUUID())
      )
    )
  )
  return {
    service,
    // A synchronous test edge keeps storage-law assertions concise. Production
    // uses piUsage's awaited native callbacks, covered by stream lifetime tests.
    start: (...args: Parameters<typeof service.start>) => {
      const observation = Effect.runSync(service.start(...args))
      return {
        id: observation.id,
        turnId: observation.turnId,
        usage: (report: UsageReport) =>
          Effect.runSync(observation.usage(report)),
        end: (
          outcome: TerminalOutcome,
          error?: string | null,
          timings?: InferenceTimings
        ) => {
          Effect.runSync(observation.end(outcome, error, timings))
        },
      }
    },
    recent: () => Effect.runSync(service.recent()),
    totals: (turnId: string) => Effect.runSync(service.totals(turnId)),
  }
}
