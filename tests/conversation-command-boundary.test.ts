import { expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"

import { admissionResponse } from "../src/conversations/adapters/http-admission"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import {
  checkConversationReply,
  retryConversationStop,
  retryMessage,
  stopConversation,
} from "../src/conversations/commands"
import { makeConversations } from "../src/conversations/service"
import type { Submission } from "../src/conversations/turns"
import { database } from "./database"

const fixture = () => {
  const db = database(),
    ledger = new ConversationStore(db, {
      model: "gpt-6.1-sol",
      thinking: "medium",
    }),
    conversations = makeConversations(ledger),
    events: string[] = []
  const host = {
    prearm: () => Effect.sync(() => Date.now() + 60_000),
    wake: () =>
      Effect.sync(() => {
        events.push(`wake:${Effect.runSync(ledger.active())?.status}`)
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
  const root = Effect.runSync(
    ledger.admit(
      {
        operationId: crypto.randomUUID(),
        text: "Original",
      },
      undefined,
      undefined,
      undefined,
      { discoveryDeadline: Date.now() + 60_000 }
    )
  ).turn
  return { db, ledger, conversations, events, host, root }
}
it.effect(
  "persists stop intent before either wake and maps a child target to its root",
  () =>
    Effect.gen(function* () {
      const f = fixture(),
        child = Effect.runSync(
          f.ledger.admit(
            {
              operationId: crypto.randomUUID(),
              text: "Steer",
              mode: "steer",
            },
            undefined,
            undefined,
            undefined,
            { discoveryDeadline: Date.now() + 60_000 }
          )
        ).turn
      yield* stopConversation(f.conversations, f.host)(child.id)
      expect(Effect.runSync(f.ledger.get(f.root.id))?.status).toBe("stopping")
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
    expect(Effect.runSync(f.ledger.get(f.root.id))?.status).toBe("queued")
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
      expect(Effect.runSync(f.ledger.get(f.root.id))?.status).toBe("stopping")
      yield* stop(f.root.id)
      expect(attempts).toBe(2)
      expect(f.events).toEqual([
        "background",
        "notify",
        "wake:stopping",
        "background",
        "notify",
      ])
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
    expect(Effect.runSync(f.ledger.get(f.root.id))?.status).toBe("stopping")
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
      Effect.runSync(
        f.ledger.finish(
          f.root,
          [{ id: f.root.id, delivery: "answered" }],
          "Done",
          null
        )
      )
      const source = Effect.runSync(
        f.ledger.admit(
          { operationId: crypto.randomUUID(), text: "Retry this" },
          { files: [file], content: [{ type: "text", text: "Notes" }] },
          undefined,
          undefined,
          { discoveryDeadline: Date.now() + 60_000 }
        )
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

it.effect(
  "Stop still revokes after discovery failure and retains every doorbell failure",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      const exit = yield* stopConversation(f.conversations, {
        ...f.host,
        prearm: () => Effect.fail({ _tag: "ArmFailure" as const }),
        wake: () => Effect.die("wake failed"),
      })(f.root.id).pipe(Effect.exit)
      expect(yield* f.ledger.get(f.root.id)).toMatchObject({
        status: "stopping",
        control: { owner: null, unconfirmed: "stop" },
      })
      expect(f.events).toEqual(["background", "notify"])
      expect(
        Exit.isFailure(exit) &&
          exit.cause.reasons.some(
            (reason) =>
              reason._tag === "Fail" && reason.error._tag === "ArmFailure"
          )
      ).toBe(true)
      expect(
        Exit.isFailure(exit) &&
          exit.cause.reasons.some(
            (reason) => reason._tag === "Die" && reason.defect === "wake failed"
          )
      ).toBe(true)
    })
)

it.effect(
  "failed Stop storage retains the arm failure without claiming revocation",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      f.db.run(
        "CREATE TRIGGER reject_stop BEFORE UPDATE OF status ON chat_turns BEGIN SELECT RAISE(ABORT,'storage failed'); END"
      )
      const exit = yield* stopConversation(f.conversations, {
        ...f.host,
        prearm: () => Effect.fail({ _tag: "ArmFailure" as const }),
      })(f.root.id).pipe(Effect.exit)
      expect(yield* f.ledger.get(f.root.id)).toMatchObject({ status: "queued" })
      expect(f.events).toEqual([])
      expect(
        Exit.isFailure(exit) &&
          exit.cause.reasons
            .filter((reason) => reason._tag === "Fail")
            .map((reason) => reason.error._tag)
      ).toEqual(["ArmFailure", "ConversationStorageError"])
    })
)

it.effect(
  "Retry Stop consumes only the displayed unconfirmed revision once",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      yield* f.ledger.requestStop(f.root.id)
      const stopped = (yield* f.ledger.get(f.root.id))!
      const retry = retryConversationStop(f.conversations, f.host)
      yield* retry(f.root.id, stopped.revision)
      expect(yield* f.ledger.get(f.root.id)).toMatchObject({
        status: "stopping",
        revision: stopped.revision + 1,
        control: { unconfirmed: null },
      })
      expect(
        yield* retry(f.root.id, stopped.revision).pipe(Effect.result)
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConversationConflict" },
      })
      expect(f.events).toEqual(["wake:stopping", "background", "notify"])
    })
)

it.effect(
  "Retry Stop cannot clear uncertainty while the previous owner is joining",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      const claimed = yield* f.ledger.claimControl(
        f.root.id,
        "old-owner",
        Date.now() + 60_000
      )
      expect(claimed).toBeDefined()
      yield* f.ledger.requestStop(f.root.id)
      const stopped = (yield* f.ledger.get(f.root.id))!
      expect(
        yield* retryConversationStop(f.conversations, f.host)(
          f.root.id,
          stopped.revision
        ).pipe(Effect.result)
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConversationConflict" },
      })
      expect(yield* f.ledger.get(f.root.id)).toMatchObject({
        revision: stopped.revision,
        control: { owner: "old-owner", unconfirmed: "stop" },
      })
      expect(f.events).toEqual([])
    })
)

it.effect(
  "Check reply forwards the displayed identity and revision without new admission",
  () =>
    Effect.gen(function* () {
      const f = fixture(),
        calls: unknown[] = []
      yield* checkConversationReply({
        inspect: (id, revision) =>
          Effect.sync(() => {
            calls.push([id, revision])
          }),
        notify: f.host.notify,
      })(f.root.id, f.root.revision)
      expect(calls).toEqual([[f.root.id, f.root.revision]])
      expect(f.events).toEqual(["notify"])
      expect(yield* f.ledger.get(f.root.id)).toMatchObject({
        status: "queued",
        revision: f.root.revision,
      })
    })
)

it.effect(
  "interrupted inspection joins cleanup and retains a late failure",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        cleaning = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      let notified = false
      const pending = yield* checkConversationReply({
        inspect: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Deferred.succeed(cleaning, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.die("inspection cleanup"))
              )
            )
          ),
        notify: () =>
          Effect.sync(() => {
            notified = true
          }),
      })("original", 2).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const interruption = yield* Fiber.interrupt(pending).pipe(
        Effect.forkChild
      )
      yield* Deferred.await(cleaning)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(interruption)
      const exit = yield* Fiber.await(pending)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(
        Exit.isFailure(exit) &&
          exit.cause.reasons.some(
            (reason) =>
              reason._tag === "Die" && reason.defect === "inspection cleanup"
          )
      ).toBe(true)
      expect(notified).toBe(false)
    })
)

it.effect("a coupled Stop transaction retains its own checked conflict", () =>
  Effect.gen(function* () {
    const f = fixture()
    expect(
      yield* stopConversation(
        {
          requestStop: () =>
            Effect.fail({
              _tag: "RoutineConflict" as const,
              message: "Routine changed",
            }),
        },
        f.host
      )(f.root.id).pipe(Effect.result)
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "RoutineConflict", message: "Routine changed" },
    })
    expect(f.events).toEqual([])
  })
)
