import { expect, it } from "@effect/vitest"
import { Clock, Context, Effect } from "effect"

import { AppStore } from "../src/apps/adapters/sqlite"
import { appEventPump } from "../src/apps/pump"
import type { AppAdmission } from "../src/apps/repository"
import { makeApps } from "../src/apps/service"
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
    admit: (event, discoveryDeadline) =>
      conversations
        .admit(
          { operationId: event.turnId, text: event.text },
          undefined,
          [],
          undefined,
          { discoveryDeadline }
        )
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
        prearm: () => Effect.sync(() => Date.now() + 60_000),
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
        prearm: () => Effect.sync(() => Date.now() + 60_000),
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
  { prearm: () => Effect.Effect<number>; wake: () => Effect.Effect<void> }
>()("test/apps/WakePermit") {}
it.effect(
  "preserves caller requirements, prearms before admission and wakes after its commit",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      const event = Effect.runSync(f.store.pending())[0]!
      const order: string[] = []
      const pump = appEventPump(f.apps, {
        active: () => Effect.succeed(true),
        modelConnected: () => Effect.succeed(true),
        admission: f.admission,
        prearm: () => WakePermit.use((permit) => permit.prearm()),
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
          prearm: () =>
            Effect.sync(() => {
              expect(Effect.runSync(f.conversations.recent())).toHaveLength(0)
              expect(Effect.runSync(f.store.pending())).toHaveLength(1)
              order.push("prearm")
              return Date.now() + 60_000
            }),
          wake: () =>
            Effect.sync(() => {
              expect(Effect.runSync(f.conversations.recent())).toHaveLength(1)
              expect(Effect.runSync(f.store.pending())).toHaveLength(0)
              order.push("wake")
            }),
        })
      )
      expect(order).toEqual(["prearm", "wake", "notify"])
    })
)
it.effect(
  "retains the event when the conversation queue is full and retries without a second admission",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      for (let index = 0; index < 10; index++)
        yield* f.conversations.admit(
          {
            operationId: crypto.randomUUID(),
            text: `Queued ${index}`,
          },
          undefined,
          [],
          undefined,
          { discoveryDeadline: Date.now() + 60_000 }
        )
      let notifications = 0
      const pump = appEventPump(f.apps, {
        active: () => Effect.succeed(true),
        modelConnected: () => Effect.succeed(true),
        admission: f.admission,
        prearm: () => Effect.sync(() => Date.now() + 60_000),
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

it.effect(
  "does not consume the event when retained discovery cannot be armed",
  () =>
    Effect.gen(function* () {
      const f = fixture(),
        failure = new Error("Discovery unavailable")
      const pump = appEventPump(f.apps, {
        active: () => Effect.succeed(true),
        modelConnected: () => Effect.succeed(true),
        prearm: () => Effect.fail(failure),
        admission: f.admission,
        wakeConversation: () => Effect.die("No committed admission"),
        notify: () => Effect.die("No committed admission"),
      })
      expect(yield* pump.run().pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure,
      })
      expect(yield* f.store.pending()).toHaveLength(1)
      expect(yield* f.conversations.recent()).toHaveLength(0)
    })
)
it.effect(
  "rolls back both owners when the supplied discovery lease has expired",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      const pump = appEventPump(f.apps, {
        active: () => Effect.succeed(true),
        modelConnected: () => Effect.succeed(true),
        prearm: () => Clock.currentTimeMillis,
        admission: f.admission,
        wakeConversation: () => Effect.die("No committed admission"),
        notify: () => Effect.die("No committed admission"),
      })
      expect(yield* pump.run().pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "ConversationStorageError",
          operation: "admission discovery",
        },
      })
      expect(yield* f.store.pending()).toHaveLength(1)
      expect(yield* f.conversations.recent()).toHaveLength(0)
    })
)
it.effect(
  "preserves one committed admission after the immediate wake fails",
  () =>
    Effect.gen(function* () {
      const f = fixture(),
        failure = new Error("Immediate wake unavailable")
      let admissions = 0,
        wakes = 0
      const pump = appEventPump(f.apps, {
        active: () => Effect.succeed(true),
        modelConnected: () => Effect.succeed(true),
        prearm: () => Effect.sync(() => Date.now() + 60_000),
        admission: {
          transactionGroup: f.db,
          admit: (event, discoveryDeadline) => {
            admissions++
            return f.admission.admit(event, discoveryDeadline)
          },
        },
        wakeConversation: () =>
          Effect.suspend(() => {
            wakes++
            return Effect.fail(failure)
          }),
        notify: () => Effect.die("The wake failure must propagate"),
      })
      expect(yield* pump.run().pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure,
      })
      expect(yield* f.store.pending()).toHaveLength(0)
      expect(yield* f.conversations.recent()).toHaveLength(1)
      yield* pump.run()
      expect(admissions).toBe(1)
      expect(wakes).toBe(1)
    })
)
it.effect(
  "does not wake when another transaction already consumed the pending event",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      const pump = appEventPump(f.apps, {
        active: () => Effect.succeed(true),
        modelConnected: () => Effect.succeed(true),
        prearm: () =>
          Effect.gen(function* () {
            const discoveryDeadline = Date.now() + 60_000
            yield* f.apps.deliverNext(f.admission, discoveryDeadline)
            return discoveryDeadline
          }),
        admission: f.admission,
        wakeConversation: () =>
          Effect.die("This invocation did not commit an admission"),
        notify: () => Effect.void,
      })
      yield* pump.run()
      expect(yield* f.conversations.recent()).toHaveLength(1)
    })
)
