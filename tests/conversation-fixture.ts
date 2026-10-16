import { Effect } from "effect"
import { MemoryRepository } from "../src/memory/repository"
import { MemoryTransaction } from "../src/memory/ledger"
import { sqliteMemoryLayer } from "../src/memory/adapters/sqlite"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { sqliteConversationMaterialization } from "../src/conversations/adapters/sqlite-journal"
import { makeConversationJournal } from "../src/conversations/journal"
import { makeConversations } from "../src/conversations/service"
import type {
  ConversationExecution,
  ConversationObservation,
} from "../src/conversations/execution"
import type { ConversationPumpHost } from "../src/conversations/pump"
import { database, type TestSqlite } from "./database"

export const conversationFixture = Effect.fn("Test.conversationFixture")(
  function* (db: TestSqlite = database()) {
    // This Layer owns only values over the test's native database, no live handles.
    const { memory, memoryLedger } = yield* Effect.gen(function* () {
      return {
        memory: yield* MemoryRepository,
        memoryLedger: yield* MemoryTransaction,
      }
    }).pipe(Effect.provide(sqliteMemoryLayer(db)))
    const store = new ConversationStore(db, { model: "test", thinking: "off" })
    const conversations = makeConversations(store)
    const materialization = sqliteConversationMaterialization(db)
    const journal = makeConversationJournal(
      store,
      memoryLedger,
      materialization
    )
    const events: string[] = []
    const record = (event: string) =>
      Effect.sync(() => {
        events.push(event)
      })
    const execution: {
      -readonly [
        K in keyof typeof ConversationExecution.Service
      ]: (typeof ConversationExecution.Service)[K]
    } = {
      createSession: () => record("create").pipe(Effect.as("session")),
      configure: () => record("configure"),
      submit: () => record("submit"),
      steer: (_session, member) => record(`steer:${member.id}`),
      abort: () => record("abort"),
      observe: (_root, members) =>
        record("observe").pipe(
          Effect.as({
            settled: true,
            answer: "Answer",
            liveAnswer: "Answer",
            activity: [],
            archivedActivity: [],
            archives: [],
            consumed: [],
            outcomes: members.map((member) => ({
              id: member.id,
              delivery: "answered" as const,
            })),
          } satisfies ConversationObservation)
        ),
    }
    const host: ConversationPumpHost<never> = {
      canRun: () => Effect.succeed(true),
      instructions: () => Effect.succeed("be careful"),
      recovery: () => Effect.succeed(undefined),
      cancelAccess: () => record("access.cancel"),
      awaitingAccess: () => Effect.succeed(false),
      cancelPlan: () => record("plan.cancel"),
      reconcileDelegation: () => record("delegate.reconcile"),
      wakeCompaction: () => record("compaction"),
      wakeBackup: () => record("backup"),
      wakeBackground: () => record("background"),
      notify: () => record("notify"),
      completed: (turn) =>
        Effect.sync(() => {
          if (
            !["done", "failed", "cancelled"].includes(
              Effect.runSync(store.get(turn.id))!.status
            )
          )
            throw new Error("Notification preceded completion commit")
          events.push("completed")
        }),
    }
    return {
      db,
      store,
      conversations,
      memory,
      memoryLedger,
      materialization,
      journal,
      execution,
      host,
      events,
    }
  }
)
