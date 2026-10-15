import { expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { database } from "./database"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { makeConversations } from "../src/conversations/service"
import { retryMessage, stopConversation } from "../src/conversations/commands"
import { admissionResponse } from "../src/conversations/adapters/http-admission"
import type { Submission } from "../src/conversations/turns"

const fixture = () => {
  const db = database(),
    ledger = new ConversationStore(db, {
      model: "gpt-6.1-sol",
      thinking: "medium",
    }),
    conversations = makeConversations(ledger),
    events: string[] = []
  const host = {
    wake: () =>
      Effect.sync(() => {
        events.push(`wake:${ledger.active()?.status}`)
      }),
    wakeBackground: () =>
      Effect.sync(() => {
        events.push("background")
      }),
    notify: () =>
      Effect.sync(() => {
        events.push("notify")
      }),
  }
  const root = ledger.admit({
    operationId: crypto.randomUUID(),
    text: "Original",
  }).turn
  return { db, ledger, conversations, events, host, root }
}
it.effect(
  "persists stop intent before either wake and maps a child target to its root",
  () =>
    Effect.gen(function* () {
      const f = fixture(),
        child = f.ledger.admit({
          operationId: crypto.randomUUID(),
          text: "Steer",
          mode: "steer",
        }).turn
      yield* stopConversation(f.conversations, f.host)(child.id)
      expect(f.ledger.get(f.root.id)?.status).toBe("stopping")
      expect(f.events).toEqual(["wake:stopping", "background", "notify"])
    })
)
it.effect("a failed stop write never schedules or notifies", () =>
  Effect.gen(function* () {
    const f = fixture()
    f.db.run(
      "CREATE TRIGGER reject_stop BEFORE UPDATE OF status ON chat_turns BEGIN SELECT RAISE(ABORT,'private data'); END"
    )
    expect(
      yield* stopConversation(
        f.conversations,
        f.host
      )(f.root.id).pipe(Effect.result)
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ConversationStorageError" },
    })
    expect(f.ledger.get(f.root.id)?.status).toBe("queued")
    expect(f.events).toEqual([])
  })
)
it.effect(
  "lost stop acknowledgment retains the intent and replay repairs both doorbells",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      let attempts = 0
      const stop = stopConversation(f.conversations, {
        ...f.host,
        wake: () =>
          Effect.gen(function* () {
            if (++attempts === 1)
              return yield* Effect.fail({ _tag: "WakeFailure" as const })
            yield* f.host.wake()
          }),
      })
      expect(yield* stop(f.root.id).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "WakeFailure" },
      })
      expect(f.ledger.get(f.root.id)?.status).toBe("stopping")
      yield* stop(f.root.id)
      expect(attempts).toBe(2)
      expect(f.events).toEqual(["wake:stopping", "background", "notify"])
    })
)
it.effect("interrupting stop waits for the doorbells after persistence", () =>
  Effect.gen(function* () {
    const f = fixture(),
      entered = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>()
    let settled = false
    const stop = stopConversation(f.conversations, {
      ...f.host,
      wake: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(f.host.wake())
        ),
    })
    const pending = yield* stop(f.root.id).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          settled = true
        })
      ),
      Effect.forkChild
    )
    yield* Deferred.await(entered)
    const interruption = yield* Fiber.interrupt(pending).pipe(Effect.forkChild)
    yield* Effect.yieldNow
    expect(settled).toBe(false)
    expect(f.ledger.get(f.root.id)?.status).toBe("stopping")
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(interruption)
    const exit = yield* Fiber.await(pending)
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(f.events).toEqual(["wake:stopping", "background", "notify"])
  })
)
it.effect(
  "retry uses the stored source and attachment identity and the same admission workflow",
  () =>
    Effect.gen(function* () {
      const f = fixture(),
        file = {
          id: crypto.randomUUID(),
          name: "notes.txt",
          mime: "text/plain",
          kind: "text" as const,
          size: 5,
          createdAt: "legacy",
          status: "ready" as const,
          trashed: false,
        }
      f.ledger.finish(
        f.root,
        [{ id: f.root.id, delivery: "answered" }],
        "Done",
        null
      )
      const source = f.ledger.admit(
        { operationId: crypto.randomUUID(), text: "Retry this" },
        { files: [file], content: [{ type: "text", text: "Notes" }] }
      ).turn
      let captured: Submission | undefined
      const retry = retryMessage(f.conversations, (input) =>
        Effect.sync(() => {
          captured = input
          return {
            accepted: true,
            operationId: input.operationId,
            replyId: input.operationId,
          }
        })
      )
      const operationId = crypto.randomUUID()
      expect(yield* retry({ operationId, turnId: source.id })).toMatchObject({
        operationId,
      })
      expect(captured).toEqual({
        operationId,
        text: source.text,
        files: [file.id],
        retryOf: source.id,
      })
    })
)
it.effect("missing retry source maps to HTTP 404 without admission", () =>
  Effect.gen(function* () {
    const f = fixture(),
      retry = retryMessage(f.conversations, () =>
        Effect.die("No source must not admit")
      )
    const response = yield* admissionResponse(
      retry({ operationId: crypto.randomUUID(), turnId: "missing" })
    )
    expect(response.status).toBe(404)
    expect(yield* Effect.promise(() => response.json())).toEqual({
      error: "Reply not found.",
    })
  })
)
