import { expect, it } from "@effect/vitest"
import { Cause, Context, Effect, Exit } from "effect"
import { vi } from "vitest"

import {
  conversationSnapshot,
  type SnapshotMetadata,
} from "../src/conversations/snapshot"
import { runtimeStatusEffect } from "../src/conversations/status"
import type { FileInfo } from "../src/workspace/files"
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
    const activities = vi.spyOn(f.journal, "activities")
    const activity = vi.spyOn(f.journal, "activity")
    const files = vi.fn((_ids: readonly string[]) =>
      Effect.succeed(new Map<string, FileInfo[]>())
    )
    const snapshot = yield* conversationSnapshot(
      f.conversations,
      f.execution,
      f.journal,
      () => Effect.succeed(metadata),
      files
    )()
    expect(snapshot.turns).toHaveLength(51)
    expect(snapshot.turns.at(-1)).toMatchObject({
      id: root.turn.id,
      steering: [{ id: "steer", text: "new detail" }],
    })
    expect(bulk).toHaveBeenCalledOnce()
    expect(bulk.mock.calls[0]?.[0]).toHaveLength(51)
    expect(single).not.toHaveBeenCalled()
    expect(activities).toHaveBeenCalledOnce()
    expect(activities.mock.calls[0]?.[0]).toHaveLength(51)
    expect(activity).not.toHaveBeenCalled()
    expect(files).toHaveBeenCalledOnce()
    expect(files.mock.calls[0]?.[0]).toHaveLength(51)
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
      const activities = vi.spyOn(f.journal, "activities")
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
      expect(activities.mock.calls[0]?.[0]).toEqual([])
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
      expect(activities.mock.calls[1]?.[0]).toEqual(["root"])
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

it.effect(
  "keeps uncertain roots readable from saved facts without observing unavailable native work",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      const id = "uncertain"
      yield* f.store.admit({
        operationId: id,
        text: "keep the original message",
      })
      const saved = [{ id: "saved", type: "text", text: "Saved answer" }]
      f.db.run(
        "INSERT INTO chat_activity VALUES (?,?)",
        id,
        JSON.stringify(saved)
      )
      const observe = vi.fn(() =>
        Effect.die(new Error("native observation must not run"))
      )
      const snapshot = conversationSnapshot(
        f.conversations,
        { observe },
        f.journal,
        () => Effect.succeed(metadata)
      )
      for (const unconfirmed of ["handoff", "observe", "stop"] as const) {
        f.db.run(
          "UPDATE chat_turns SET status=?,session_id='original-native-session',answer='Saved answer',revision=7,control=? WHERE id=?",
          unconfirmed === "stop" ? "stopping" : "running",
          JSON.stringify({
            owner: "private-cleanup-owner",
            deadline: 123456,
            unconfirmed,
          }),
          id
        )
        const state = yield* snapshot()
        expect(state.turns[0]).toMatchObject({
          id,
          revision: 7,
          controlUnconfirmed: unconfirmed,
          controlBusy: true,
          answer: "Saved answer",
          activity: saved,
        })
        expect(JSON.stringify(state)).not.toContain("private-cleanup-owner")
        expect(JSON.stringify(state)).not.toContain("123456")
      }
      expect(observe).not.toHaveBeenCalled()
      f.db.run(
        "UPDATE chat_turns SET control=? WHERE id=?",
        JSON.stringify({ owner: null, deadline: null, unconfirmed: "stop" }),
        id
      )
      expect((yield* snapshot()).turns[0]?.controlBusy).toBeUndefined()
    })
)

it.effect("keeps unconfirmed status independent of native approval reads", () =>
  Effect.gen(function* () {
    const awaitingApproval = vi.fn(() =>
      Effect.die(new Error("approval read must not run"))
    )
    const status = runtimeStatusEffect(
      {
        statusTurns: () =>
          Effect.succeed({
            active: {
              id: "original",
              status: "stopping" as const,
              controlUnconfirmed: "stop" as const,
            },
          }),
      },
      {
        archived: () => Effect.succeed(false),
        awaitingApproval,
        planBlocked: () => Effect.succeed(false),
      }
    )
    expect(yield* status()).toEqual({
      state: "unavailable",
      turnId: "original",
    })
    expect(awaitingApproval).not.toHaveBeenCalled()
  })
)

it.effect(
  "projects exhausted legacy uncertainty without reopening native observation",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      yield* f.store.admit({
        operationId: "exhausted",
        text: "original message",
      })
      const observe = vi.fn(() =>
        Effect.die(new Error("exhausted native work must not be observed"))
      )
      const snapshot = conversationSnapshot(
        f.conversations,
        { observe },
        f.journal,
        () => Effect.succeed(metadata)
      )
      for (const [status, session, phase] of [
        ["preparing", null, "handoff"],
        ["running", "original-session", "observe"],
        ["stopping", "original-session", "stop"],
      ] as const) {
        f.db.run(
          "UPDATE chat_turns SET status=?,session_id=?,answer='Saved answer',control=? WHERE id='exhausted'",
          status,
          session,
          JSON.stringify({
            attempts: 3,
            owner: null,
            deadline: null,
            unconfirmed: null,
          })
        )
        expect((yield* snapshot()).turns[0]).toMatchObject({
          id: "exhausted",
          answer: "Saved answer",
          controlUnconfirmed: phase,
        })
        expect(
          yield* runtimeStatusEffect(f.conversations, {
            archived: () => Effect.succeed(false),
            awaitingApproval: () =>
              Effect.die(
                new Error("exhausted work must not query native approvals")
              ),
            planBlocked: () => Effect.succeed(false),
          })()
        ).toEqual({ state: "unavailable", turnId: "exhausted" })
      }
      expect(observe).not.toHaveBeenCalled()
    })
)
