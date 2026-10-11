import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { sqliteMailbox } from "../src/communication/adapters/sqlite"
import {
  LEASE_MS,
  MAX_ATTEMPTS,
  failure,
  type Envelope,
  type Identity,
} from "../src/communication/contracts"
import { MailboxTransport, Mailbox } from "../src/communication/mailbox"
import { deliverNext, receive } from "../src/communication/delivery"
import { database } from "./database"
import { AgentId } from "../src/agents/domain"

const a = Schema.decodeUnknownSync(AgentId)("home")
const b = Schema.decodeUnknownSync(AgentId)(
  "00000000-0000-4000-8000-000000000001"
)
const request = (patch: Partial<Envelope> = {}): Envelope => ({
  version: 1,
  id: "request-1",
  taskId: "request-1",
  owner: "synthetic-owner",
  from: a,
  to: b,
  correlationId: "turn-1",
  causationId: "tool-1",
  createdAt: 1000,
  deadline: 1000000,
  depth: 1,
  payload: {
    kind: "question",
    objective: "What is 2 + 2?",
    context: "A deterministic local fixture.",
  },
  ...patch,
})
const run = Effect.runPromise
function fixture(identity: Identity) {
  const db = database(),
    repository = sqliteMailbox(db)
  const service = Effect.runSync(repository.initialize)
  Effect.runSync(repository.bindIdentity(identity))
  return {
    db,
    service,
    reopen: () => Effect.runSync(sqliteMailbox(db).initialize),
  }
}
const pair = () => ({
  sender: fixture({ owner: "synthetic-owner", bot: a }),
  recipient: fixture({ owner: "synthetic-owner", bot: b }),
})

describe("durable bot mailbox", () => {
  it("commits acceptance once across concurrent duplicate deliveries and reopen", async () => {
    const { sender, recipient } = pair(),
      e = request()
    await run(sender.service.enqueue(e, 1000))
    expect(await run(sender.reopen().prove(e))).toBe(true)
    const receipts = await run(
      Effect.all(
        Array.from({ length: 8 }, () => recipient.service.accept(e, 1010)),
        { concurrency: 8 }
      )
    )
    expect(
      receipts.every((r) => JSON.stringify(r) === JSON.stringify(receipts[0]))
    ).toBe(true)
    expect(await run(recipient.reopen().tasks())).toHaveLength(1)
    expect(await run(recipient.reopen().accept(e, 2000000))).toEqual(
      receipts[0]
    )
    const bad = {
      ...e,
      payload: { ...e.payload, objective: "Different content" },
    }
    const result = await run(
      recipient.service.accept(bad, 1010).pipe(Effect.result)
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { code: "conflict" },
    })
  })

  it("requires exact committed sender proof and recipient ownership", async () => {
    const { sender, recipient } = pair(),
      e = request()
    const transport = Layer.succeed(MailboxTransport, {
      deliver: () => Effect.fail(failure("transport", "unused")),
      permitted: () => Effect.succeed(true),
      authenticate: (input) =>
        Effect.gen(function* () {
          if (!(yield* sender.service.prove(input)))
            yield* Effect.fail(failure("forbidden", "No proof"))
        }),
    })
    const invoke = (envelope: Envelope) =>
      receive(envelope).pipe(
        Effect.provide(
          Layer.merge(transport, Layer.succeed(Mailbox, recipient.service))
        ),
        Effect.result
      )
    expect(await run(invoke(e))).toMatchObject({
      _tag: "Failure",
      failure: { code: "forbidden" },
    })
    expect(
      await run(
        recipient.service
          .accept({ ...e, owner: "other-owner" }, 1010)
          .pipe(Effect.result)
      )
    ).toMatchObject({ _tag: "Failure", failure: { code: "forbidden" } })
    expect(await run(recipient.service.tasks())).toHaveLength(0)
  })

  it("recovers sender lease after lost acknowledgment without duplicate recipient admission", async () => {
    const { sender, recipient } = pair(),
      e = request()
    await run(sender.service.enqueue(e, 1000))
    const first = (await run(sender.service.claimDelivery(1000)))!
    const receipt = await run(recipient.service.accept(e, 1001))
    expect(await run(sender.reopen().claimDelivery(1001))).toBeUndefined()
    const second = (await run(sender.reopen().claimDelivery(1000 + LEASE_MS)))!
    expect(second.attempts).toBe(first.attempts + 1)
    expect(
      await run(recipient.reopen().accept(second.envelope, 40000))
    ).toEqual(receipt)
    await run(sender.service.delivered(e.id, first.attempts, receipt))
    expect((await run(sender.service.deliveries()))[0]!.status).toBe(
      "delivering"
    )
    await run(sender.service.delivered(e.id, second.attempts, receipt))
    expect((await run(sender.service.deliveries()))[0]!.status).toBe("accepted")
    expect(await run(recipient.service.tasks())).toHaveLength(1)
  })

  it("atomically seals the result and outgoing message, and fences stale executions", async () => {
    const { sender, recipient } = pair(),
      e = request()
    await run(sender.service.enqueue(e, 1000))
    await run(recipient.service.accept(e, 1001))
    const first = (await run(recipient.service.claimTask(1010)))!
    const recovered = (await run(
      recipient.reopen().claimTask(1010 + LEASE_MS)
    ))!
    expect(
      await run(
        recipient.service
          .finish(
            e.taskId,
            first.revision,
            { status: "completed", text: "4" },
            40000
          )
          .pipe(Effect.result)
      )
    ).toMatchObject({ _tag: "Failure", failure: { code: "stale" } })
    await run(
      recipient.service.finish(
        e.taskId,
        recovered.revision,
        { status: "completed", text: "4" },
        40001
      )
    )
    const out = (await run(recipient.reopen().deliveries()))[0]!
    expect((await run(recipient.reopen().task(e.taskId))).outcome?.text).toBe(
      "4"
    )
    await run(sender.reopen().accept(out.envelope, 40002))
    expect((await run(sender.service.task(e.taskId))).status).toBe("completed")
    expect(await run(recipient.service.claimTask(90000))).toBeUndefined()
  })

  it("rolls back completion if its result outbox cannot be written", async () => {
    const { recipient } = pair(),
      e = request()
    await run(recipient.service.accept(e, 1001))
    const claimed = (await run(recipient.service.claimTask(1010)))!
    recipient.db.run(
      "CREATE TRIGGER fail_result BEFORE INSERT ON communication_outbox BEGIN SELECT RAISE(ABORT,'fixture failure'); END"
    )
    expect(
      await run(
        recipient.service
          .finish(
            e.taskId,
            claimed.revision,
            { status: "completed", text: "4" },
            1011
          )
          .pipe(Effect.result)
      )
    ).toMatchObject({ _tag: "Failure", failure: { code: "storage" } })
    expect((await run(recipient.service.task(e.taskId))).status).toBe("running")
    expect(await run(recipient.service.deliveries())).toHaveLength(0)
  })

  it("retains cancellation arriving before the request and never starts that work", async () => {
    const { sender, recipient } = pair(),
      e = request()
    await run(sender.service.enqueue(e, 1000))
    await run(sender.service.cancel(e.taskId, 1010))
    const cancellation = (await run(sender.service.deliveries())).find(
      (d) => d.envelope.payload.kind === "cancel"
    )!
    await run(recipient.service.accept(cancellation.envelope, 1020))
    await run(recipient.reopen().accept(e, 1030))
    expect((await run(recipient.service.task(e.taskId))).status).toBe(
      "cancelled"
    )
    expect(await run(recipient.service.claimTask(1040))).toBeUndefined()
    expect(
      (await run(recipient.service.deliveries()))[0]!.envelope.payload.kind
    ).toBe("result")
  })

  it("bounds fan-out, deadline and retry exhaustion without forgetting receipts", async () => {
    const { sender, recipient } = pair()
    for (let n = 0; n < 3; n++)
      await run(
        sender.service.enqueue(
          request({ id: `request-${n}`, taskId: `request-${n}` }),
          1000
        )
      )
    expect(
      await run(
        sender.service
          .enqueue(request({ id: "excess", taskId: "excess" }), 1000)
          .pipe(Effect.result)
      )
    ).toMatchObject({ _tag: "Failure", failure: { code: "limit" } })
    expect(
      await run(
        recipient.service.accept(request({ to: a }), 1000).pipe(Effect.result)
      )
    ).toMatchObject({ _tag: "Failure" })
    expect(
      await run(
        recipient.service
          .accept(request({ deadline: 2000 }), 3000)
          .pipe(Effect.result)
      )
    ).toMatchObject({ _tag: "Failure", failure: { code: "expired" } })
    const single = pair().sender
    await run(single.service.enqueue(request(), 1000))
    for (let n = 0; n < MAX_ATTEMPTS; n++) {
      const d = (await run(single.service.claimDelivery(1000 + n * 1000)))!
      await run(
        single.service.deliveryFailed(
          d.envelope.id,
          d.attempts,
          1000 + n * 1000,
          1000,
          false
        )
      )
    }
    expect((await run(single.service.deliveries()))[0]!.status).toBe("failed")
    expect(await run(single.service.claimDelivery(100000))).toBeUndefined()
  })

  it("the Effect pump preserves a delivery identity when transport fails", async () => {
    const { sender } = pair(),
      now = Date.now(),
      e = request({ createdAt: now, deadline: now + 60000 })
    await run(sender.service.enqueue(e, now))
    const layer = Layer.merge(
      Layer.succeed(Mailbox, sender.service),
      Layer.succeed(MailboxTransport, {
        permitted: () => Effect.succeed(true),
        authenticate: () => Effect.void,
        deliver: () => Effect.fail(failure("transport", "lost acknowledgment")),
      })
    )
    await run(deliverNext().pipe(Effect.provide(layer)))
    const d = (await run(sender.service.deliveries()))[0]!
    expect(d.envelope.id).toBe(e.id)
    expect(d.attempts).toBe(1)
    expect(d.status).toBe("pending")
    expect(d.nextAt! - now).toBeGreaterThanOrEqual(750)
  })
})

it("enforces lifetime per-turn fan-out atomically even when previous tasks completed", async () => {
  const { sender, recipient } = pair()
  for (let n = 0; n < 2; n++) {
    const e = request({ id: `prior-${n}`, taskId: `prior-${n}` })
    await run(sender.service.enqueue(e, 1000))
    await run(recipient.service.accept(e, 1001))
    const claim = (await run(recipient.service.claimTask(1002)))!
    await run(
      recipient.service.finish(
        e.id,
        claim.revision,
        { status: "completed", text: "4" },
        1003
      )
    )
    const result = (await run(recipient.service.deliveries())).find(
      (d) => d.envelope.taskId === e.id
    )!
    await run(sender.service.accept(result.envelope, 1004))
  }
  const attempts = await run(
    Effect.all(
      [2, 3].map((n) =>
        sender.service
          .enqueue(request({ id: `racing-${n}`, taskId: `racing-${n}` }), 1010)
          .pipe(Effect.result)
      ),
      { concurrency: 2 }
    )
  )
  expect(attempts.filter((attempt) => attempt._tag === "Success")).toHaveLength(
    1
  )
  expect(await run(sender.service.byTurn("turn-1"))).toHaveLength(3)
})

it("fences acknowledgments across manual retries and refuses a mismatched receipt", async () => {
  const { sender } = pair(),
    e = request()
  await run(sender.service.enqueue(e, 1000))
  const old = (await run(sender.service.claimDelivery(1000)))!
  await run(sender.service.deliveryFailed(e.id, old.attempts, 1001, 100, true))
  await run(sender.service.retry(e.id, 1002))
  const fresh = (await run(sender.service.claimDelivery(1002)))!
  const receipt = { id: e.id, taskId: e.taskId, acceptedAt: 1003 }
  await run(sender.service.delivered(e.id, old.attempts, receipt))
  expect((await run(sender.service.deliveries()))[0]!.status).toBe("delivering")
  expect(
    await run(
      sender.service
        .delivered(e.id, fresh.attempts, { ...receipt, taskId: "wrong" })
        .pipe(Effect.result)
    )
  ).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } })
  await run(sender.service.delivered(e.id, fresh.attempts, receipt))
  expect((await run(sender.service.deliveries()))[0]!.status).toBe("accepted")
})

it("makes deadline expiry terminal and retains its original receipt; cancellation fences the running claim", async () => {
  const { sender, recipient } = pair(),
    e = request({ deadline: 2000 })
  await run(sender.service.enqueue(e, 1000))
  await run(recipient.service.accept(e, 1001))
  const active = (await run(recipient.service.claimTask(1002)))!
  const expired = (await run(recipient.service.claimTask(2000)))!
  expect(expired.revision).toBeGreaterThan(active.revision)
  await run(
    recipient.service.finish(
      e.id,
      expired.revision,
      { status: "expired", text: "Deadline passed." },
      2000
    )
  )
  await run(sender.service.expire(2001))
  await run(sender.service.claimDelivery(2001))
  expect((await run(sender.service.task(e.id))).status).toBe("expired")
  expect(
    await run(sender.service.retry(e.id, 2002).pipe(Effect.result))
  ).toMatchObject({ _tag: "Failure", failure: { code: "expired" } })
  expect((await run(recipient.service.accept(e, 3000))).acceptedAt).toBe(1001)
})

it("reserves result capacity beyond retained request deliveries", async () => {
  const { recipient } = pair()
  await run(recipient.service.accept(request(), 1001))
  const claimed = (await run(recipient.service.claimTask(1010)))!
  // Historical outbox volume at the former shared 10k cap must not strand
  // an already accepted task. Terminal messages have reserved capacity.
  recipient.db
    .run(`WITH RECURSIVE retained(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM retained WHERE n<10000)
    INSERT INTO communication_outbox(id,body,status,next_at) SELECT 'old-'||n,'{}','accepted',0 FROM retained`)
  await run(
    recipient.service.finish(
      claimed.id,
      claimed.revision,
      { status: "completed", text: "4" },
      1011
    )
  )
  expect((await run(recipient.service.task(claimed.id))).status).toBe(
    "completed"
  )
  expect(
    recipient.db.all<{ n: number }>(
      "SELECT count(*) AS n FROM communication_outbox"
    )[0]!.n
  ).toBe(10001)
})

it("keeps old unfinished work and all deliveries for each inspected task together", async () => {
  const { sender } = pair()
  await run(sender.service.enqueue(request(), 1000))
  const pending = await run(sender.service.task("request-1"))
  const original = (await run(sender.service.deliveries()))[0]!
  for (let n = 0; n < 110; n++) {
    const id = `history-${n}`
    const saved = {
      ...pending,
      id,
      status: "completed",
      resumed: true,
      request: { ...pending.request, id, taskId: id },
      outcome: { status: "completed", text: "saved" },
    }
    sender.db.run(
      "INSERT INTO communication_tasks(id,body,status,lease_until,deadline,direction) VALUES (?,?,?,NULL,?,?)",
      id,
      JSON.stringify(saved),
      "completed",
      saved.request.deadline,
      "outgoing"
    )
    for (const suffix of ["", "cancel:"]) {
      const envelope = { ...original.envelope, id: suffix + id, taskId: id }
      sender.db.run(
        "INSERT INTO communication_outbox(id,body,status,next_at) VALUES (?,?,?,?)",
        envelope.id,
        JSON.stringify({ ...original, envelope, status: "accepted" }),
        "accepted",
        0
      )
    }
  }
  const tasks = await run(sender.service.tasks()),
    deliveries = await run(sender.service.deliveries())
  expect(tasks).toHaveLength(100)
  expect(tasks.some((t) => t.id === pending.id)).toBe(true)
  expect(
    deliveries.filter((d) => d.envelope.taskId === pending.id)
  ).toHaveLength(1)
  for (const task of tasks.filter((t) => t.id !== pending.id))
    expect(
      deliveries.filter((d) => d.envelope.taskId === task.id)
    ).toHaveLength(2)
  expect(
    deliveries.every((d) => tasks.some((t) => t.id === d.envelope.taskId))
  ).toBe(true)
})

it("rejects request identities which would not leave room for terminal message prefixes", async () => {
  const { sender } = pair(),
    id = "x".repeat(161)
  expect(
    await run(
      sender.service
        .enqueue(request({ id, taskId: id }), 1000)
        .pipe(Effect.result)
    )
  ).toMatchObject({ _tag: "Failure", failure: { code: "invalid" } })
  expect(await run(sender.service.tasks())).toHaveLength(0)
})

it("never hides live incoming jobs behind an unresumed result backlog during restart", async () => {
  const { recipient } = pair()
  const prototype = {
    id: "historical",
    direction: "outgoing",
    request: request({ from: b, to: a }),
    status: "completed",
    outcome: { status: "completed", text: "Saved" },
    revision: 1,
    leaseUntil: null,
    resumed: false,
    cancelRequested: false,
  }
  for (let n = 0; n < 110; n++) {
    const id = `backlog-${n}`,
      saved = {
        ...prototype,
        id,
        request: { ...prototype.request, id, taskId: id },
      }
    recipient.db.run(
      "INSERT INTO communication_tasks(id,body,status,lease_until,deadline,direction) VALUES (?,?,?,NULL,?,?)",
      id,
      JSON.stringify(saved),
      "completed",
      saved.request.deadline,
      "outgoing"
    )
  }
  await run(recipient.service.accept(request(), 1000))
  const running = (await run(recipient.service.claimTask(1001)))!
  const recovered = await run(recipient.reopen().pending())
  expect(recovered).toHaveLength(100)
  expect(recovered[0]?.id).toBe(running.id)
  expect(recovered[0]?.status).toBe("running")
})
