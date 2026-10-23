import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { describe, expect, it } from "vitest"

import { homeAgentId } from "../src/agents/domain"
import { EmailStore } from "../src/email/adapters/sqlite"
import { admitReply } from "../src/replies/admission"
import { REPLY_LEASE_MS } from "../src/replies/contracts"
import {
  armReplyRecovery,
  observeReplyRecovery,
  readReplyRecovery,
} from "../src/replies/recovery.machine"
import { WhatsAppStore } from "../src/whatsapp/adapters/sqlite"
import { database } from "./database"

const run = <A>(work: Effect.Effect<A, unknown>) => Effect.runPromise(work)
function fixture() {
  const db = database(),
    email = new EmailStore(db),
    whatsapp = new WhatsAppStore(db)
  const input = {
    id: crypto.randomUUID(),
    fingerprint: "a".repeat(64),
    messageId: "<admit@example.com>",
    sender: "owner@example.com",
    recipient: "private@example.com",
    subject: "Admission",
    references: "",
    body: "Reply",
  }
  const incoming = {
    ...input,
    messageId: "wamid.admit",
    sender: "15550101010",
    threadId: "whatsapp:123456:15550101010",
    timestamp: Date.now(),
  }
  return { db, email, whatsapp, input, incoming }
}

describe("reply admission discovery", () => {
  it("prearms before acceptance, then wakes without changing the accepted identity", async () => {
    const order: string[] = []
    let armed = 0
    const before = Date.now()
    expect(
      await run(
        admitReply({
          arm: (deadline) =>
            Effect.sync(() => {
              order.push("arm")
              armed = deadline
            }),
          accept: (deadline) =>
            Effect.sync(() => {
              order.push("accept")
              expect(deadline).toBe(armed)
              return "same-receipt"
            }),
          wake: Effect.sync(() => {
            order.push("wake")
          }),
        })
      )
    ).toBe("same-receipt")
    expect(order).toEqual(["arm", "accept", "wake"])
    expect(armed).toBeGreaterThanOrEqual(before + REPLY_LEASE_MS)
  })
  it.each(["arm", "accept"] as const)(
    "stops after %s fails, retaining the full failure",
    async (phase) => {
      const order: string[] = []
      const call = (step: string) =>
        Effect.suspend(() => {
          order.push(step)
          return step === phase
            ? Effect.failCause(
                Cause.fromReasons([
                  Cause.makeFailReason("unavailable"),
                  Cause.makeDieReason("storage defect"),
                ])
              )
            : Effect.void
        })
      const exit = await run(
        Effect.exit(
          admitReply({
            arm: () => call("arm"),
            accept: () => call("accept"),
            wake: call("wake"),
          })
        )
      )
      expect(order).toEqual(phase === "arm" ? ["arm"] : ["arm", "accept"])
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasFails(exit.cause)).toBe(true)
        expect(Cause.pretty(exit.cause)).toContain("storage defect")
      }
    }
  )
  it("retains an accepted receipt and its discovery lease when immediate wake fails", async () => {
    const f = fixture()
    let armed = 0
    await expect(
      run(
        admitReply({
          arm: (deadline) =>
            Effect.sync(() => {
              armed = deadline
            }),
          accept: (deadline) => f.email.receive(f.input, 1, deadline),
          wake: Effect.die("wake acknowledgement lost"),
        })
      )
    ).rejects.toThrow("wake acknowledgement lost")
    expect((await run(f.email.get(f.input.id)))?.state).toBe("queued")
    expect(
      observeReplyRecovery(undefined, armed, {
        now: armed,
        pending: true,
        deadline: null,
      })
    ).toEqual([{ type: "wake" }])
    expect(
      await run(
        admitReply({
          arm: () => Effect.void,
          accept: (deadline) => f.email.receive(f.input, 1, deadline),
          wake: Effect.void,
        })
      )
    ).toBe(false)
    expect(f.db.all("SELECT id FROM email_messages")).toEqual([
      { id: f.input.id },
    ])
  })
  it("joins a cancelled admission and preserves late cleanup failure after a commit", async () => {
    const started = Deferred.makeUnsafe<void>(),
      cleaning = Deferred.makeUnsafe<void>(),
      release = Deferred.makeUnsafe<void>()
    let accepted = false,
      woke = false,
      closed = false
    const exit = await run(
      Effect.gen(function* () {
        const actor = yield* Effect.forkChild(
          admitReply({
            arm: () => Effect.void,
            accept: () =>
              Effect.gen(function* () {
                accepted = true
                yield* Deferred.succeed(started, undefined)
                return yield* Effect.never
              }).pipe(
                Effect.ensuring(
                  Deferred.succeed(cleaning, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(Effect.die("late acceptance cleanup"))
                  )
                )
              ),
            wake: Effect.sync(() => {
              woke = true
            }),
          })
        )
        yield* Deferred.await(started)
        const stopping = yield* Effect.forkChild(
          Fiber.interrupt(actor).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                closed = true
              })
            )
          )
        )
        yield* Deferred.await(cleaning)
        expect(accepted).toBe(true)
        expect(closed).toBe(false)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(stopping)
        return yield* Fiber.await(actor)
      })
    )
    expect(woke).toBe(false)
    expect(closed).toBe(true)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(Cause.pretty(exit.cause)).toContain("late acceptance cleanup")
    }
  })
  it("refuses expired email acceptance, notices and retry before writing receipts", async () => {
    const f = fixture()
    await expect(run(f.email.receive(f.input, 1, 0))).rejects.toMatchObject({
      _tag: "EmailUnavailable",
    })
    expect(await run(f.email.get(f.input.id))).toBeUndefined()
    await run(f.email.receive(f.input, 1, Date.now() + REPLY_LEASE_MS))
    await run(f.email.prepared(f.input.id))
    const parent = (await run(f.email.get(f.input.id)))!
    await expect(
      run(f.email.notice(parent, "approval", "Review", 0))
    ).rejects.toMatchObject({ _tag: "EmailUnavailable" })
    expect(f.db.all("SELECT id FROM email_messages")).toHaveLength(1)
    f.db.run("UPDATE email_messages SET state='failed' WHERE id=?", f.input.id)
    await expect(
      run(f.email.retry(f.input.id, false, crypto.randomUUID(), 0))
    ).rejects.toMatchObject({ _tag: "EmailUnavailable" })
    expect((await run(f.email.get(f.input.id)))?.state).toBe("failed")
    expect(f.db.all("SELECT * FROM email_retries")).toHaveLength(0)
  })
  it("refuses expired WhatsApp acceptance and retry without changing settings or receipts", async () => {
    const f = fixture()
    await run(
      f.whatsapp.configure(
        { operationId: crypto.randomUUID(), enabled: true, revision: 0 },
        homeAgentId
      )
    )
    const settings = await run(f.whatsapp.settings())
    await expect(
      run(
        f.whatsapp.receive(f.incoming, homeAgentId, { route: homeAgentId }, 0)
      )
    ).rejects.toMatchObject({ _tag: "WhatsAppUnavailable" })
    expect(await run(f.whatsapp.settings())).toEqual(settings)
    expect(await run(f.whatsapp.get(f.incoming.id))).toBeUndefined()
    await run(
      f.whatsapp.receive(
        f.incoming,
        homeAgentId,
        {},
        Date.now() + REPLY_LEASE_MS
      )
    )
    await run(
      f.whatsapp.preparationFailed(f.incoming.id, 0, "Preparation failed")
    )
    await expect(
      run(f.whatsapp.retry(f.incoming.id, false, crypto.randomUUID(), 0))
    ).rejects.toMatchObject({ _tag: "WhatsAppUnavailable" })
    expect((await run(f.whatsapp.get(f.incoming.id)))?.state).toBe("failed")
    expect(f.db.all("SELECT * FROM whatsapp_retries")).toHaveLength(0)
  })
  it("rejects a prepared WhatsApp route from an earlier settings generation", async () => {
    const f = fixture()
    await run(
      f.whatsapp.configure(
        { operationId: crypto.randomUUID(), enabled: true, revision: 0 },
        homeAgentId
      )
    )
    const old = await run(f.whatsapp.settings())
    await run(
      f.whatsapp.configure(
        { operationId: crypto.randomUUID(), enabled: false, revision: 1 },
        homeAgentId
      )
    )
    await run(
      f.whatsapp.configure(
        { operationId: crypto.randomUUID(), enabled: true, revision: 2 },
        homeAgentId
      )
    )
    const settings = await run(f.whatsapp.settings())
    await expect(
      run(
        f.whatsapp.receive(
          f.incoming,
          homeAgentId,
          { generation: old.generation, route: homeAgentId },
          Date.now() + REPLY_LEASE_MS
        )
      )
    ).rejects.toMatchObject({ _tag: "WhatsAppRejected" })
    expect(await run(f.whatsapp.settings())).toEqual(settings)
    expect(await run(f.whatsapp.get(f.incoming.id))).toBeUndefined()
  })
})

describe("durable reply discovery lease", () => {
  it("keeps a newer prearmed lease when an earlier empty scan runs", () => {
    const payload = armReplyRecovery(undefined, 1000, 5000)
    const newer = armReplyRecovery(payload, 1000, 3000)
    expect(newer.armedUntil).toBe(5000)
    expect(
      observeReplyRecovery(newer, 1000, {
        now: 1000,
        pending: false,
        deadline: null,
      })
    ).toEqual([{ type: "reschedule", at: 5000 }])
    expect(
      observeReplyRecovery(newer, 5000, {
        now: 5000,
        pending: false,
        deadline: null,
      })
    ).toEqual([])
  })
  it("wakes pending rows while keeping the earliest send recovery or admission deadline", () => {
    const payload = armReplyRecovery(undefined, 1000, 5000)
    expect(
      observeReplyRecovery(payload, 1000, {
        now: 1000,
        pending: true,
        deadline: 2000,
      })
    ).toEqual([{ type: "wake" }, { type: "reschedule", at: 2000 }])
    expect(
      observeReplyRecovery(payload, 2000, {
        now: 2000,
        pending: false,
        deadline: 9000,
      })
    ).toEqual([{ type: "reschedule", at: 5000 }])
    expect(
      observeReplyRecovery(payload, 5000, {
        now: 5000,
        pending: false,
        deadline: 4000,
      })
    ).toEqual([{ type: "reschedule", at: 5000 }])
  })
  it("restores legacy job deadlines and rejects incompatible or malformed data/events", () => {
    expect(readReplyRecovery(null, 1000)).toEqual({
      schemaVersion: 1,
      workflowVersion: 1,
      armedUntil: 1000,
    })
    for (const saved of [
      { schemaVersion: 2, workflowVersion: 1, armedUntil: 1000 },
      { schemaVersion: 1, workflowVersion: 2, armedUntil: 1000 },
      { schemaVersion: 1, workflowVersion: 1, armedUntil: -1 },
    ])
      expect(() => readReplyRecovery(saved, 1000)).toThrow()
    expect(() => armReplyRecovery(null, 1000, -1)).toThrow()
    expect(() =>
      observeReplyRecovery(null, 1000, {
        now: NaN,
        pending: false,
        deadline: null,
      })
    ).toThrow()
  })
})

describe.each(["email", "whatsapp"] as const)(
  "%s delayed approval notice",
  (channel) => {
    it("cannot admit a notice after its original parent was cancelled", async () => {
      const f = fixture()
      if (channel === "whatsapp")
        await run(
          f.whatsapp.configure(
            { operationId: crypto.randomUUID(), enabled: true, revision: 0 },
            homeAgentId
          )
        )
      await run(
        channel === "email"
          ? f.email
              .receive(f.input, 1, Date.now() + REPLY_LEASE_MS)
              .pipe(Effect.orDie)
          : f.whatsapp
              .receive(f.incoming, homeAgentId, {}, Date.now() + REPLY_LEASE_MS)
              .pipe(Effect.orDie)
      )
      const store = channel === "email" ? f.email : f.whatsapp
      await run(store.prepared(f.input.id))
      const emailParent = await run(f.email.get(f.input.id)),
        whatsappParent = await run(f.whatsapp.get(f.input.id))
      const started = Deferred.makeUnsafe<void>(),
        release = Deferred.makeUnsafe<void>()
      const pending = run(
        admitReply({
          arm: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release))
            ),
          accept: (deadline) =>
            channel === "email"
              ? f.email
                  .notice(emailParent!, "approval", "Review", deadline)
                  .pipe(Effect.orDie)
              : f.whatsapp
                  .notice(
                    whatsappParent!,
                    {
                      ...f.incoming,
                      id: crypto.randomUUID(),
                      messageId: "approval:held",
                    },
                    "Review",
                    deadline
                  )
                  .pipe(Effect.orDie),
          wake: Effect.void,
        })
      )
      await run(Deferred.await(started))
      await run(
        store.cancel(f.input.id, "Cancelled while notice was preparing")
      )
      await run(Deferred.succeed(release, undefined))
      await pending
      expect(f.db.all(`SELECT id FROM ${channel}_messages`)).toEqual([
        { id: f.input.id },
      ])
    })
  }
)
