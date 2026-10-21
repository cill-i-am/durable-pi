import { Effect } from "effect"

import { chatTurns } from "../../src/conversations/adapters/schema"
import { sqliteConversationMaterialization } from "../../src/conversations/adapters/sqlite-journal"
import { migrateSqlite } from "../../src/storage/migrations"
import type { Sqlite } from "../../src/storage/sqlite"
import { workspaceFiles } from "../../src/workspace/adapters/schema"
import { SqliteWorkspace } from "../../src/workspace/adapters/sqlite"

export const conversationActivitiesProbe = Effect.fn(
  "Test.conversationActivities"
)(function* (db: Sqlite) {
  yield* migrateSqlite(db)
  let transactions = 0
  const storage = sqliteConversationMaterialization({
    ...db,
    transaction: (body) => {
      transactions++
      return db.transaction(body)
    },
  })
  const ids = Array.from({ length: 100 }, (_, index) => `turn-${index}`)
  ids[99] = "turn-'quoted'"
  for (const id of [...ids, "outside"])
    yield* db.use((orm) =>
      orm
        .insert(chatTurns)
        .values({ id, text: id, status: "done", created_at: "2026-10-21" })
    )
  for (const id of ids)
    yield* storage.saveActivity(id, [{ id, type: "text", text: id }])
  yield* storage.saveActivity("outside", [])
  const before = transactions
  const single = yield* Effect.forEach(ids, (id) =>
    storage.atomic(() => storage.readActivity(id))
  )
  const singleTransactions = transactions - before
  const counts = []
  for (const size of [48, 49, 100])
    counts.push((yield* storage.readActivities(ids.slice(0, size))).size)
  const beforeBulk = transactions
  const bulk = yield* storage.atomic(() => storage.readActivities(ids))
  const bulkTransactions = transactions - beforeBulk
  const files = new SqliteWorkspace(db)
  const fileId = crypto.randomUUID()
  yield* db.use((orm) =>
    orm.insert(workspaceFiles).values({
      id: fileId,
      name: "native.jpg",
      mime: "image/jpeg",
      kind: "image",
      size: 1,
      createdAt: "2026-10-21",
      status: "ready",
      hash: "native",
    })
  )
  for (const id of [...ids, "outside"])
    yield* files.replyFile({ operationId: `reply:${id}`, turnId: id, fileId })
  const replyCounts = []
  for (const size of [48, 49, 100])
    replyCounts.push(
      (yield* files.replyFilesForTurns(ids.slice(0, size))).length
    )
  const replies = yield* files.replyFilesForTurns(ids)
  const singleReplies = yield* Effect.forEach(ids, (id) => files.replyFiles(id))
  let during = false
  const rollback = yield* storage
    .atomic(() =>
      Effect.gen(function* () {
        yield* storage.saveActivity(ids[0]!, [])
        during = (yield* storage.readActivities(ids)).get(ids[0]!)?.length === 0
        return yield* Effect.fail("rollback")
      })
    )
    .pipe(Effect.exit)
  return {
    counts,
    parity: ids.every(
      (id, index) =>
        JSON.stringify(bulk.get(id)) === JSON.stringify(single[index])
    ),
    singleTransactions,
    bulkTransactions,
    replyCounts,
    replyParity: ids.every(
      (id, index) =>
        JSON.stringify(replies.filter((reply) => reply.turnId === id)) ===
        JSON.stringify(singleReplies[index])
    ),
    replyVisibleOnly: replies.every((reply) => ids.includes(reply.turnId)),
    visibleOnly: !bulk.has("outside"),
    during,
    rollback: rollback._tag,
    afterRollback: (yield* storage.readActivities(ids)).get(ids[0]!)?.length,
  }
})
