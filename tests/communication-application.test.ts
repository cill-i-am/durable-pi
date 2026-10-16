import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { expect, it } from "vitest"
import { it as effectIt } from "@effect/vitest"
import { TestClock } from "effect/testing"
import {
  makeCommunication,
  type Host,
} from "../src/communication/communication"
import {
  continuationId,
  WebCryptoContinuationIdentity,
} from "../src/communication/adapters/identity"
import { sqliteMailbox } from "../src/communication/adapters/sqlite"
import { Mailbox, MailboxTransport } from "../src/communication/mailbox"
import {
  failure,
  type Envelope,
  type CommunicationError,
} from "../src/communication/contracts"
import { AgentId } from "../src/agents/domain"
import { database, corrupt } from "./database"
import { deliverNext } from "../src/communication/delivery"
import { TaskExecution } from "../src/communication/execution"
import { ConversationStorageError } from "../src/conversations/turns"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"

const resumedTable = sqliteTable("resumed", {
  id: text("id").primaryKey(),
  task: text("task").notNull(),
})
const run = Effect.runPromise
const a = Schema.decodeUnknownSync(AgentId)("home"),
  b = Schema.decodeUnknownSync(AgentId)("00000000-0000-4000-8000-000000000001")
const source = { turnId: "10000000-0000-4000-8000-000000000001", toolId: "17" }
const brief = {
  to: b,
  kind: "question" as const,
  objective: "Compare the two drafts",
  context: "EUR 2400. Do not publish.",
}
async function fixture(
  options: { prepare?: () => Effect.Effect<void, CommunicationError> } = {}
) {
  const db = database(),
    repo = sqliteMailbox(db),
    mailbox = Effect.runSync(repo.initialize)
  Effect.runSync(repo.bindIdentity({ owner: "synthetic-owner", bot: a }))
  db.run("CREATE TABLE resumed (id TEXT PRIMARY KEY,task TEXT NOT NULL)")
  let current: Effect.Success<ReturnType<Host["current"]>> = "done",
    idle = true,
    wakeFails = false,
    admitFails = false,
    preparations = 0
  const host: Host = {
    transactionGroup: db,
    current: () => Effect.sync(() => current),
    idle: () => Effect.sync(() => idle),
    contacts: () => Effect.succeed([{ id: b, name: "Drafting bot" }]),
    prepare: () =>
      Effect.sync(() => {
        preparations++
      }).pipe(Effect.andThen(options.prepare?.() ?? Effect.void)),
    wake: () =>
      wakeFails
        ? Effect.fail(failure("storage", "Fixture wake failed"))
        : Effect.void,
    wakeConversation: () => Effect.void,
    notify: () => {},
    resume: (task, id) =>
      db
        .use((orm) =>
          orm
            .insert(resumedTable)
            .values({ id, task: task.id })
            .onConflictDoNothing()
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ConversationStorageError({
                operation: "resume fixture",
                cause,
              })
          ),
          Effect.andThen(() =>
            Effect.sync(() => {
              if (admitFails) throw new Error("Fixture admission crash")
              return { kind: "admitted" as const, turnId: id }
            })
          )
        ),
  }
  const transport = Layer.succeed(MailboxTransport, {
    permitted: () => Effect.succeed(true),
    authenticate: () => Effect.void,
    deliver: (envelope) =>
      Effect.succeed({
        id: envelope.id,
        taskId: envelope.taskId,
        acceptedAt: Date.now(),
      }),
  })
  const app = await run(
    makeCommunication(host).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Mailbox, mailbox),
          transport,
          Layer.succeed(TaskExecution, {
            advance: () => Effect.succeed(undefined),
            settled: () => Effect.void,
          }),
          WebCryptoContinuationIdentity
        )
      )
    )
  )
  const complete = async (id: string) => {
    const request = (await run(mailbox.task(id))).request
    const envelope: Envelope = {
      ...request,
      id: `result:${id}`,
      from: b,
      to: a,
      causationId: id,
      payload: {
        kind: "result",
        outcome: { status: "completed", text: "Draft A fits." },
      },
    }
    await run(mailbox.accept(envelope, Date.now()))
  }
  return {
    app,
    mailbox,
    db,
    complete,
    set: (state: {
      current?: typeof current
      idle?: boolean
      wakeFails?: boolean
      admitFails?: boolean
    }) => {
      current = state.current ?? current
      idle = state.idle ?? idle
      wakeFails = state.wakeFails ?? wakeFails
      admitFails = state.admitFails ?? admitFails
    },
    preparations: () => preparations,
  }
}
it("replays an approved tool with the same task and rejects changed content", async () => {
  const f = await fixture(),
    first = await run(f.app.delegate(brief, source)),
    again = await run(f.app.delegate(brief, source))
  expect(again.id).toBe(first.id)
  expect(await run(f.mailbox.tasks())).toHaveLength(1)
  expect(
    await run(
      f.app
        .delegate({ ...brief, context: "Changed constraints" }, source)
        .pipe(Effect.result)
    )
  ).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } })
})
it("commits the continuation and consumed dependency together and recovers an interrupted admission", async () => {
  const f = await fixture(),
    request = await run(f.app.delegate(brief, source))
  await f.complete(request.id)
  f.set({ admitFails: true })
  const exit = await run(Effect.exit(f.app.pump()))
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(f.db.all("SELECT * FROM resumed")).toHaveLength(0)
  expect((await run(f.mailbox.task(request.id))).resumed).toBe(false)
  f.set({ admitFails: false })
  await run(f.app.pump())
  await run(f.app.pump())
  expect(f.db.all("SELECT * FROM resumed")).toEqual([
    { id: await run(continuationId(request.id)), task: request.id },
  ])
  expect((await run(f.mailbox.task(request.id))).resumed).toBe(true)
})
it("retains the historical continuation UUID derivation", async () => {
  expect(
    await run(continuationId(`bot:${source.turnId}:${source.toolId}`))
  ).toBe("adcd70a7-a394-41b0-8d94-58a4172113a4")
})
it("rejects continuation admission in a different transaction group before invoking it", async () => {
  const f = await fixture()
  const request = await run(f.app.delegate(brief, source))
  await f.complete(request.id)
  let admissions = 0
  const result = await run(
    f.mailbox
      .resume(request.id, {
        transactionGroup: database(),
        operationId: "continuation",
        admit: () =>
          Effect.sync(() => {
            admissions++
            return { kind: "admitted" as const, turnId: "continuation" }
          }),
      })
      .pipe(Effect.result)
  )
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { code: "conflict" },
  })
  expect(admissions).toBe(0)
  expect((await run(f.mailbox.task(request.id))).resumed).toBe(false)
})
it("rolls back continuation writes when admission changes the operation identity", async () => {
  const f = await fixture()
  const request = await run(f.app.delegate(brief, source))
  await f.complete(request.id)
  const result = await run(
    f.mailbox
      .resume(request.id, {
        transactionGroup: f.db,
        operationId: "continuation",
        admit: (task) =>
          f.db
            .use((orm) =>
              orm
                .insert(resumedTable)
                .values({ id: "different", task: task.id })
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ConversationStorageError({
                    operation: "resume fixture",
                    cause,
                  })
              ),
              Effect.as({ kind: "admitted" as const, turnId: "different" })
            ),
      })
      .pipe(Effect.result)
  )
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { code: "conflict" },
  })
  expect(f.db.all("SELECT * FROM resumed")).toHaveLength(0)
  expect((await run(f.mailbox.task(request.id))).resumed).toBe(false)
})
it("classifies a failed mailbox write and rolls back the admitted continuation", async () => {
  const f = await fixture()
  const request = await run(f.app.delegate(brief, source))
  await f.complete(request.id)
  f.db.run(
    "CREATE TRIGGER reject_resume BEFORE UPDATE ON communication_tasks WHEN json_extract(NEW.body,'$.resumed')=1 BEGIN SELECT RAISE(ABORT,'resume failure'); END"
  )
  expect(await run(f.app.pump().pipe(Effect.result))).toMatchObject({
    _tag: "Failure",
    failure: { code: "storage" },
  })
  expect(f.db.all("SELECT * FROM resumed")).toHaveLength(0)
  expect((await run(f.mailbox.task(request.id))).resumed).toBe(false)
  f.db.run("DROP TRIGGER reject_resume")
  await run(f.app.pump())
  expect(f.db.all("SELECT * FROM resumed")).toHaveLength(1)
})
it("keeps corrupt historical task records in the defect channel", async () => {
  const f = await fixture()
  const request = await run(f.app.delegate(brief, source))
  corrupt(
    f.db,
    "UPDATE communication_tasks SET body=? WHERE id=?",
    "{corrupt",
    request.id
  )
  const exit = await run(Effect.exit(f.app.get(request.id)))
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
})
it("retains a result receipt and maps a conversation admission write failure to the mailbox storage channel", async () => {
  const f = await fixture(),
    conversations = new ConversationStore(f.db, {
      model: "test",
      thinking: "off",
    })
  const request = await run(f.app.delegate(brief, source))
  await f.complete(request.id)
  const operation = await run(continuationId(request.id))
  f.db.run(
    "CREATE TRIGGER reject_continuation_turn BEFORE INSERT ON chat_turns BEGIN SELECT RAISE(ABORT,'admission failure'); END"
  )
  const result = await run(
    f.mailbox
      .resume(request.id, {
        transactionGroup: f.db,
        operationId: operation,
        admit: () =>
          conversations
            .admit({ operationId: operation, text: "Continuation" })
            .pipe(
              Effect.map((admission) => ({
                kind: "admitted" as const,
                turnId: admission.turn.id,
              }))
            ),
      })
      .pipe(Effect.result)
  )
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { code: "storage" },
  })
  expect((await run(f.mailbox.task(request.id))).resumed).toBe(false)
  expect(Effect.runSync(conversations.recent())).toHaveLength(0)
})
it("does not inject results into an active unrelated turn or restart cancelled work", async () => {
  const f = await fixture(),
    request = await run(f.app.delegate(brief, source))
  await f.complete(request.id)
  f.set({ idle: false })
  await run(f.app.pump())
  expect(f.db.all("SELECT * FROM resumed")).toHaveLength(0)
  f.set({ idle: true, current: "cancelled" })
  await run(f.app.pump())
  expect(f.db.all("SELECT * FROM resumed")).toHaveLength(0)
  expect((await run(f.mailbox.task(request.id))).resumed).toBe(true)
  expect(
    await run(
      f.app.delegate(brief, { ...source, toolId: "18" }).pipe(Effect.result)
    )
  ).toMatchObject({ _tag: "Failure", failure: { code: "forbidden" } })
})
it("persists cooperative cancellation and prohibits replay as a new execution", async () => {
  const f = await fixture(),
    request = await run(f.app.delegate(brief, source))
  f.set({ current: "cancelled" })
  await run(f.app.pump())
  const task = await run(f.mailbox.task(request.id))
  expect(task.status).toBe("cancelling")
  expect(task.cancelRequested).toBe(true)
  expect(
    (await run(f.mailbox.deliveries())).some(
      (d) => d.envelope.payload.kind === "cancel"
    )
  ).toBe(true)
})
it("bounds total task fan-out even after earlier results finish", async () => {
  const f = await fixture()
  for (let n = 0; n < 3; n++) {
    const request = await run(
      f.app.delegate(brief, { ...source, toolId: String(n) })
    )
    await f.complete(request.id)
    await run(f.app.pump())
  }
  expect(
    await run(
      f.app.delegate(brief, { ...source, toolId: "4" }).pipe(Effect.result)
    )
  ).toMatchObject({ _tag: "Failure", failure: { code: "limit" } })
})
it("fails closed before admission without a durable wake and rejects self or unknown contacts", async () => {
  const f = await fixture()
  f.set({ wakeFails: true })
  expect(
    await run(f.app.delegate(brief, source).pipe(Effect.result))
  ).toMatchObject({ _tag: "Failure", failure: { code: "storage" } })
  expect(await run(f.mailbox.tasks())).toHaveLength(0)
  expect(
    await run(f.app.delegate({ ...brief, to: a }, source).pipe(Effect.result))
  ).toMatchObject({ _tag: "Failure", failure: { code: "forbidden" } })
})

effectIt.effect(
  "checks the current deadline after remote preparation before admitting a task",
  () =>
    Effect.gen(function* () {
      const preparing = yield* Deferred.make<void>()
      const f = yield* Effect.promise(() =>
        fixture({
          prepare: () =>
            Deferred.succeed(preparing, undefined).pipe(
              Effect.andThen(Effect.sleep("11 minutes"))
            ),
        })
      )
      const pending = yield* Effect.forkChild(
        f.app.delegate(brief, source).pipe(Effect.result)
      )
      yield* Deferred.await(preparing)
      yield* TestClock.adjust("11 minutes")
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "Failure",
        failure: { code: "expired" },
      })
      expect(yield* f.mailbox.tasks()).toHaveLength(0)
      expect(yield* f.mailbox.deliveries()).toHaveLength(0)
    })
)

it("delivery cleanup defects do not become an ordinary backoff update", async () => {
  const f = await fixture(),
    request = await run(f.app.delegate(brief, source)),
    cleanup = new Error("Private delivery cleanup failure")
  const exit = await Effect.runPromiseExit(
    deliverNext().pipe(
      Effect.provideService(Mailbox, f.mailbox),
      Effect.provideService(MailboxTransport, {
        deliver: () =>
          Effect.fail(failure("transport", "Unavailable")).pipe(
            Effect.ensuring(Effect.die(cleanup))
          ),
        permitted: () => Effect.succeed(true),
        authenticate: () => Effect.void,
      })
    )
  )
  expect(
    Exit.isFailure(exit) &&
      exit.cause.reasons.some(
        (reason) => reason._tag === "Die" && reason.defect === cleanup
      )
  ).toBe(true)
  expect(
    (await run(f.mailbox.deliveries())).find(
      (delivery) => delivery.envelope.taskId === request.id
    )
  ).toMatchObject({ status: "delivering", attempts: 1, error: null })
})
