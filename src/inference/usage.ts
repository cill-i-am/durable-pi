import { Schema } from "effect"
import type { Sqlite } from "../storage/sqlite"
import type { CacheUsage } from "../agent/cache"
import { ResolvedRoute } from "./policy"

export const Attempt = Schema.Struct({
  id: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  route: ResolvedRoute,
  purpose: Schema.String,
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  outcome: Schema.Literals([
    "running",
    "completed",
    "failed",
    "incomplete",
    "interrupted",
    "cancelled",
  ]),
  error: Schema.NullOr(Schema.String),
  reportedModel: Schema.NullOr(Schema.String),
  input: Schema.NullOr(Schema.Number),
  cached: Schema.NullOr(Schema.Number),
  output: Schema.NullOr(Schema.Number),
})
export type Attempt = typeof Attempt.Type
export const InferenceActivity = Schema.Struct({
  attempts: Schema.Array(Attempt),
})

/** Bot-local observations of provider requests, never an execution scheduler. */
export class InferenceUsage {
  constructor(private readonly db: Sqlite) {
    db.run(
      "CREATE TABLE IF NOT EXISTS inference_attempts (id TEXT PRIMARY KEY,payload TEXT NOT NULL)"
    )
    // Only constructor recovery can end orphaned observations; it schedules nothing.
    for (const row of db.all<{ id: string; payload: string }>(
      "SELECT id,payload FROM inference_attempts WHERE json_extract(payload,'$.outcome')='running'"
    )) {
      const value = Schema.decodeUnknownSync(Attempt)(JSON.parse(row.payload))
      this.save({
        ...value,
        outcome: "interrupted",
        finishedAt: new Date().toISOString(),
        error:
          "Runtime restarted before a terminal provider event was recorded. Usage may be unreported.",
      })
    }
  }
  private save(value: Attempt) {
    this.db.run(
      "INSERT INTO inference_attempts VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      value.id,
      JSON.stringify(value)
    )
  }
  start(route: ResolvedRoute, turnId: string | null, purpose: string) {
    const value: Attempt = {
      id: crypto.randomUUID(),
      route,
      turnId,
      purpose,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      outcome: "running",
      error: null,
      reportedModel: null,
      input: null,
      cached: null,
      output: null,
    }
    this.save(value)
    return {
      usage: (usage: CacheUsage) => {
        Object.assign(value, {
          reportedModel: usage.model,
          input: usage.input,
          cached: usage.cached,
          output: usage.output,
        })
        this.save(value)
      },
      end: (outcome: Attempt["outcome"], error: string | null = null) => {
        this.save({
          ...value,
          outcome,
          error,
          finishedAt: new Date().toISOString(),
        })
      },
    }
  }
  recent() {
    return this.db
      .all<{ payload: string }>(
        "SELECT payload FROM inference_attempts ORDER BY rowid DESC LIMIT 100"
      )
      .map((row) => Schema.decodeUnknownSync(Attempt)(JSON.parse(row.payload)))
  }
}
