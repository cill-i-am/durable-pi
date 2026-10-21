import { expect, it } from "@effect/vitest"
import { Cause, Context, Effect, Exit } from "effect"
import { vi } from "vitest"

import {
  conversationSnapshot,
  type SnapshotMetadata,
} from "../src/conversations/snapshot"
import { runtimeStatusEffect } from "../src/conversations/status"
import { conversationFixture } from "./conversation-fixture"
import { corrupt } from "./database"

const metadata: SnapshotMetadata = {
  connected: true,
  memory: { messages: 0, summaries: 0, ready: true, notes: [] },
}
it.effect("reads membership once for the whole visible history", () =>
  Effect.gen(function* () {
    const f = yield* conversationFixture()
    for (let i = 0; i < 50; i++)
      f.db.run(
        "INSERT INTO chat_turns(id,text,status,created_at) VALUES (?,?,'done','2026-10-21')",
        `history-${i}`,
        `message ${i}`
      )
    const root = yield* f.store.admit({
      operationId: "latest",
      text: "new request",
    })
    yield* f.store.admit({
      operationId: "steer",
      text: "new detail",
      mode: "steer",
    })
    const bulk = vi.spyOn(f.store, "visibleMembers")
    const single = vi.spyOn(f.store, "members")
    const snapshot = yield* conversationSnapshot(
      f.conversations,
      f.execution,
      f.journal,
      () => Effect.succeed(metadata)
    )()
    expect(snapshot.turns).toHaveLength(51)
    expect(snapshot.turns.at(-1)).toMatchObject({
      id: root.turn.id,
      steering: [{ id: "steer", text: "new detail" }],
    })
    expect(bulk).toHaveBeenCalledOnce()
    expect(bulk.mock.calls[0]?.[0]).toHaveLength(51)
    expect(single).not.toHaveBeenCalled()
  })
)
it.effect(
  "uses live observations while running and saved activity after completion without changing durable answers",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      Effect.runSync(f.store.admit({ operationId: "root", text: "hello" }))
      Effect.runSync(f.store.submitted("root", "session"))
      Effect.runSync(
        f.store.admit({ operationId: "steer", text: "use blue", mode: "steer" })
      )
      const observe = f.execution.observe
      f.execution.observe = (root, members) =>
        observe(root, members).pipe(
          Effect.map((observation) => ({
            ...observation,
            liveAnswer: "Live answer",
            activity: [
              { id: "live", type: "text" as const, text: "Live answer" },
            ],
          }))
        )
      const snapshot = conversationSnapshot(
        f.conversations,
        f.execution,
        f.journal,
        () => Effect.succeed(metadata)
      )
      const live = yield* snapshot()
      expect(live.turns[0]?.answer).toBe("Live answer")
      expect(live.turns[0]?.activity).toEqual([
        { id: "live", type: "text", text: "Live answer" },
      ])
      expect(live.turns[0]?.steering[0]?.id).toBe("steer")
      expect(Effect.runSync(f.store.get("root"))?.answer).toBe("")
      f.db.run(
        "INSERT INTO chat_activity VALUES ('root',?)",
        JSON.stringify([{ id: "saved", type: "text", text: "Saved answer" }])
      )
      expect(
        Effect.runSync(
          f.store.finish(
            Effect.runSync(f.store.get("root"))!,
            [
              { id: "root", delivery: "answered" },
              { id: "steer", delivery: "answered" },
            ],
            "Saved answer",
            null
          )
        )
      ).toBe(true)
      const saved = yield* snapshot()
      expect(saved.turns[0]?.answer).toBe("Saved answer")
      expect(saved.turns[0]?.activity).toEqual([
        { id: "saved", type: "text", text: "Saved answer" },
      ])
    })
)
class Caller extends Context.Service<Caller, { connected: boolean }>()(
  "Test/SnapshotCaller"
) {}
it.effect(
  "preserves metadata caller requirements and typed failure, while activity corruption remains a defect",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      Effect.runSync(f.store.admit({ operationId: "root", text: "hello" }))
      const snapshot = conversationSnapshot(
        f.conversations,
        f.execution,
        f.journal,
        () =>
          Caller.pipe(
            Effect.flatMap(({ connected }) =>
              connected
                ? Effect.succeed(metadata)
                : Effect.fail("metadata unavailable")
            )
          )
      )
      expect(
        yield* snapshot().pipe(
          Effect.provideService(Caller, { connected: false }),
          Effect.result
        )
      ).toMatchObject({ _tag: "Failure", failure: "metadata unavailable" })
      corrupt(f.db, "INSERT INTO chat_activity VALUES ('root','not JSON')")
      const exit = yield* snapshot().pipe(
        Effect.provideService(Caller, { connected: true }),
        Effect.exit
      )
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
    })
)
it.effect(
  "rejects stale plan blocking after an asynchronous status read while preserving unavailable current facts",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      const root = Effect.runSync(
        f.store.admit({ operationId: "root", text: "hello" })
      ).turn
      Effect.runSync(
        f.store.finish(
          root,
          [{ id: root.id, delivery: "answered" }],
          "done",
          null
        )
      )
      let admit = true
      const status = runtimeStatusEffect(f.conversations, {
        archived: () => Effect.succeed(false),
        awaitingApproval: () => Effect.succeed(false),
        planBlocked: () =>
          Effect.sync(() => {
            if (admit)
              Effect.runSync(
                f.store.admit({ operationId: "next", text: "next" })
              )
            return undefined
          }),
      })
      expect(yield* status()).toEqual({ state: "working", turnId: "next" })
      Effect.runSync(
        f.store.finish(
          Effect.runSync(f.store.get("next"))!,
          [{ id: "next", delivery: "answered" }],
          "done",
          null
        )
      )
      admit = false
      expect(yield* status()).toEqual({ state: "unavailable", turnId: "next" })
    })
)
