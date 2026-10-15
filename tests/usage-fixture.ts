import { Effect } from "effect"
import { InferenceUsage, usageApplication } from "../src/inference/usage"
import { SqliteUsage } from "../src/inference/adapters/usage-sqlite"
import { piUsage } from "../src/inference/adapters/usage-pi"
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
    start: piUsage(service, Effect.runSync),
    recent: () => Effect.runSync(service.recent()),
    totals: (turnId: string) => Effect.runSync(service.totals(turnId)),
  }
}
