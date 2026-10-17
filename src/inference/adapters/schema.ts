import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core"

export const modelCredentials = sqliteTable(
  "model_credentials",
  {
    provider: text("provider").notNull(),
    value: text("value").notNull(),
    seed: text("seed").notNull(),
    source: text("source", { enum: ["deployment", "account"] })
      .notNull()
      .default("deployment"),
  },
  (t) => [primaryKey({ columns: [t.provider] })]
)

export const modelCredentialRefresh = sqliteTable(
  "model_credential_refresh",
  {
    provider: text("provider").notNull(),
  },
  (t) => [primaryKey({ columns: [t.provider] })]
)

export const inferenceAttempts = sqliteTable(
  "inference_attempts",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    payload: text("payload").notNull(),
  },
  (t) => [
    unique().on(t.id),
    index("inference_attempts_run").on(
      sql`json_extract(${t.payload}, '$.turnId')`
    ),
    check("inference_attempts_payload_json", sql`json_valid(${t.payload})`),
  ]
)

export const modelUsage = sqliteTable(
  "model_usage",
  {
    id: text("id").notNull(),
    model: text("model").notNull(),
    input: integer("input").notNull(),
    cached: integer("cached").notNull(),
    output: integer("output").notNull(),
    date: text("date").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    check("model_usage_input_check", sql`${t.input} >= 0`),
    check("model_usage_cached_check", sql`${t.cached} >= 0`),
    check("model_usage_output_check", sql`${t.output} >= 0`),
  ]
)
