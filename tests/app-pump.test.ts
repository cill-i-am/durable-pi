import { expect, it } from "@effect/vitest"
import { Clock, Context, Effect } from "effect"
import { AppStore } from "../src/apps/adapters/sqlite"
import { makeApps } from "../src/apps/service"
import { appEventPump } from "../src/apps/pump"
import type { AppAdmission } from "../src/apps/repository"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { database } from "./database"

function fixture() {
  const db = database(),
    store = new AppStore(db, () => Effect.sync(() => true))
  const conversations = new ConversationStore(db, {
    model: "test",
    thinking: "off",
  })
  const draft = Effect.runSync(
    store.save({
      operationId: crypto.randomUUID(),
      id: crypto.randomUUID(),
      expectedRevision: 0,
      definition: {
        title: "Checklist",
        description: "Fixture",
        blocks: [
          {
            type: "checklist",
            id: "tasks",
            title: "Tasks",
            items: [{ id: "one", label: "One" }],
          },
        ],
      },
    })
  )
  const published = Effect.runSync(
    store.publish({
      operationId: crypto.randomUUID(),
      id: draft.id,
      version: draft.version,
      expectedRevision: draft.revision,
    })
  )
  Effect.runSync(
    store.interact({
      operationId: crypto.randomUUID(),
      id: draft.id,
      version: published.version,
      expectedRevision: published.revision,
      action: { type: "check", blockId: "tasks", itemId: "one", checked: true },
    })
  )
  const apps = makeApps(store)
  const admission: AppAdmission = {
    transactionGroup: db,
    admit: (event) =>
      conversations
        .admit({ operationId: event.turnId, text: event.text })
        .pipe(Effect.map(({ turn }) => turn.id)),
  }
  return { db, store, conversations, apps, admission }
}
it.effect(
  "retains the event and typed admission failure when conversation persistence fails",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      f.db.run(
        "CREATE TRIGGER reject_turn BEFORE INSERT ON chat_turns BEGIN SELECT RAISE(ABORT,'admission failure'); END"
      )
      const pump = appEventPump(f.apps, {
        active: () => Effect.succeed(true),
        modelConnected: () => Effect.succeed(true),
        admission: f.admission,
        wakeConversation: () => Effect.void,
        notify: () => Effect.die("Failed admission must not notify"),
      })
      expect(yield* pump.run().pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConversationStorageError" },
      })
      expect(Effect.runSync(f.store.pending())).toHaveLength(1)
      expect(Effect.runSync(f.conversations.recent())).toHaveLength(0)
    })
)
it.effect(
  "keeps pending app events intact without a model and uses the application clock for retry",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      let wakes = 0,
        notifications = 0
      const pump = appEventPump(f.apps, {
        active: () => Effect.succeed(true),
        modelConnected: () => Effect.succeed(false),
        admission: f.admission,
        wakeConversation: () =>
          Effect.sync(() => {
            wakes++
          }),
        notify: () =>
          Effect.sync(() => {
            notifications++
          }),
      })
      const now = yield* Clock.currentTimeMillis
      expect(yield* pump.run()).toBe(now + 60_000)
      expect(wakes).toBe(0)
      expect(notifications).toBe(0)
      expect(Effect.runSync(f.store.pending())).toHaveLength(1)
      expect(Effect.runSync(f.conversations.recent())).toHaveLength(0)
    })
)
class WakePermit extends Context.Service<
  WakePermit,
  { wake: () => Effect.Effect<void> }
>()("test/apps/WakePermit") {}
it.effect(
  "preserves caller requirements, wakes before admission and notifies after its commit",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      const event = Effect.runSync(f.store.pending())[0]!
      const order: string[] = []
      const pump = appEventPump(f.apps, {
        active: () => Effect.succeed(true),
        modelConnected: () => Effect.succeed(true),
        admission: f.admission,
        wakeConversation: () => WakePermit.use((permit) => permit.wake()),
        notify: () =>
          Effect.sync(() => {
            expect(Effect.runSync(f.store.pending())).toHaveLength(0)
            expect(
              Effect.runSync(f.conversations.get(event.turnId))?.status
            ).toBe("queued")
            order.push("notify")
          }),
      })
      yield* pump.run().pipe(
        Effect.provideService(WakePermit, {
          wake: () =>
            Effect.sync(() => {
              expect(Effect.runSync(f.conversations.recent())).toHaveLength(0)
              expect(Effect.runSync(f.store.pending())).toHaveLength(1)
              order.push("wake")
            }),
        })
      )
      expect(order).toEqual(["wake", "notify"])
    })
)
it.effect(
  "retains the event when the conversation queue is full and retries without a second admission",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      for (let index = 0; index < 10; index++)
        yield* f.conversations.admit({
          operationId: crypto.randomUUID(),
          text: `Queued ${index}`,
        })
      let notifications = 0
      const pump = appEventPump(f.apps, {
        active: () => Effect.succeed(true),
        modelConnected: () => Effect.succeed(true),
        admission: f.admission,
        wakeConversation: () => Effect.void,
        notify: () =>
          Effect.sync(() => {
            notifications++
          }),
      })
      const now = yield* Clock.currentTimeMillis
      expect(yield* pump.run()).toBe(now + 10_000)
      expect(notifications).toBe(0)
      expect(Effect.runSync(f.store.pending())).toHaveLength(1)
      expect(Effect.runSync(f.conversations.recent())).toHaveLength(10)
    })
)
