import { it as effectIt } from "@effect/vitest"
import type { LifecycleJob, LifecycleJobPushOptions } from "agents/lifecycle"
import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { expect, it, vi } from "vitest"

import { AgentId } from "../src/agents/domain"
import {
  continuationId,
  WebCryptoContinuationIdentity,
} from "../src/communication/adapters/identity"
import { CommunicationRunner } from "../src/communication/adapters/lifecycle"
import { sqliteMailbox } from "../src/communication/adapters/sqlite"
import {
  makeCommunication,
  type Host,
} from "../src/communication/communication"
import {
  failure,
  type Envelope,
  type CommunicationError,
} from "../src/communication/contracts"
import { deliverNext } from "../src/communication/delivery"
import { TaskExecution } from "../src/communication/execution"
import { Mailbox, MailboxTransport } from "../src/communication/mailbox"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { ConversationStorageError } from "../src/conversations/turns"
import { database, corrupt } from "./database"

vi.mock("agents/lifecycle", () => ({ LifecycleCapability: class {} }))

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
  options: {
    prepare?: () => Effect.Effect<void, CommunicationError>
    armMailbox?: Host["armMailbox"]
    wake?: Host["wake"]
    prearm?: Host["prearm"]
    wakeConversation?: Host["wakeConversation"]
    resume?: Host["resume"]
    recovery?: Host["recovery"]
    reconcileQueue?: Host["reconcileQueue"]
    armRecovery?: Host["armRecovery"]
    retryRecovery?: Host["retryRecovery"]
  } = {}
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
    recovery: options.recovery,
    reconcileQueue: options.reconcileQueue,
    armRecovery: options.armRecovery,
    retryRecovery: options.retryRecovery,
    current: () => Effect.sync(() => current),
    idle: () => Effect.sync(() => idle),
    contacts: () => Effect.succeed([{ id: b, name: "Drafting bot" }]),
    prepare: () =>
      Effect.sync(() => {
        preparations++
      }).pipe(Effect.andThen(options.prepare?.() ?? Effect.void)),
    wake:
      options.wake ??
      (() =>
        wakeFails
          ? Effect.fail(failure("storage", "Fixture wake failed"))
          : Effect.void),
    armMailbox:
      options.armMailbox ??
      (() =>
        wakeFails
          ? Effect.fail(failure("storage", "Fixture discovery failed"))
          : Effect.succeed(Date.now() + 60_000)),
    prearm: options.prearm ?? (() => Effect.sync(() => Date.now() + 60_000)),
    wakeConversation: options.wakeConversation ?? (() => Effect.void),
    notify: () => {},
    resume:
      options.resume ??
      ((task, id) =>
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
          )),
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
    await run(
      mailbox.accept(envelope, Date.now(), {
        discoveryDeadline: Date.now() + 60_000,
      })
    )
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
it("retains corrupt historical task records as explicit incompatible data", async () => {
  const f = await fixture()
  const request = await run(f.app.delegate(brief, source))
  corrupt(
    f.db,
    "UPDATE communication_tasks SET body=? WHERE id=?",
    "{corrupt",
    request.id
  )
  const exit = await run(Effect.exit(f.app.get(request.id)))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit))
    expect(exit.cause.reasons).toContainEqual(
      expect.objectContaining({
        _tag: "Fail",
        error: expect.objectContaining({ code: "incompatible" }),
      })
    )
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
            .admit(
              { operationId: operation, text: "Continuation" },
              undefined,
              undefined,
              undefined,
              { discoveryDeadline: Date.now() + 60_000 }
            )
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

it("prearms continuation discovery before its shared transaction and wakes after commit", async () => {
  const order: string[] = [],
    deadline = Date.now() + 60_000
  let f: Awaited<ReturnType<typeof fixture>>
  f = await fixture({
    prearm: () =>
      Effect.sync(() => {
        order.push("prearm")
        expect(f.db.all("SELECT * FROM resumed")).toHaveLength(0)
        return deadline
      }),
    resume: (task, id, discoveryDeadline) =>
      f.db
        .use((orm) => {
          expect(discoveryDeadline).toBe(deadline)
          order.push("commit")
          return orm.insert(resumedTable).values({ id, task: task.id })
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ConversationStorageError({ operation: "resume", cause })
          ),
          Effect.as({ kind: "admitted" as const, turnId: id })
        ),
    wakeConversation: () =>
      Effect.sync(() => {
        expect(f.db.all("SELECT * FROM resumed")).toHaveLength(1)
        order.push("wake")
      }),
  })
  const request = await run(f.app.delegate(brief, source))
  await f.complete(request.id)
  await run(f.app.pump())
  await run(f.app.pump())
  expect(order).toEqual(["prearm", "commit", "wake"])
  expect((await run(f.mailbox.task(request.id))).resumed).toBe(true)
})

it("retains the continuation and every scheduling failure reason when prearm fails", async () => {
  const cause = Cause.combine(
    Cause.fail(failure("storage", "Discovery unavailable")),
    Cause.die(new Error("discovery diagnostic"))
  )
  const f = await fixture({ prearm: () => Effect.failCause(cause) }),
    request = await run(f.app.delegate(brief, source))
  await f.complete(request.id)
  const exit = await run(Effect.exit(f.app.pump()))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual([
      "Fail",
      "Die",
    ])
    expect(
      exit.cause.reasons.map((reason) =>
        reason._tag === "Fail"
          ? reason.error
          : reason._tag === "Die"
            ? reason.defect
            : undefined
      )
    ).toEqual(
      cause.reasons.map((reason) =>
        reason._tag === "Fail"
          ? reason.error
          : reason._tag === "Die"
            ? reason.defect
            : undefined
      )
    )
  }
  expect(f.db.all("SELECT * FROM resumed")).toHaveLength(0)
  expect((await run(f.mailbox.task(request.id))).resumed).toBe(false)
})

it("rolls back continuation consumption when its prepared discovery lease expires", async () => {
  let conversations: ConversationStore
  const f = await fixture({
    prearm: () => Effect.succeed(0),
    resume: (_task, id, discoveryDeadline) =>
      conversations
        .admit(
          { operationId: id, text: "Continuation" },
          undefined,
          [],
          undefined,
          { discoveryDeadline }
        )
        .pipe(
          Effect.map(({ turn }) => ({
            kind: "admitted" as const,
            turnId: turn.id,
          }))
        ),
  })
  conversations = new ConversationStore(f.db, {
    model: "test",
    thinking: "off",
  })
  const request = await run(f.app.delegate(brief, source))
  await f.complete(request.id)
  expect(Exit.isFailure(await run(Effect.exit(f.app.pump())))).toBe(true)
  expect((await run(f.mailbox.task(request.id))).resumed).toBe(false)
  expect(await run(conversations.recent())).toEqual([])
})

it("retains the committed continuation when its immediate wake acknowledgement fails", async () => {
  let wakes = 0
  const f = await fixture({
    wakeConversation: () =>
      Effect.suspend(() => {
        wakes++
        return Effect.fail(failure("storage", "Wake acknowledgement lost"))
      }),
  })
  const request = await run(f.app.delegate(brief, source))
  await f.complete(request.id)
  expect(Exit.isFailure(await run(Effect.exit(f.app.pump())))).toBe(true)
  expect(f.db.all("SELECT * FROM resumed")).toHaveLength(1)
  expect((await run(f.mailbox.task(request.id))).resumed).toBe(true)
  await run(f.app.pump())
  expect(f.db.all("SELECT * FROM resumed")).toHaveLength(1)
  expect(wakes).toBe(1)
})

it("replays the original request without renewing discovery or its delivery budget", async () => {
  let arms = 0
  const f = await fixture({
    armMailbox: () =>
      Effect.suspend(() =>
        ++arms === 1
          ? Effect.succeed(Date.now() + 60_000)
          : Effect.fail(failure("storage", "Replay cannot renew discovery"))
      ),
  })
  const first = await run(f.app.delegate(brief, source))
  const before = await run(f.mailbox.deliveries())
  expect(await run(f.app.delegate(brief, source))).toEqual(first)
  expect(arms).toBe(1)
  expect(await run(f.mailbox.deliveries())).toEqual(before)
})

it("persists the first Stop and its immutable cancel envelope when discovery and wake both fail", async () => {
  const f = await fixture()
  const request = await run(f.app.delegate(brief, source))
  f.set({ wakeFails: true })
  const stopped = await run(Effect.exit(f.app.cancel(request.id)))
  expect(Exit.isFailure(stopped)).toBe(true)
  if (Exit.isFailure(stopped))
    expect(
      stopped.cause.reasons.filter((reason) => reason._tag === "Fail")
    ).toHaveLength(2)
  expect(await run(f.mailbox.task(request.id))).toMatchObject({
    status: "cancelling",
    cancelRequested: true,
  })
  const cancellations = (await run(f.mailbox.deliveries())).filter(
    (delivery) => delivery.envelope.payload.kind === "cancel"
  )
  expect(cancellations).toHaveLength(1)
  await run(Effect.exit(f.app.cancel(request.id)))
  expect(
    (await run(f.mailbox.deliveries())).filter(
      (delivery) => delivery.envelope.payload.kind === "cancel"
    )
  ).toEqual(cancellations)
})

it("rejects an expired mailbox discovery lease at final admission without accepting the request", async () => {
  const f = await fixture({ armMailbox: () => Effect.succeed(0) })
  const admitted = await run(Effect.exit(f.app.delegate(brief, source)))
  expect(Exit.isFailure(admitted)).toBe(true)
  expect(await run(f.mailbox.tasks())).toEqual([])
  expect(await run(f.mailbox.deliveries())).toEqual([])
})

it.each(["prepare", "prearm", "wakeConversation"] as const)(
  "retains joined cleanup defects when %s is interrupted",
  async (stage) => {
    const entered = Deferred.makeUnsafe<void>()
    const defect = new Error(`Interrupted ${stage} cleanup failed`)
    const held = () =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.die(defect))
      )
    const f = await fixture({ [stage]: held })
    const controller = new AbortController()
    let operation: Effect.Effect<unknown, CommunicationError>
    if (stage === "prepare") operation = f.app.delegate(brief, source)
    else {
      const request = await run(f.app.delegate(brief, source))
      await f.complete(request.id)
      operation = f.app.pump()
    }
    const pending = Effect.runPromiseExit(operation, {
      signal: controller.signal,
    })
    await run(Deferred.await(entered))
    controller.abort()
    const exit = await pending
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    if (Exit.isFailure(exit))
      expect(exit.cause.reasons).toContainEqual(
        expect.objectContaining({ _tag: "Die", defect })
      )
  }
)

function applicationRunner(f: Awaited<ReturnType<typeof fixture>>) {
  const jobs = new Map<string, LifecycleJob>()
  const stored = new Map<string, unknown>()
  const values = {
    get: async <T>(key: string) =>
      structuredClone(stored.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => {
      stored.set(key, structuredClone(value))
    },
    delete: async (key: string) => stored.delete(key),
  }
  const storage = {
    ...values,
    transaction: async <T>(work: (tx: typeof values) => Promise<T>) => {
      const before = structuredClone(stored)
      try {
        return await work(values)
      } catch (error) {
        stored.clear()
        for (const [key, value] of before) stored.set(key, value)
        throw error
      }
    },
  }
  const runner = new CommunicationRunner<CommunicationError>({
    run,
    step: (onAttempt) => run(f.app.pump(onAttempt)),
    exhaust: (attempt, _error, current) =>
      f.mailbox.exhaustControl(attempt, Date.now(), current),
    restore: () => f.mailbox.restoreControl(Date.now()),
    nextWake: () => f.mailbox.nextWake(),
  })
  Object.defineProperty(runner, "lifecycle", {
    value: {
      storage,
      jobs: {
        get: (id: string) => jobs.get(id),
        cancel: async (id: string) => jobs.delete(id),
        push: async (options: LifecycleJobPushOptions) => {
          const job = {
            ...options,
            id: options.id!,
            capability: "bot-communication",
            createdAt: Date.now(),
            singleflight: options.singleflight ?? false,
            exclusive: options.exclusive ?? false,
            recoveryLoop: options.recoveryLoop ?? false,
          } as LifecycleJob
          jobs.set(job.id, job)
          return job
        },
        reschedule: async (id: string, time: number) => {
          const job = jobs.get(id)
          if (!job) return false
          jobs.set(id, { ...job, time })
          return true
        },
        rearm: async () => {},
      },
    },
  })
  return {
    runner,
    jobs,
    stored,
    pump: () => jobs.get("bot-communication:pump")!,
  }
}

it("bounds failed result continuation attempts and explicitly retries the same result after discovery expires", async () => {
  let unavailable = true
  let queue: ReturnType<typeof applicationRunner>
  const f = await fixture({
    prearm: () =>
      unavailable
        ? Effect.fail(failure("storage", "Continuation discovery unavailable"))
        : Effect.succeed(Date.now() + 60000),
    wake: () => Effect.promise(() => queue.runner.wake()),
  })
  queue = applicationRunner(f)
  const request = await run(f.app.delegate(brief, source))
  await f.complete(request.id)
  await queue.runner.reconcile()
  const job = queue.pump()
  expect(queue.jobs.has("bot-communication:recovery")).toBe(false)
  for (let attempt = 1; attempt <= 3; attempt++)
    await expect(queue.runner.onJob({ job, attempt })).rejects.toThrow()
  const outcome = await queue.runner.onJobError(
    { job, attempt: 3 },
    new Error("All attempts failed")
  )
  expect(outcome).toBeUndefined()
  queue.jobs.delete(job.id)
  expect(await run(f.mailbox.task(request.id))).toMatchObject({
    status: "completed",
    outcome: { text: "Draft A fits." },
    resumed: false,
    control: {
      owner: null,
      phase: "continuation",
      attempts: 3,
      unconfirmed: true,
    },
  })
  await queue.runner.reconcile()
  expect(queue.pump()).toBeUndefined()
  expect(f.db.all("SELECT * FROM resumed")).toHaveLength(0)
  unavailable = false
  await run(f.app.retry(request.id))
  expect(queue.pump()).toBeDefined()
  const retried = queue.pump()
  const next = await queue.runner.onJob({ job: retried, attempt: 1 })
  expect(next).toBeUndefined()
  expect(await run(f.mailbox.task(request.id))).toMatchObject({
    resumed: true,
    outcome: { text: "Draft A fits." },
  })
  expect(f.db.all("SELECT * FROM resumed")).toHaveLength(1)
  await run(f.app.pump())
  expect(f.db.all("SELECT * FROM resumed")).toHaveLength(1)
})

it("continues unrelated results after one continuation exhausts its own budget", async () => {
  let preparations = 0
  const f = await fixture({
    prearm: () =>
      ++preparations <= 3
        ? Effect.fail(
            failure("storage", "One result cannot prepare its continuation")
          )
        : Effect.succeed(Date.now() + 60000),
  })
  const first = await run(f.app.delegate(brief, source))
  const second = await run(f.app.delegate(brief, { ...source, toolId: "18" }))
  await f.complete(first.id)
  await f.complete(second.id)
  const queue = applicationRunner(f)
  await queue.runner.reconcile()
  const job = queue.pump()
  for (let attempt = 1; attempt <= 3; attempt++)
    await expect(queue.runner.onJob({ job, attempt })).rejects.toThrow()
  const outcome = await queue.runner.onJobError(
    { job, attempt: 3 },
    new Error("One result exhausted")
  )
  expect(outcome).toHaveProperty("rescheduleAt")
  expect(await run(f.mailbox.task(first.id))).toMatchObject({
    resumed: false,
    control: { attempts: 3, unconfirmed: true },
  })
  expect(await run(f.mailbox.task(second.id))).toMatchObject({
    resumed: false,
    control: { attempts: 0, unconfirmed: false },
  })
  await queue.runner.onJob({ job, attempt: 1 })
  expect(await run(f.mailbox.task(second.id))).toMatchObject({
    resumed: true,
    control: { unconfirmed: false },
  })
  expect(f.db.all("SELECT * FROM resumed")).toHaveLength(1)
})

it("retains a joined continuation release receipt when SQL fails after the result was consumed", async () => {
  const f = await fixture()
  const request = await run(f.app.delegate(brief, source))
  await f.complete(request.id)
  f.db.run(
    "CREATE TRIGGER fail_continuation_release BEFORE UPDATE ON communication_tasks WHEN json_extract(OLD.body,'$.control.phase')='continuation' AND json_extract(OLD.body,'$.control.owner') IS NOT NULL AND json_extract(NEW.body,'$.control.owner') IS NULL BEGIN SELECT RAISE(ABORT,'held continuation release'); END"
  )
  const first = await run(Effect.exit(f.app.pump()))
  expect(Exit.isFailure(first)).toBe(true)
  const held = await run(f.mailbox.task(request.id))
  expect(held.resumed).toBe(true)
  expect(held.control.owner).not.toBeNull()
  expect(f.db.all("SELECT * FROM resumed")).toHaveLength(1)
  expect(Exit.isFailure(await run(Effect.exit(f.app.pump())))).toBe(true)
  expect(f.db.all("SELECT * FROM resumed")).toHaveLength(1)
  f.db.run("DROP TRIGGER fail_continuation_release")
  await run(f.app.pump())
  expect(await run(f.mailbox.task(request.id))).toMatchObject({
    resumed: true,
    control: { owner: null },
  })
  expect(f.db.all("SELECT * FROM resumed")).toHaveLength(1)
})

it("reads mailbox recovery only after reconciling its queue and defaults to no recovery", async () => {
  const empty = await fixture()
  expect(await run(empty.app.read())).toHaveProperty("recovery", null)
  const order: string[] = []
  const f = await fixture({
    reconcileQueue: () =>
      Effect.sync(() => {
        order.push("reconcile")
      }),
    recovery: () =>
      Effect.sync(() => {
        order.push("recovery")
        return null
      }),
  })
  const tasks = f.mailbox.tasks
  const deliveries = f.mailbox.deliveries
  vi.spyOn(f.mailbox, "tasks").mockImplementation(() =>
    Effect.sync(() => {
      order.push("tasks")
    }).pipe(Effect.andThen(tasks()))
  )
  vi.spyOn(f.mailbox, "deliveries").mockImplementation(() =>
    Effect.sync(() => {
      order.push("deliveries")
    }).pipe(Effect.andThen(deliveries()))
  )
  expect(await run(f.app.read())).toHaveProperty("recovery", null)
  expect(order[0]).toBe("reconcile")
  expect(order).toEqual(
    expect.arrayContaining(["tasks", "deliveries", "recovery"])
  )
})

it("retains an idle mailbox recovery after three scan failures without claiming unrelated tasks", async () => {
  let queue: ReturnType<typeof applicationRunner>
  const f = await fixture({
    armMailbox: () => Effect.promise(() => queue.runner.armDiscovery()),
    wake: () => Effect.promise(() => queue.runner.wake()),
    recovery: () => Effect.promise(() => queue.runner.recovery()),
    reconcileQueue: () => Effect.promise(() => queue.runner.reconcileQueue()),
    armRecovery: (epoch) =>
      Effect.promise(() => queue.runner.armRecovery(epoch)),
    retryRecovery: (epoch, deadline) =>
      Effect.promise(() => queue.runner.retryRecovery(epoch, deadline)),
  })
  queue = applicationRunner(f)
  const request = await run(f.app.delegate(brief, source))
  const original = await run(f.mailbox.task(request.id))
  const originalDiscovery = queue.jobs.get("bot-communication:recovery")!
  const originalToken = (originalDiscovery.payload as { token: string }).token
  await queue.runner.onJob({ job: originalDiscovery, attempt: 1 })
  const claim = vi.spyOn(f.mailbox, "claimTask")
  const scan = vi
    .spyOn(f.mailbox, "pending")
    .mockReturnValue(
      Effect.fail(failure("storage", "Mailbox scan unavailable"))
    )
  const job = queue.pump()
  for (let attempt = 1; attempt <= 3; attempt++)
    await expect(queue.runner.onJob({ job, attempt })).rejects.toThrow()
  expect(
    await queue.runner.onJobError(
      { job, attempt: 3 },
      new Error("Mailbox scan unavailable")
    )
  ).toBeUndefined()
  queue.jobs.delete(job.id)
  expect(claim).not.toHaveBeenCalled()
  expect(await run(f.mailbox.task(request.id))).toEqual(original)
  const recovery = await queue.runner.recovery()
  expect(recovery).toMatchObject({
    schemaVersion: 1,
    workflowVersion: 1,
    epoch: expect.any(String),
    failedAt: expect.any(Number),
    discoveryToken: originalToken,
    message: expect.any(String),
  })
  expect(recovery?.message.length).toBeGreaterThan(0)
  expect([...queue.stored.values()]).toContainEqual(
    expect.objectContaining({ recovery })
  )
  expect(queue.jobs.size).toBe(0)

  for (let read = 0; read < 3; read++) {
    expect(await run(f.app.read())).toHaveProperty("recovery", recovery)
    await queue.runner.reconcileQueue()
    expect(queue.jobs.size).toBe(0)
  }
  expect(await run(f.mailbox.task(request.id))).toEqual(original)

  const stale = await run(
    Effect.exit(f.app.retryMailbox("obsolete-recovery-epoch"))
  )
  expect(Exit.isFailure(stale)).toBe(true)
  expect(await queue.runner.recovery()).toEqual(recovery)
  expect(queue.jobs.size).toBe(0)

  scan.mockRestore()
  await run(f.app.retryMailbox(recovery!.epoch))
  expect(await queue.runner.recovery()).toBeNull()
  const discovery = queue.jobs.get("bot-communication:recovery")!
  expect(discovery).toBeDefined()
  expect((discovery.payload as { token: string }).token).not.toBe(originalToken)
  const retried = queue.pump()
  expect(retried).toBeDefined()
  expect(retried.payload).not.toEqual(job.payload)
  await queue.runner.onJob({ job: retried, attempt: 1 })
  expect(await run(f.mailbox.task(request.id))).toMatchObject({
    id: original.id,
    control: original.control,
  })
})

it("explicit result retry replays the joined final-attempt release before renewing its budget", async () => {
  let unavailable = true
  let queue: ReturnType<typeof applicationRunner>
  const f = await fixture({
    prearm: () =>
      unavailable
        ? Effect.fail(failure("storage", "Continuation discovery unavailable"))
        : Effect.succeed(Date.now() + 60000),
    wake: () => Effect.promise(() => queue.runner.wake()),
  })
  queue = applicationRunner(f)
  const request = await run(f.app.delegate(brief, source))
  await f.complete(request.id)
  f.db.run(
    "CREATE TRIGGER fail_final_release BEFORE UPDATE ON communication_tasks WHEN json_extract(OLD.body,'$.control.phase')='continuation' AND json_extract(OLD.body,'$.control.attempts')=3 AND json_extract(OLD.body,'$.control.owner') IS NOT NULL AND json_extract(NEW.body,'$.control.owner') IS NULL BEGIN SELECT RAISE(ABORT,'final joined release unavailable'); END"
  )
  await queue.runner.reconcile()
  const job = queue.pump()
  for (let attempt = 1; attempt <= 3; attempt++)
    await expect(queue.runner.onJob({ job, attempt })).rejects.toThrow()
  await queue.runner.onJobError({ job, attempt: 3 }, new Error("exhausted"))
  queue.jobs.delete(job.id)
  const blocked = await run(f.mailbox.task(request.id))
  expect(blocked.control).toMatchObject({
    attempts: 3,
    unconfirmed: true,
    owner: expect.any(String),
  })
  expect(blocked.resumed).toBe(false)
  f.db.run("DROP TRIGGER fail_final_release")
  unavailable = false
  await run(f.app.retry(request.id))
  expect(await run(f.mailbox.task(request.id))).toMatchObject({
    resumed: false,
    outcome: { text: "Draft A fits." },
    control: { owner: null, attempts: 0, unconfirmed: false },
  })
  await queue.runner.onJob({ job: queue.pump(), attempt: 1 })
  expect(await run(f.mailbox.task(request.id))).toMatchObject({
    resumed: true,
    outcome: { text: "Draft A fits." },
  })
  expect(f.db.all("SELECT * FROM resumed")).toHaveLength(1)
})
