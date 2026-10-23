import { sql } from "drizzle-orm"
import { Clock, Deferred, Effect, Fiber, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { AgentId } from "../src/agents/domain"
import {
  migrateCommunication,
  sqliteMailbox,
} from "../src/communication/adapters/sqlite"
import {
  LEASE_MS,
  canonicalEnvelope,
  type Envelope,
  type TaskRelease,
} from "../src/communication/contracts"
import { advanceTask, newTask } from "../src/communication/task.machine"
import { database } from "./database"

const request: Envelope = {
  version: 1,
  id: "ownership",
  taskId: "ownership",
  owner: "owner",
  from: Schema.decodeUnknownSync(AgentId)("home"),
  to: Schema.decodeUnknownSync(AgentId)("00000000-0000-4000-8000-000000000001"),
  correlationId: "turn",
  causationId: "tool",
  createdAt: 1000,
  deadline: 100000,
  depth: 1,
  payload: { kind: "question", objective: "Test", context: "" },
}
const liveClock = Effect.runSync(Clock.Clock)
const testClock: Clock.Clock = {
  currentTimeNanos: liveClock.currentTimeNanos,
  currentTimeNanosUnsafe: () => liveClock.currentTimeNanosUnsafe(),
  monotonicTimeNanos: liveClock.monotonicTimeNanos,
  monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
  sleep: (duration) => liveClock.sleep(duration),
  currentTimeMillis: Effect.succeed(1000),
  currentTimeMillisUnsafe: () => 1000,
}
const run = <A, E>(work: Effect.Effect<A, E>) =>
  Effect.runPromise(work.pipe(Effect.provideService(Clock.Clock, testClock)))
function fixture() {
  const db = database(),
    adapter = sqliteMailbox(db)
  Effect.runSync(
    adapter.bindIdentity({ owner: request.owner, bot: request.to })
  )
  return {
    db,
    mailbox: Effect.runSync(adapter.initialize),
    reopen: () => Effect.runSync(sqliteMailbox(db).initialize),
  }
}
const cancel = {
  ...request,
  id: `cancel:${request.id}`,
  causationId: request.id,
  payload: { kind: "cancel" as const, reason: "Stop" },
}
const admit = { discoveryDeadline: 200000 }
const claim = { owner: "first-owner", deadline: 90000 }

describe("durable communication control ownership", () => {
  it("does not steal a warm owner after lease/deadline or cancellation, including reopening the facade", async () => {
    const f = fixture()
    await run(f.mailbox.accept(request, 1000, admit))
    const first = (await run(f.mailbox.claimTask(1001, claim)))!
    expect(first.control.owner).toBe(claim.owner)
    expect(
      await run(
        f.reopen().claimTask(1001 + LEASE_MS, {
          owner: "replacement",
          deadline: 120000,
        })
      )
    ).toBeUndefined()
    await run(f.mailbox.accept(cancel, 1002))
    expect(
      await run(
        f.mailbox.claimTask(100003, { owner: "replacement", deadline: 120000 })
      )
    ).toBeUndefined()
    expect((await run(f.mailbox.task(request.id))).control.owner).toBe(
      claim.owner
    )
  })
  it("fences stale completion but accepts the matching joined release after cancellation", async () => {
    const f = fixture()
    await run(f.mailbox.accept(request, 1000, admit))
    const first = (await run(f.mailbox.claimTask(1001, claim)))!
    await run(f.mailbox.accept(cancel, 1002))
    const receipt: TaskRelease = {
      taskId: first.id,
      owner: claim.owner,
      revision: first.revision,
      now: 1003,
      outcome: { status: "completed", text: "Stale" },
    }
    expect(
      await run(f.mailbox.releaseTask({ ...receipt, owner: "wrong" }))
    ).toBe(false)
    expect(await run(f.mailbox.releaseTask(receipt))).toBe(true)
    const saved = await run(f.mailbox.task(first.id))
    expect(saved.status).toBe("cancelling")
    expect(saved.outcome).toBeNull()
    expect(saved.control.owner).toBeNull()
    expect(await run(f.mailbox.deliveries())).toHaveLength(0)
    expect(
      (
        await run(
          f.mailbox.claimTask(1004, { owner: "stop-owner", deadline: 50000 })
        )
      )?.control.phase
    ).toBe("stop")
  })
  it("rolls back both release and outcome when the result outbox write fails", async () => {
    const f = fixture()
    await run(f.mailbox.accept(request, 1000, admit))
    const first = (await run(f.mailbox.claimTask(1001, claim)))!
    const receipt: TaskRelease = {
      taskId: first.id,
      owner: claim.owner,
      revision: first.revision,
      now: 1002,
      outcome: { status: "completed", text: "Saved" },
    }
    f.db.run(
      "CREATE TRIGGER fail_release BEFORE INSERT ON communication_outbox BEGIN SELECT RAISE(ABORT,'held'); END"
    )
    expect(
      await run(f.mailbox.releaseTask(receipt).pipe(Effect.result))
    ).toMatchObject({ _tag: "Failure", failure: { code: "storage" } })
    expect((await run(f.mailbox.task(first.id))).control.owner).toBe(
      claim.owner
    )
    f.db.run("DROP TRIGGER fail_release")
    expect(await run(f.mailbox.releaseTask(receipt))).toBe(true)
    expect(await run(f.mailbox.releaseTask(receipt))).toBe(false)
    expect((await run(f.mailbox.task(first.id))).outcome?.text).toBe("Saved")
    expect(await run(f.mailbox.deliveries())).toHaveLength(1)
  })
  it("restores ownership only through an explicit cold activation and retains original identity", async () => {
    const f = fixture()
    await run(f.mailbox.accept(request, 1000, admit))
    await run(f.mailbox.claimTask(1001, claim))
    const cold = f.reopen()
    expect(
      await run(cold.claimTask(50000, { owner: "cold", deadline: 90000 }))
    ).toBeUndefined()
    await run(cold.restoreControl(50000))
    const recovered = (await run(
      cold.claimTask(50000, { owner: "cold", deadline: 90000 })
    ))!
    expect(recovered.request).toEqual(request)
    expect(recovered.control).toMatchObject({ owner: "cold", phase: "observe" })
  })
  it("requires discovery for fresh admission but replays exact receipts without renewing it", async () => {
    const f = fixture()
    expect(
      await run(f.mailbox.accept(request, 1000).pipe(Effect.result))
    ).toMatchObject({ _tag: "Failure", failure: { code: "expired" } })
    expect(
      await run(
        f.mailbox
          .accept(request, 1000, { discoveryDeadline: 1000 })
          .pipe(Effect.result)
      )
    ).toMatchObject({ _tag: "Failure", failure: { code: "expired" } })
    const receipt = await run(f.mailbox.accept(request, 1000, admit))
    expect(await run(f.mailbox.accept(request, 300000))).toEqual(receipt)
  })
})

describe("communication version conversion", () => {
  it("atomically converts legacy ownership and preserves inbox bytes and counters", async () => {
    const f = fixture()
    await run(f.mailbox.accept(request, 1000, admit))
    const current = await run(f.mailbox.task(request.id))
    const {
      schemaVersion: _,
      workflowVersion: __,
      control: ___,
      stop: ____,
      ...legacy
    } = current
    const body = JSON.stringify({
      ...legacy,
      status: "running",
      revision: 7,
      leaseUntil: 50000,
    })
    f.db.run(
      "UPDATE communication_tasks SET body=?,status='running',lease_until=50000 WHERE id=?",
      body,
      request.id
    )
    const before = f.db.all("SELECT * FROM communication_inbox")
    await run(migrateCommunication(f.db))
    const saved = await run(f.reopen().task(request.id))
    expect(saved).toMatchObject({
      schemaVersion: 1,
      workflowVersion: 1,
      status: "running",
      revision: 7,
      leaseUntil: 50000,
      control: { owner: null, phase: "observe" },
    })
    expect(f.db.all("SELECT * FROM communication_inbox")).toEqual(before)
  })
  it("rejects future versions and projection drift without rewriting any row", async () => {
    const f = fixture()
    await run(f.mailbox.accept(request, 1000, admit))
    const saved = await run(f.mailbox.task(request.id))
    for (const corrupt of [
      { ...saved, schemaVersion: 99 },
      { ...saved, status: "running" },
    ]) {
      const body = JSON.stringify(corrupt)
      f.db.run(
        "UPDATE communication_tasks SET body=? WHERE id=?",
        body,
        request.id
      )
      expect(
        await run(migrateCommunication(f.db).pipe(Effect.result))
      ).toMatchObject({ _tag: "Failure", failure: { code: "incompatible" } })
      expect(
        f.db.all<{ body: string }>("SELECT body FROM communication_tasks")[0]
          ?.body
      ).toBe(body)
    }
  })
})

it("retains a terminal result while a later Stop acknowledgement changes only its independent fact", async () => {
  const f = fixture()
  await run(f.mailbox.accept(request, 1000, admit))
  const first = (await run(f.mailbox.claimTask(1001, claim)))!
  await run(
    f.mailbox.releaseTask({
      taskId: first.id,
      owner: claim.owner,
      revision: first.revision,
      now: 1002,
      outcome: { status: "failed", text: "Immutable result" },
    })
  )
  const original = (await run(f.mailbox.deliveries()))[0]!
  await run(f.mailbox.accept(cancel, 1003))
  const stop = (await run(
    f.mailbox.claimTask(1003, { owner: "stop", deadline: 50000 })
  ))!
  expect(stop.status).toBe("failed")
  expect(stop.control.phase).toBe("stop")
  expect(
    await run(f.mailbox.claimTask(50000, { owner: "overlap", deadline: 60000 }))
  ).toBeUndefined()
  await run(
    f.mailbox.releaseTask({
      taskId: stop.id,
      owner: "stop",
      revision: stop.revision,
      now: 50001,
      stop: "confirmed",
      outcome: { status: "cancelled", text: "Late Stop" },
    })
  )
  expect(await run(f.mailbox.task(first.id))).toMatchObject({
    status: "failed",
    outcome: { text: "Immutable result" },
    stop: { status: "confirmed" },
  })
  expect((await run(f.mailbox.deliveries()))[0]).toEqual(original)
})

it("bounds Stop attempts separately from normal control failures without wake replenishment", async () => {
  const f = fixture()
  await run(f.mailbox.accept(request, 1000, admit))
  await run(f.mailbox.accept(cancel, 1001))
  let now = 1001
  for (let attempt = 1; attempt <= 5; attempt++) {
    const owner = `stop-${attempt}`
    const task = (await run(
      f.mailbox.claimTask(now, { owner, deadline: now + LEASE_MS })
    ))!
    expect(task.stop.attempts).toBe(attempt)
    await run(
      f.mailbox.releaseTask({
        taskId: task.id,
        owner,
        revision: task.revision,
        now: now + 1,
        failed: true,
      })
    )
    const saved = await run(f.mailbox.task(task.id))
    now = saved.stop.nextAt ?? now + LEASE_MS
  }
  const exhausted = await run(f.mailbox.task(request.id))
  expect(exhausted.stop).toMatchObject({
    status: "unconfirmed",
    attempts: 5,
    nextAt: null,
  })
  expect(
    await run(
      f.mailbox.claimTask(now + LEASE_MS, {
        owner: "extra",
        deadline: now + 2 * LEASE_MS,
      })
    )
  ).toBeUndefined()
  await run(f.reopen().accept(cancel, now + LEASE_MS))
  expect((await run(f.mailbox.task(request.id))).stop).toEqual(exhausted.stop)
})

it("bounds failed native control and preserves its unconfirmed fact through cold restore", async () => {
  const f = fixture()
  await run(f.mailbox.accept(request, 1000, admit))
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = 1001 + attempt * (LEASE_MS + 1),
      owner = `failed-${attempt}`
    const task = (await run(
      f.mailbox.claimTask(now, { owner, deadline: now + LEASE_MS })
    ))!
    await run(
      f.mailbox.releaseTask({
        taskId: task.id,
        owner,
        revision: task.revision,
        now: now + 1,
        failed: true,
      })
    )
  }
  expect((await run(f.mailbox.task(request.id))).control).toMatchObject({
    attempts: 3,
    unconfirmed: true,
    owner: null,
  })
  await run(f.mailbox.restoreControl(95000))
  expect(
    await run(f.mailbox.claimTask(95000, { owner: "extra", deadline: 100000 }))
  ).toBeUndefined()
})

it("checks the runner token inside exhaustion and keeps the current owner until joined release", async () => {
  const f = fixture()
  await run(f.mailbox.accept(request, 1000, admit))
  const task = (await run(f.mailbox.claimTask(1001, claim)))!
  const attempt = {
    taskId: task.id,
    owner: claim.owner,
    revision: task.revision,
    phase: task.control.phase,
  }
  expect(await run(f.mailbox.exhaustControl(attempt, 1002, () => false))).toBe(
    false
  )
  expect((await run(f.mailbox.task(task.id))).revision).toBe(task.revision)
  expect(await run(f.mailbox.exhaustControl(attempt, 1002, () => true))).toBe(
    true
  )
  expect((await run(f.mailbox.task(task.id))).control.owner).toBe(claim.owner)
  expect(await run(f.mailbox.releaseTask({ ...attempt, now: 1003 }))).toBe(true)
  expect((await run(f.mailbox.task(task.id))).control.unconfirmed).toBe(true)
})

it("converts every legacy business and delivery state without changing identities, times, counters or receipt bytes", async () => {
  const f = fixture()
  const states = [
    "accepted",
    "running",
    "waiting",
    "cancelling",
    "completed",
    "failed",
    "expired",
    "cancelled",
    "awaiting_input",
  ] as const
  const rows: { id: string; body: string }[] = []
  for (const [index, status] of states.entries()) {
    const id = `legacy-${status}`
    const terminal = index >= 4
    const value = {
      id,
      direction: status === "waiting" ? "outgoing" : "incoming",
      request: { ...request, id, taskId: id },
      status,
      outcome: terminal ? { status, text: `Saved ${status}` } : null,
      revision: 7,
      leaseUntil: status === "running" ? 40000 : null,
      resumed: status === "completed",
      cancelRequested: status === "cancelling" || status === "expired",
    }
    const body = JSON.stringify(value)
    f.db.run(
      "INSERT INTO communication_tasks(id,body,status,lease_until,deadline,direction) VALUES (?,?,?,?,?,?)",
      id,
      body,
      status,
      value.leaseUntil,
      request.deadline,
      value.direction
    )
    rows.push({ id, body })
  }
  for (const status of [
    "pending",
    "delivering",
    "accepted",
    "failed",
    "expired",
  ] as const) {
    const id = `delivery-${status}`
    const nextAt =
      status === "pending" || status === "delivering" ? 15000 : null
    const value = {
      envelope: { ...request, id, taskId: id },
      status,
      attempts: 7,
      attemptLimit: 16,
      nextAt,
      error: status === "failed" ? "Original failure" : null,
      receipt:
        status === "accepted" ? { id, taskId: id, acceptedAt: 5000 } : null,
    }
    f.db.run(
      "INSERT INTO communication_outbox(id,body,status,next_at) VALUES (?,?,?,?)",
      id,
      JSON.stringify(value),
      status,
      nextAt
    )
  }
  const beforeTasks = f.db.all<Record<string, unknown>>(
    "SELECT * FROM communication_tasks"
  )
  const beforeOutbox = f.db.all<Record<string, unknown>>(
    "SELECT * FROM communication_outbox"
  )
  await run(migrateCommunication(f.db))
  for (const [table, before] of [
    ["communication_tasks", beforeTasks],
    ["communication_outbox", beforeOutbox],
  ] as const) {
    const after = f.db.all<Record<string, unknown>>(`SELECT * FROM ${table}`)
    expect(after).toHaveLength(before.length)
    for (const [index, row] of after.entries()) {
      const { body, ...projections } = row
      const { body: previousBody, ...previousProjections } = before[index]!
      expect(projections).toEqual(previousProjections)
      const {
        schemaVersion,
        workflowVersion,
        control: _,
        stop: __,
        ...converted
      } = JSON.parse(String(body)) as Record<string, unknown>
      expect(schemaVersion).toBe(1)
      expect(workflowVersion).toBe(1)
      expect(converted).toEqual(JSON.parse(String(previousBody)))
    }
  }
  expect(await run(f.reopen().task("legacy-running"))).toMatchObject({
    control: { phase: "observe", owner: null },
    revision: 7,
    leaseUntil: 40000,
  })
  expect(await run(f.reopen().task("legacy-cancelled"))).toMatchObject({
    outcome: { status: "cancelled" },
    stop: { status: "unconfirmed" },
  })
  expect(await run(f.reopen().task("legacy-expired"))).toMatchObject({
    outcome: { status: "expired" },
    stop: { status: "unconfirmed" },
  })
})

it("rolls back all conversion writes if a later table mutation fails", async () => {
  const f = fixture()
  const legacy = {
    id: request.id,
    direction: "incoming",
    request,
    status: "accepted",
    outcome: null,
    revision: 0,
    leaseUntil: null,
    resumed: false,
    cancelRequested: false,
  }
  const outbox = {
    envelope: request,
    status: "pending",
    attempts: 0,
    attemptLimit: 8,
    nextAt: 1000,
    error: null,
    receipt: null,
  }
  f.db.run(
    "INSERT INTO communication_tasks(id,body,status,deadline,direction) VALUES (?,?,'accepted',?,'incoming')",
    request.id,
    JSON.stringify(legacy),
    request.deadline
  )
  f.db.run(
    "INSERT INTO communication_outbox(id,body,status,next_at) VALUES (?,?,'pending',1000)",
    request.id,
    JSON.stringify(outbox)
  )
  const beforeTasks = f.db.all("SELECT * FROM communication_tasks"),
    beforeOutbox = f.db.all("SELECT * FROM communication_outbox")
  f.db.run(
    "CREATE TRIGGER fail_conversion BEFORE UPDATE ON communication_outbox BEGIN SELECT RAISE(ABORT,'conversion failure'); END"
  )
  expect(
    await run(migrateCommunication(f.db).pipe(Effect.result))
  ).toMatchObject({ _tag: "Failure", failure: { code: "storage" } })
  expect(f.db.all("SELECT * FROM communication_tasks")).toEqual(beforeTasks)
  expect(f.db.all("SELECT * FROM communication_outbox")).toEqual(beforeOutbox)
})

it("rejects malformed task events rather than admitting a partial transition", () => {
  const task = newTask(request, "incoming")
  expect(() =>
    advanceTask(task, { type: "CLAIM", owner: "bad", deadline: 1000, now: -1 })
  ).toThrow("Invalid communication task event")
  expect(task.revision).toBe(0)
  expect(task.control.owner).toBeNull()
})

it("rolls back inbox, cancellation tombstone and revocation together on a failed acceptance write", async () => {
  const f = fixture()
  await run(f.mailbox.accept(request, 1000, admit))
  const before = await run(f.mailbox.task(request.id))
  f.db.run(
    "CREATE TRIGGER fail_accept BEFORE INSERT ON communication_inbox BEGIN SELECT RAISE(ABORT,'acceptance failure'); END"
  )
  expect(
    await run(f.mailbox.accept(cancel, 1001).pipe(Effect.result))
  ).toMatchObject({ _tag: "Failure", failure: { code: "storage" } })
  expect(await run(f.mailbox.task(request.id))).toEqual(before)
  expect(f.db.all("SELECT * FROM communication_cancellations")).toHaveLength(0)
  expect(f.db.all("SELECT * FROM communication_inbox")).toHaveLength(1)
})

it("checks the current clock after coordinator acquisition so a queued admission cannot use an expired discovery lease", async () => {
  const f = fixture()
  let time = 1000
  const clock: Clock.Clock = {
    ...testClock,
    currentTimeMillis: Effect.sync(() => time),
    currentTimeMillisUnsafe: () => time,
  }
  const entered = Effect.runSync(Deferred.make<void>()),
    release = Effect.runSync(Deferred.make<void>())
  const holder = Effect.runFork(
    f.db.use(() =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release))
      )
    )
  )
  await run(Deferred.await(entered))
  const acceptance = run(
    f.mailbox
      .accept(request, 1000, { discoveryDeadline: 1500 })
      .pipe(Effect.provideService(Clock.Clock, clock), Effect.result)
  )
  time = 2000
  await run(Deferred.succeed(release, undefined))
  await run(Fiber.join(holder))
  expect(await acceptance).toMatchObject({
    _tag: "Failure",
    failure: { code: "expired" },
  })
  expect(await run(f.mailbox.tasks())).toHaveLength(0)
  expect(f.db.all("SELECT * FROM communication_inbox")).toHaveLength(0)
})

it("requires current discovery before extending a failed delivery budget", async () => {
  const db = database(),
    adapter = sqliteMailbox(db)
  await run(adapter.bindIdentity({ owner: request.owner, bot: request.from }))
  const mailbox = await run(adapter.initialize)
  await run(mailbox.enqueue(request, 1000, { discoveryDeadline: 1500 }))
  const delivery = (await run(mailbox.claimDelivery(1000)))!
  await run(
    mailbox.deliveryFailed(request.id, delivery.attempts, 1001, 10, true)
  )
  const before = await run(mailbox.deliveries())
  const clock: Clock.Clock = {
    ...testClock,
    currentTimeMillis: Effect.succeed(2000),
    currentTimeMillisUnsafe: () => 2000,
  }
  expect(
    await run(
      mailbox
        .retry(request.id, 1002, { discoveryDeadline: 1500 })
        .pipe(Effect.provideService(Clock.Clock, clock), Effect.result)
    )
  ).toMatchObject({ _tag: "Failure", failure: { code: "expired" } })
  expect(await run(mailbox.deliveries())).toEqual(before)
  await run(
    mailbox
      .retry(request.id, 2000, { discoveryDeadline: 3000 })
      .pipe(Effect.provideService(Clock.Clock, clock))
  )
  expect((await run(mailbox.deliveries()))[0]).toMatchObject({
    attempts: 1,
    attemptLimit: 9,
    nextAt: 2000,
  })
})

it("enumerates old unresolved native Stop obligations beyond the UI page", async () => {
  const f = fixture()
  const task = newTask(request, "incoming")
  for (let index = 0; index < 110; index++) {
    const id = `retained-stop-${index}`
    const saved = {
      ...task,
      id,
      request: { ...request, id, taskId: id },
      status: "failed",
      outcome: { status: "failed", text: "Saved result" },
      cancelRequested: true,
      stop: {
        status: "unconfirmed",
        attempts: 5,
        deadline: 90000,
        nextAt: null,
      },
    }
    f.db.run(
      "INSERT INTO communication_tasks(id,body,status,lease_until,deadline,direction) VALUES (?,?,'failed',NULL,?,'incoming')",
      id,
      JSON.stringify(saved),
      request.deadline
    )
  }
  expect(await run(f.reopen().tasks())).toHaveLength(100)
  expect(await run(f.reopen().recovery())).toHaveLength(110)
  expect(
    (await run(f.mailbox.recovery())).some(
      (task) => task.id === "retained-stop-0"
    )
  ).toBe(true)
})

describe("receiver cancellation budget", () => {
  const longRequest = { ...request, deadline: 1000000 }
  const delayedCancel = {
    ...cancel,
    createdAt: 2000,
    deadline: 86402000,
  }

  it("starts Stop recovery on delayed acceptance rather than the sender's creation time", async () => {
    const f = fixture()
    await run(f.mailbox.accept(longRequest, 1000, admit))
    const first = (await run(f.mailbox.claimTask(1001, claim)))!
    await run(
      f.mailbox.releaseTask({
        taskId: first.id,
        owner: claim.owner,
        revision: first.revision,
        now: 1002,
      })
    )
    const receipt = await run(f.mailbox.accept(delayedCancel, 302001))
    expect((await run(f.mailbox.task(request.id))).stop).toMatchObject({
      status: "pending",
      attempts: 0,
      deadline: 602001,
      nextAt: 302001,
    })
    const stop = (await run(
      f.mailbox.claimTask(302001, { owner: "delayed-stop", deadline: 332001 })
    ))!
    expect(stop.control.phase).toBe("stop")
    expect(stop.stop.attempts).toBe(1)
    const saved = await run(f.mailbox.task(request.id))
    expect(await run(f.reopen().accept(delayedCancel, 86402001))).toEqual(
      receipt
    )
    expect(await run(f.mailbox.task(request.id))).toEqual(saved)
    expect(
      f.db.all<{ body: string }>(
        "SELECT body FROM communication_cancellations"
      )[0]!.body
    ).toBe(canonicalEnvelope(delayedCancel))
  })

  it("keeps a delayed cancellation tombstone authoritative when the request arrives later", async () => {
    const f = fixture()
    const receipt = await run(f.mailbox.accept(delayedCancel, 302001))
    await run(
      f.reopen().accept(longRequest, 302002, { discoveryDeadline: 400000 })
    )
    const task = await run(f.mailbox.task(request.id))
    expect(task).toMatchObject({
      status: "cancelled",
      cancelRequested: true,
      stop: { status: "confirmed", attempts: 0 },
      control: { owner: null },
    })
    expect(
      await run(
        f.mailbox.claimTask(302003, {
          owner: "must-not-start",
          deadline: 332003,
        })
      )
    ).toBeUndefined()
    expect(await run(f.reopen().accept(delayedCancel, 86402001))).toEqual(
      receipt
    )
    expect(await run(f.mailbox.deliveries())).toHaveLength(1)
    expect(
      f.db.all<{ body: string }>(
        "SELECT body FROM communication_cancellations"
      )[0]!.body
    ).toBe(canonicalEnvelope(delayedCancel))
  })

  it("starts the Stop budget after coordinator acquisition even when the caller timestamp is stale", async () => {
    const f = fixture()
    await run(f.mailbox.accept(longRequest, 1000, admit))
    let now = 2000
    const clock: Clock.Clock = {
      ...testClock,
      currentTimeMillis: Effect.sync(() => now),
      currentTimeMillisUnsafe: () => now,
    }
    const entered = Effect.runSync(Deferred.make<void>()),
      release = Effect.runSync(Deferred.make<void>())
    const holder = Effect.runFork(
      f.db.use(() =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release))
        )
      )
    )
    await run(Deferred.await(entered))
    const acceptance = run(
      f.mailbox
        .accept(delayedCancel, 2000)
        .pipe(Effect.provideService(Clock.Clock, clock))
    )
    now = 302001
    await run(Deferred.succeed(release, undefined))
    await run(Fiber.join(holder))
    await acceptance
    expect((await run(f.mailbox.task(request.id))).stop).toMatchObject({
      status: "pending",
      attempts: 0,
      deadline: 602001,
      nextAt: 302001,
    })
    expect(
      (
        await run(
          f.mailbox.claimTask(302001, {
            owner: "queued-stop",
            deadline: 332001,
          })
        )
      )?.control.phase
    ).toBe("stop")
  })
})

async function continuationFixture() {
  const db = database(),
    adapter = sqliteMailbox(db)
  await run(adapter.bindIdentity({ owner: request.owner, bot: request.from }))
  const mailbox = await run(adapter.initialize)
  await run(mailbox.enqueue(request, 1000, admit))
  const sent = (await run(mailbox.claimDelivery(1000)))!
  await run(
    mailbox.delivered(request.id, sent.attempts, {
      id: request.id,
      taskId: request.id,
      acceptedAt: 1001,
    })
  )
  await run(
    mailbox.accept(
      {
        ...request,
        id: `result:${request.id}`,
        from: request.to,
        to: request.from,
        causationId: request.id,
        createdAt: 1002,
        deadline: 1000000,
        payload: {
          kind: "result",
          outcome: { status: "completed", text: "Saved result" },
        },
      },
      1002,
      admit
    )
  )
  return {
    db,
    mailbox,
    reopen: () => Effect.runSync(sqliteMailbox(db).initialize),
  }
}
const continuationControl = (task: {
  id: string
  revision: number
  control: { owner: string | null }
}) => ({
  taskId: task.id,
  revision: task.revision,
  owner: task.control.owner!,
  phase: "continuation" as const,
})

describe("durable result continuation ownership", () => {
  it("claims before preparation and never replaces a warm continuation owner after its deadline", async () => {
    const f = await continuationFixture()
    const task = (await run(
      f.mailbox.claimContinuation(request.id, 1010, {
        owner: "continuation-1",
        deadline: 31010,
      })
    ))!
    expect(task.control).toMatchObject({
      owner: "continuation-1",
      phase: "continuation",
      attempts: 1,
      unconfirmed: false,
    })
    expect(await run(f.mailbox.nextWake())).toBe(31010)
    expect(
      await run(
        f.reopen().claimContinuation(request.id, 40000, {
          owner: "replacement",
          deadline: 70000,
        })
      )
    ).toBeUndefined()
    expect((await run(f.mailbox.task(request.id))).control.attempts).toBe(1)
  })

  it("persists three failed attempts and retries only that continuation with fresh discovery", async () => {
    const f = await continuationFixture()
    const original = await run(f.mailbox.task(request.id)),
      deliveries = await run(f.mailbox.deliveries())
    for (let n = 1; n <= 3; n++) {
      const task = (await run(
        f.mailbox.claimContinuation(request.id, 1010 + n, {
          owner: `continuation-${n}`,
          deadline: 40000,
        })
      ))!
      expect(task.control.attempts).toBe(n)
      await run(
        f.mailbox.releaseTask({
          ...continuationControl(task),
          now: 1020 + n,
          failed: true,
        })
      )
    }
    expect((await run(f.mailbox.task(request.id))).control).toMatchObject({
      owner: null,
      phase: "continuation",
      attempts: 3,
      unconfirmed: true,
    })
    expect(
      await run(
        f.reopen().claimContinuation(request.id, 50000, {
          owner: "extra",
          deadline: 80000,
        })
      )
    ).toBeUndefined()
    expect(await run(f.mailbox.pending())).toHaveLength(0)
    expect(await run(f.mailbox.nextWake())).toBeUndefined()
    expect(
      await run(f.mailbox.retry(request.id, 50000).pipe(Effect.result))
    ).toMatchObject({ _tag: "Failure", failure: { code: "expired" } })
    await run(f.mailbox.retry(request.id, 50000, { discoveryDeadline: 80000 }))
    const retried = await run(f.mailbox.task(request.id))
    expect(retried.control).toMatchObject({
      owner: null,
      phase: "continuation",
      attempts: 0,
      unconfirmed: false,
    })
    expect(retried.outcome).toEqual(original.outcome)
    expect(retried.request).toEqual(original.request)
    expect(retried.resumed).toBe(false)
    expect(await run(f.mailbox.deliveries())).toEqual(deliveries)
    expect(
      (
        await run(
          f.mailbox.claimContinuation(request.id, 50001, {
            owner: "explicit-retry",
            deadline: 80000,
          })
        )
      )?.control.attempts
    ).toBe(1)
  })

  it("cold restoration retains the consumed continuation budget and seals an interrupted third attempt", async () => {
    const f = await continuationFixture()
    for (let n = 1; n <= 3; n++) {
      const task = (await run(
        f.mailbox.claimContinuation(request.id, 1010 + n, {
          owner: `interrupted-${n}`,
          deadline: 40000,
        })
      ))!
      if (n < 3)
        await run(
          f.mailbox.releaseTask({
            ...continuationControl(task),
            now: 1020 + n,
            failed: true,
          })
        )
    }
    await run(f.reopen().restoreControl(50000))
    expect((await run(f.mailbox.task(request.id))).control).toMatchObject({
      owner: null,
      phase: "continuation",
      attempts: 3,
      unconfirmed: true,
    })
    expect(await run(f.mailbox.nextWake())).toBeUndefined()
    expect(
      await run(
        f.mailbox.claimContinuation(request.id, 50001, {
          owner: "must-not-retry",
          deadline: 80000,
        })
      )
    ).toBeUndefined()
  })

  it("fences continuation consume and releases its joined owner after the consumed revision", async () => {
    const f = await continuationFixture()
    const task = (await run(
      f.mailbox.claimContinuation(request.id, 1010, {
        owner: "consume",
        deadline: 40000,
      })
    ))!
    let admitted = 0
    const admission = {
      transactionGroup: f.db,
      operationId: "continuation-op",
      admit: () =>
        Effect.sync(() => {
          admitted++
          return { kind: "admitted" as const, turnId: "continuation-op" }
        }),
    }
    expect(
      await run(
        f.mailbox
          .resume(request.id, {
            ...admission,
            control: { ...continuationControl(task), owner: "stale" },
          })
          .pipe(Effect.result)
      )
    ).toMatchObject({ _tag: "Failure", failure: { code: "stale" } })
    expect(admitted).toBe(0)
    await run(
      f.mailbox.resume(request.id, {
        ...admission,
        control: continuationControl(task),
      })
    )
    expect(admitted).toBe(1)
    expect((await run(f.mailbox.task(request.id))).resumed).toBe(true)
    expect(
      await run(
        f.mailbox.releaseTask({ ...continuationControl(task), now: 1020 })
      )
    ).toBe(true)
    expect(await run(f.mailbox.task(request.id))).toMatchObject({
      resumed: true,
      outcome: { text: "Saved result" },
      control: { owner: null, phase: "continuation", attempts: 1 },
    })
  })

  it("cannot reset or discard a held continuation but permits unowned source cancellation after exhaustion", async () => {
    const f = await continuationFixture()
    const task = (await run(
      f.mailbox.claimContinuation(request.id, 1010, {
        owner: "held",
        deadline: 40000,
      })
    ))!
    expect(
      await run(f.mailbox.discard(request.id).pipe(Effect.result))
    ).toMatchObject({ _tag: "Failure", failure: { code: "stale" } })
    const attempt = continuationControl(task)
    expect(await run(f.mailbox.exhaustControl(attempt, 1020, () => true))).toBe(
      true
    )
    expect(
      await run(f.mailbox.retry(request.id, 1021, admit).pipe(Effect.result))
    ).toMatchObject({ _tag: "Failure", failure: { code: "stale" } })
    await run(f.mailbox.releaseTask({ ...attempt, now: 1022, failed: true }))
    await run(f.mailbox.discard(request.id))
    expect((await run(f.mailbox.task(request.id))).resumed).toBe(true)
    expect(await run(f.mailbox.nextWake())).toBeUndefined()
  })
})

it("retains a joined continuation release after a persistence failure without consuming another attempt", async () => {
  const f = await continuationFixture()
  const claimed = (await run(
    f.mailbox.claimContinuation(request.id, 1010, {
      owner: "release-receipt",
      deadline: 40000,
    })
  ))!
  const receipt = { ...continuationControl(claimed), now: 1020, failed: true }
  f.db.run(
    "CREATE TRIGGER fail_continuation_release BEFORE UPDATE ON communication_tasks BEGIN SELECT RAISE(ABORT,'release failure'); END"
  )
  expect(
    await run(f.mailbox.releaseTask(receipt).pipe(Effect.result))
  ).toMatchObject({ _tag: "Failure", failure: { code: "storage" } })
  expect((await run(f.mailbox.task(request.id))).control).toMatchObject({
    owner: "release-receipt",
    attempts: 1,
  })
  expect(
    await run(
      f.mailbox.claimContinuation(request.id, 40001, {
        owner: "must-not-overlap",
        deadline: 70000,
      })
    )
  ).toBeUndefined()
  f.db.run("DROP TRIGGER fail_continuation_release")
  expect(await run(f.mailbox.releaseTask(receipt))).toBe(true)
  expect(await run(f.mailbox.releaseTask(receipt))).toBe(false)
  expect((await run(f.mailbox.task(request.id))).control).toMatchObject({
    owner: null,
    attempts: 1,
    unconfirmed: false,
  })
})

it("rolls back continuation admission and consumption together while retaining the claimed owner", async () => {
  const f = await continuationFixture()
  f.db.run("CREATE TABLE continuation_acceptance (id TEXT PRIMARY KEY)")
  const claimed = (await run(
    f.mailbox.claimContinuation(request.id, 1010, {
      owner: "atomic-consume",
      deadline: 40000,
    })
  ))!
  const admission = {
    transactionGroup: f.db,
    operationId: "same-continuation",
    control: continuationControl(claimed),
    admit: () =>
      f.db
        .use((orm) =>
          orm.run(
            sql`INSERT INTO continuation_acceptance(id) VALUES ('same-continuation')`
          )
        )
        .pipe(
          Effect.orDie,
          Effect.as({ kind: "admitted" as const, turnId: "same-continuation" })
        ),
  }
  f.db.run(
    "CREATE TRIGGER fail_continuation_consume BEFORE UPDATE ON communication_tasks BEGIN SELECT RAISE(ABORT,'consume failure'); END"
  )
  expect(
    await run(f.mailbox.resume(request.id, admission).pipe(Effect.result))
  ).toMatchObject({ _tag: "Failure", failure: { code: "storage" } })
  expect(f.db.all("SELECT * FROM continuation_acceptance")).toHaveLength(0)
  expect(await run(f.mailbox.task(request.id))).toMatchObject({
    resumed: false,
    control: { owner: "atomic-consume", attempts: 1 },
  })
  f.db.run("DROP TRIGGER fail_continuation_consume")
  await run(f.mailbox.resume(request.id, admission))
  await run(f.mailbox.resume(request.id, admission))
  expect(f.db.all("SELECT * FROM continuation_acceptance")).toHaveLength(1)
  expect(
    await run(
      f.mailbox.releaseTask({ ...continuationControl(claimed), now: 1020 })
    )
  ).toBe(true)
  expect(await run(f.mailbox.task(request.id))).toMatchObject({
    resumed: true,
    control: { owner: null, attempts: 1 },
  })
})

it("fences stale continuation exhaustion and consumption after cold recovery without refunding the first claim", async () => {
  const f = await continuationFixture()
  const prior = (await run(
    f.mailbox.claimContinuation(request.id, 1010, {
      owner: "prior-activation",
      deadline: 40000,
    })
  ))!
  await run(f.reopen().restoreControl(50000))
  const current = (await run(
    f.mailbox.claimContinuation(request.id, 50000, {
      owner: "current-activation",
      deadline: 80000,
    })
  ))!
  expect(current.control.attempts).toBe(2)
  expect(
    await run(
      f.mailbox.exhaustControl(continuationControl(prior), 50001, () => true)
    )
  ).toBe(false)
  let admitted = false
  const admission = {
    transactionGroup: f.db,
    operationId: "stale-continuation",
    control: continuationControl(prior),
    admit: () =>
      Effect.sync(() => {
        admitted = true
        return { kind: "admitted" as const, turnId: "stale-continuation" }
      }),
  }
  expect(
    await run(f.mailbox.resume(request.id, admission).pipe(Effect.result))
  ).toMatchObject({ _tag: "Failure", failure: { code: "stale" } })
  expect(admitted).toBe(false)
  expect(await run(f.mailbox.task(request.id))).toEqual(current)
})
