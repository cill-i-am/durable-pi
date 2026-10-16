import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  lte,
  notExists,
  or,
} from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { Effect, Schema } from "effect"
import { toolOperations } from "../../access/adapters/schema"
import { chatTurns } from "../../conversations/adapters/schema"
import { backgroundHandoffs } from "../../delegation/adapters/schema"
import {
  asText,
  caseWhen,
  coalesce,
  concat,
  isoMillis,
  jsonField,
  literal,
  substring,
} from "../../storage/expressions"
import { mapSqliteError, type Sqlite } from "../../storage/sqlite"
import { ActivityStorageError } from "../records"
import {
  ACTIVITY_PAGE_SIZE,
  type ActivityAgent,
  ActivityEntry,
  type ActivityQuery,
} from "../contracts"

const Row = Schema.Struct({
  key: Schema.String,
  at: Schema.String,
  kind: ActivityEntry.fields.kind,
  title: Schema.String,
  status: Schema.String,
  attention: Schema.Literals([0, 1]),
  running: Schema.Literals([0, 1]),
  target: ActivityEntry.fields.target,
  reference: Schema.String,
})

/** One bounded UNION query retains SQLite's exact cursor and key ordering. */
export function activityEntries(
  db: Sqlite,
  agent: ActivityAgent,
  query: ActivityQuery,
  now: number
) {
  const retries = alias(chatTurns, "activity_retries")
  const phase = jsonField<string>(chatTurns.recovery, "$.view.phase")
  return mapSqliteError(
    db.use((orm) => {
      const facts = orm
        .select({
          key: concat(`${agent.id}:turn:`, chatTurns.id).as("key"),
          at: chatTurns.created_at,
          kind: caseWhen<string>(
            isNotNull(chatTurns.parent_id),
            "steer",
            "conversation"
          ).as("kind"),
          title: caseWhen<string>(
            isNotNull(chatTurns.origin),
            "Background findings",
            substring(chatTurns.text, 1, 180)
          ).as("title"),
          status: caseWhen<string>(
            inArray(chatTurns.status, ["stopping", "cancelled"]),
            chatTurns.status,
            caseWhen<string>(
              eq(phase, "blocked"),
              "blocked",
              caseWhen<string>(
                and(
                  inArray(chatTurns.status, ["preparing", "running"]),
                  eq(phase, "recovering")
                )!,
                "recovering",
                chatTurns.status
              )
            )
          ).as("status"),
          attention: caseWhen<number>(
            and(
              eq(chatTurns.status, "failed"),
              notExists(
                orm
                  .select({ value: literal(1) })
                  .from(retries)
                  .where(
                    eq(
                      jsonField<string>(retries.creation, "$.retryOf"),
                      chatTurns.id
                    )
                  )
              )
            )!,
            1,
            0
          ).as("attention"),
          running: caseWhen<number>(
            inArray(chatTurns.status, [
              "queued",
              "preparing",
              "running",
              "stopping",
            ]),
            1,
            0
          ).as("running"),
          target: literal<string>("conversation").as("target"),
          reference: coalesce<string>(chatTurns.parent_id, chatTurns.id).as(
            "reference"
          ),
        })
        .from(chatTurns)
        .unionAll(
          orm
            .select({
              key: concat(`${agent.id}:tool:`, toolOperations.id),
              at: isoMillis(toolOperations.createdAt),
              kind: literal<string>("tool"),
              title: toolOperations.tool,
              status: caseWhen<string>(
                and(
                  inArray(toolOperations.status, ["pending", "approved"]),
                  lte(toolOperations.expiresAt, now)
                )!,
                "expired",
                toolOperations.status
              ),
              attention: caseWhen<number>(
                and(
                  eq(toolOperations.status, "pending"),
                  gt(toolOperations.expiresAt, now)
                )!,
                1,
                0
              ),
              running: caseWhen<number>(
                eq(toolOperations.status, "running"),
                1,
                0
              ),
              target: literal<string>("conversation"),
              reference: toolOperations.turnId,
            })
            .from(toolOperations)
        )
        .unionAll(
          orm
            .select({
              key: concat(
                `${agent.id}:background:`,
                asText(backgroundHandoffs.id)
              ),
              at: isoMillis(
                jsonField<number>(backgroundHandoffs.handoff, "$.createdAt")
              ),
              kind: literal<string>("background"),
              title: substring(
                jsonField<string>(
                  backgroundHandoffs.handoff,
                  "$.input.objective"
                ),
                1,
                180
              ),
              status: backgroundHandoffs.status,
              attention: caseWhen<number>(
                eq(backgroundHandoffs.status, "paused"),
                1,
                0
              ),
              running: caseWhen<number>(
                inArray(backgroundHandoffs.status, [
                  "pending",
                  "running",
                  "ready",
                ]),
                1,
                0
              ),
              target: literal<string>("background"),
              reference: asText(backgroundHandoffs.id),
            })
            .from(backgroundHandoffs)
        )
        .as("activity_facts")
      const filter =
        query.filter === "attention"
          ? eq(facts.attention, 1)
          : query.filter === "running"
            ? eq(facts.running, 1)
            : undefined
      const cursor = query.cursor
        ? or(
            lt(facts.at, query.cursor.at),
            and(eq(facts.at, query.cursor.at), lt(facts.key, query.cursor.key))
          )
        : undefined
      return orm
        .select()
        .from(facts)
        .where(and(filter, cursor))
        .orderBy(desc(facts.at), desc(facts.key))
        .limit(ACTIVITY_PAGE_SIZE + 1)
    }),
    (cause) => new ActivityStorageError({ cause })
  ).pipe(
    Effect.map((rows) =>
      rows.map((raw) => {
        const row = Schema.decodeUnknownSync(Row)(raw)
        return Schema.decodeUnknownSync(ActivityEntry)({
          ...row,
          agent,
          attention: !!row.attention,
          running: !!row.running,
        })
      })
    )
  )
}
