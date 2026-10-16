import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  type SQLWrapper,
} from "drizzle-orm"
import { Effect, Schema } from "effect"
import { mapSqliteError, type Sqlite } from "../../storage/sqlite"
import {
  asText,
  caseWhen,
  concat,
  isoMillis,
  jsonField,
  jsonObject,
  jsonValid,
  literal,
} from "../../storage/expressions"
import {
  chatRecoveryHistory,
  chatTurns,
} from "../../conversations/adapters/schema"
import { inferenceAttempts } from "../../inference/adapters/schema"
import {
  toolOperationHistory,
  toolOperations,
} from "../../access/adapters/schema"
import { ActivityStorageError } from "../records"
import { Attempt } from "../../inference/usage-domain"
import { RecoveryView } from "../../conversations/recovery"
import {
  RUN_PAGE_SIZE,
  type RunCursor,
  type RunFact,
  type RunRecords,
} from "../run"

const Header = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  session_id: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  started_at: Schema.NullOr(Schema.String),
  finished_at: Schema.NullOr(Schema.String),
})
const FactRow = Schema.Struct({
  key: Schema.String,
  at: Schema.String,
  kind: Schema.Literals(["run", "steering", "model", "tool", "recovery"]),
  reference: Schema.String,
  payload: Schema.String,
})
const Payload = Schema.Struct({
  title: Schema.String,
  status: Schema.String,
  expiresAt: Schema.optional(Schema.Number),
  isError: Schema.optional(Schema.NullOr(Schema.Number)),
})
const Transition = Schema.Struct({
  operationId: Schema.String,
  status: Schema.String,
  at: Schema.Number,
})

/** Project recorded facts in SQLite, limiting the global union before decoding. */
export function readRunRecords(
  db: Sqlite,
  runId: string,
  cursor: RunCursor | null
): Effect.Effect<RunRecords | null, ActivityStorageError> {
  return mapSqliteError(
    Effect.gen(function* () {
      const rawTurn = yield* db.use((orm) =>
        orm
          .select({
            id: chatTurns.id,
            status: chatTurns.status,
            session_id: chatTurns.session_id,
            created_at: chatTurns.created_at,
            started_at: chatTurns.started_at,
            finished_at: chatTurns.finished_at,
          })
          .from(chatTurns)
          .where(and(eq(chatTurns.id, runId), isNull(chatTurns.parent_id)))
          .get()
      )
      if (!rawTurn) return null
      const turn = Schema.decodeUnknownSync(Header)(rawTurn)
      const rawRows = yield* db.use((orm) => {
        const event = (
          key: string,
          at: SQLWrapper,
          title: string,
          status: string | SQLWrapper
        ) =>
          orm
            .select({
              key: concat(key, chatTurns.id).as("key"),
              at: asText(at).as("at"),
              kind: literal<string>("run").as("kind"),
              reference: asText(chatTurns.id).as("reference"),
              payload: jsonObject({ title, status }).as("payload"),
            })
            .from(chatTurns)
            .where(and(eq(chatTurns.id, runId), isNotNull(at)))
        const runEvents = event(
          "accepted:",
          chatTurns.created_at,
          "Request accepted",
          "accepted"
        )
          .unionAll(
            event(
              "started:",
              chatTurns.started_at,
              "Pi session started",
              "started"
            )
          )
          .unionAll(
            event(
              "stopped:",
              chatTurns.stopped_at,
              "Stop requested",
              "stopping"
            )
          )
          .unionAll(
            event(
              "finished:",
              chatTurns.finished_at,
              "Run ended",
              chatTurns.status
            )
          )
          .as("run_events")
        const executionEvents = orm
          .select({
            key: concat("steer:", chatTurns.id).as("key"),
            at: asText(chatTurns.created_at).as("at"),
            kind: literal<string>("steering").as("kind"),
            reference: asText(chatTurns.id).as("reference"),
            payload: jsonObject({
              title: "Steering accepted",
              status: chatTurns.delivery,
            }).as("payload"),
          })
          .from(chatTurns)
          .where(eq(chatTurns.parent_id, runId))
          .unionAll(
            orm
              .select({
                key: concat("model:", inferenceAttempts.id),
                at: jsonField<string>(inferenceAttempts.payload, "$.startedAt"),
                kind: literal<string>("model"),
                reference: asText(inferenceAttempts.id),
                payload: inferenceAttempts.payload,
              })
              .from(inferenceAttempts)
              .where(
                eq(
                  jsonField<string>(inferenceAttempts.payload, "$.turnId"),
                  runId
                )
              )
          )
          .unionAll(
            orm
              .select({
                key: concat("tool:", toolOperations.id),
                at: isoMillis(toolOperations.createdAt),
                kind: literal<string>("tool"),
                reference: asText(toolOperations.id),
                payload: jsonObject({
                  title: toolOperations.tool,
                  status: toolOperations.status,
                  expiresAt: toolOperations.expiresAt,
                  isError: caseWhen<number | null>(
                    jsonValid(toolOperations.result),
                    jsonField<number | null>(
                      toolOperations.result,
                      "$.isError"
                    ),
                    null
                  ),
                }),
              })
              .from(toolOperations)
              .where(eq(toolOperations.turnId, runId))
          )
          .unionAll(
            orm
              .select({
                key: concat("recovery:", asText(chatRecoveryHistory.id)),
                at: chatRecoveryHistory.at,
                kind: literal<string>("recovery"),
                reference: asText(chatRecoveryHistory.id),
                payload: chatRecoveryHistory.view,
              })
              .from(chatRecoveryHistory)
              .where(eq(chatRecoveryHistory.turn_id, runId))
          )
          .as("execution_events")
        // Cloudflare caps each compound SELECT below this eight-event union.
        // Group bounded branches, then apply one global cursor/order/limit.
        const facts = orm
          .select()
          .from(runEvents)
          .unionAll(orm.select().from(executionEvents))
          .as("run_facts")
        const before = cursor
          ? or(
              lt(facts.at, cursor.at),
              and(eq(facts.at, cursor.at), lt(facts.key, cursor.key))
            )
          : undefined
        return orm
          .select()
          .from(facts)
          .where(before)
          .orderBy(desc(facts.at), desc(facts.key))
          .limit(RUN_PAGE_SIZE + 1)
      })
      const rows = rawRows.map((raw) => Schema.decodeUnknownSync(FactRow)(raw))
      const tools = rows
        .filter((row) => row.kind === "tool")
        .map((row) => row.reference)
      const transitions = new Map<string, { status: string; at: number }[]>()
      if (tools.length) {
        const history = yield* db.use((orm) =>
          orm
            .select({
              operationId: toolOperationHistory.operationId,
              status: toolOperationHistory.status,
              at: toolOperationHistory.at,
            })
            .from(toolOperationHistory)
            .where(inArray(toolOperationHistory.operationId, tools))
            .orderBy(asc(toolOperationHistory.id))
        )
        for (const raw of history) {
          const { operationId, ...transition } =
            Schema.decodeUnknownSync(Transition)(raw)
          const list = transitions.get(operationId) ?? []
          list.push(transition)
          transitions.set(operationId, list)
        }
      }
      return {
        turn,
        rows: rows.map((row): RunFact => {
          const base = { key: row.key, at: row.at, reference: row.reference }
          if (row.kind === "model")
            return {
              ...base,
              kind: "model",
              attempt: Schema.decodeUnknownSync(Schema.fromJsonString(Attempt))(
                row.payload
              ),
            }
          if (row.kind === "recovery")
            return {
              ...base,
              kind: "recovery",
              view: Schema.decodeUnknownSync(
                Schema.fromJsonString(RecoveryView)
              )(row.payload),
            }
          const payload = Schema.decodeUnknownSync(
            Schema.fromJsonString(Payload)
          )(row.payload)
          return {
            ...base,
            kind: row.kind,
            ...payload,
            ...(row.kind === "tool"
              ? { transitions: transitions.get(row.reference) ?? [] }
              : {}),
          }
        }),
      }
    }),
    (cause) => new ActivityStorageError({ cause })
  )
}
