import { Effect, Layer, Schema } from "effect"
import { expect, it } from "vitest"
import {
  makeCommunication,
  continuationId,
  type Host,
} from "../src/communication/communication"
import { sqliteMailbox } from "../src/communication/adapters/sqlite"
import { Mailbox, MailboxTransport } from "../src/communication/mailbox"
import { failure, type Envelope } from "../src/communication/contracts"
import { AgentId } from "../src/agents/domain"
import { database } from "./database"

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
async function fixture() {
  const db = database(),
    repo = sqliteMailbox(db),
    mailbox = Effect.runSync(repo.initialize)
  Effect.runSync(repo.bindIdentity({ owner: "synthetic-owner", bot: a }))
  db.run("CREATE TABLE resumed (id TEXT PRIMARY KEY,task TEXT NOT NULL)")
  let current: ReturnType<Host["current"]> = "done",
    idle = true,
    wakeFails = false,
    admitFails = false,
    preparations = 0
  const host: Host = {
    current: () => current,
    idle: () => idle,
    contacts: () => Effect.succeed([{ id: b, name: "Drafting bot" }]),
    prepare: () =>
      Effect.sync(() => {
        preparations++
      }),
    wake: () =>
      wakeFails
        ? Effect.fail(failure("storage", "Fixture wake failed"))
        : Effect.void,
    wakeConversation: () => Effect.void,
    notify: () => {},
    resume: (task, id) => {
      db.run("INSERT OR IGNORE INTO resumed VALUES (?,?)", id, task.id)
      if (admitFails) throw new Error("Fixture admission crash")
    },
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
    makeCommunication(host, {
      advance: () => Effect.succeed(undefined),
      request: () => Effect.succeed(false),
      inspect: () => Effect.succeed(null),
      pins: () => [],
      pin: () => undefined,
      settled: () => Effect.void,
      restore: () => Effect.void,
    }).pipe(
      Effect.provide(Layer.merge(Layer.succeed(Mailbox, mailbox), transport))
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
  expect(await run(f.app.pump().pipe(Effect.result))).toMatchObject({
    _tag: "Failure",
  })
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
