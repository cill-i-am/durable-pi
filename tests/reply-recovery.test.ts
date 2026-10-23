import { Cause, Clock, Deferred, Effect, Exit, Fiber } from "effect"
import { describe, expect, it } from "vitest"

import { homeAgentId } from "../src/agents/domain"
import { EmailStore } from "../src/email/adapters/sqlite"
import { emailPump } from "../src/email/pump"
import {
  REPLY_LEASE_MS,
  ReplySendFailed,
  type ReplyProgress,
} from "../src/replies/contracts"
import { deliverReply, type ReplyTransport } from "../src/replies/delivery"
import { WhatsAppStore } from "../src/whatsapp/adapters/sqlite"
import { whatsappPump } from "../src/whatsapp/pump"
import { database } from "./database"

async function fixture(channel: "email" | "whatsapp") {
  const db = database()
  const email = new EmailStore(db),
    whatsapp = new WhatsAppStore(db)
  const id = crypto.randomUUID()
  let now = Date.now()
  const liveClock = Effect.runSync(Clock.Clock)
  const clock: Clock.Clock = {
    currentTimeNanos: liveClock.currentTimeNanos,
    currentTimeNanosUnsafe: () => liveClock.currentTimeNanosUnsafe(),
    monotonicTimeNanos: liveClock.monotonicTimeNanos,
    monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
    sleep: (duration) => liveClock.sleep(duration),
    currentTimeMillis: Effect.sync(() => now),
    currentTimeMillisUnsafe: () => now,
  }
  const run = <A>(work: Effect.Effect<A, unknown>) =>
    Effect.runPromise(work.pipe(Effect.provideService(Clock.Clock, clock)))
  if (channel === "email") {
    await run(
      email.receive(
        {
          id,
          fingerprint: "a".repeat(64),
          messageId: "<recovery@example.com>",
          sender: "owner@example.com",
          recipient: "private@example.com",
          subject: "Recovery",
          references: "",
          body: "Reply",
        },
        1,
        Date.now() + 60_000
      )
    )
    await run(email.prepared(id, "Reply"))
  } else {
    await run(
      whatsapp.configure(
        { operationId: crypto.randomUUID(), enabled: true, revision: 0 },
        homeAgentId
      )
    )
    await run(
      whatsapp.receive(
        {
          id,
          fingerprint: "a".repeat(64),
          messageId: "wamid.recovery",
          threadId: "whatsapp:123456:15550101010",
          sender: "15550101010",
          body: "Reply",
          timestamp: now,
        },
        homeAgentId,
        { reply: "Reply" },
        Date.now() + 60_000
      )
    )
  }
  const store: {
    get: (id: string) => Effect.Effect<
      | {
          state: string
          delivery?: ReplyProgress | null
          providerId: string | null
        }
      | undefined,
      unknown
    >
    checkpoint: (
      id: string,
      attemptId: string,
      progress: ReplyProgress
    ) => Effect.Effect<boolean, unknown>
    finish: (
      id: string,
      attemptId: string,
      state: "sent" | "failed" | "uncertain",
      providerId: string | null,
      error: string | null
    ) => Effect.Effect<boolean, unknown>
    exhaustRecovery: () => Effect.Effect<void, unknown>
    recoverAttempt: (
      id: string,
      attemptId: string
    ) => Effect.Effect<boolean, unknown>
    retry: (
      id: string,
      acknowledge: boolean,
      operationId: string,
      discoveryDeadline: number
    ) => Effect.Effect<void, unknown>
  } = channel === "email" ? email : whatsapp
  const record = await run(whatsapp.get(id))
  const progress: ReplyProgress = {
    version: 1,
    generation: 1,
    parts: [
      { text: "first", files: [] },
      { text: "second", files: [] },
    ],
    receipts: [],
  }
  const sends: string[] = [],
    armed: number[] = []
  const faults = {
    arm: false,
    checkpoint: 0,
    afterCheckpoint: 0,
    finish: false,
    recover: false,
  }
  const transport: ReplyTransport<never> = {
    arm: (deadline) =>
      Effect.sync(() => {
        if (faults.arm) throw new Error("arm failed")
        armed.push(deadline)
      }),
    claim: (delivery, from, lease) =>
      channel === "email"
        ? email
            .claim(
              id,
              "Reply",
              () => Effect.succeed(true),
              delivery,
              from,
              lease
            )
            .pipe(Effect.orDie)
        : whatsapp
            .claim(
              record!,
              "Reply",
              () => Effect.succeed(true),
              delivery,
              from,
              lease
            )
            .pipe(Effect.orDie),
    checkpoint: (delivery, attemptId) =>
      Effect.gen(function* () {
        if (delivery.receipts.length === faults.checkpoint)
          throw new Error("checkpoint failed")
        const saved = yield* store
          .checkpoint(id, attemptId, delivery)
          .pipe(Effect.orDie)
        if (delivery.receipts.length === faults.afterCheckpoint)
          throw new Error("checkpoint acknowledgement failed")
        return saved
      }),
    send: (part) =>
      Effect.sync(() => {
        expect(armed.length).toBeGreaterThan(0)
        sends.push(part.text)
        return `provider-${sends.length}`
      }),
    finish: (state, providerId, attemptId) =>
      faults.finish
        ? Effect.die("finish failed")
        : store
            .finish(id, attemptId, state, providerId, null)
            .pipe(Effect.orDie),
    recover: (attemptId) =>
      Effect.suspend(() =>
        faults.recover
          ? Effect.die("recovery write failed")
          : store.recoverAttempt(id, attemptId).pipe(Effect.orDie)
      ),
  }
  const host = {
    armReply: transport.arm,
    active: () => Effect.succeed(true),
    admit: () => Effect.void,
    turn: () => Effect.succeed(undefined),
  }
  const pump =
    channel === "email"
      ? emailPump(email, {
          ...host,
          reviewUrl: () => Effect.succeed("https://pi.example/"),
          send: (_record, text) => transport.send({ text, files: [] }),
        })
      : whatsappPump(whatsapp, {
          ...host,
          name: () => Effect.succeed("Home"),
          reviewUrl: () => "https://pi.example/",
          send: (_record, text) => transport.send({ text, files: [] }),
        })
  return {
    db,
    id,
    store,
    run,
    faults,
    progress,
    transport,
    sends,
    armed,
    read: () =>
      run<
        | {
            state: string
            delivery?: ReplyProgress | null
            providerId: string | null
          }
        | undefined
      >(store.get(id)),
    pump: () => run(pump()),
    deliver: () => run(deliverReply(progress, transport)),
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe.each(["email", "whatsapp"] as const)(
  "%s reply recovery",
  (channel) => {
    it("records retry exhaustion without stealing an active send lease", async () => {
      const f = await fixture(channel)
      await f.run(f.store.exhaustRecovery())
      expect((await f.read())?.state).toBe("failed")
      await f.run(
        f.store.retry(
          f.id,
          false,
          crypto.randomUUID(),
          f.now() + REPLY_LEASE_MS
        )
      )
      expect((await f.read())?.state).toBe("waiting")
      expect(
        await f.run(
          f.transport.claim(f.progress, "waiting", {
            attemptId: "active",
            deadline: f.now() + REPLY_LEASE_MS,
          })
        )
      ).toBe(true)
      await f.run(f.store.exhaustRecovery())
      expect((await f.read())?.state).toBe("sending")
      f.advance(REPLY_LEASE_MS)
      await f.run(f.store.exhaustRecovery())
      expect((await f.read())?.state).toBe("uncertain")
      expect(f.sends).toEqual([])
    })
    it("rejects a changed provider plan or receipt prefix in the real adapter", async () => {
      const f = await fixture(channel)
      await f.run(
        f.transport.claim(f.progress, "waiting", {
          attemptId: "active",
          deadline: f.now() + REPLY_LEASE_MS,
        })
      )
      const first = { ...f.progress, receipts: ["confirmed"] }
      await f.run(f.store.checkpoint(f.id, "active", first))
      await f.run(
        f.transport.claim(first, "sending", {
          attemptId: "active",
          deadline: f.now() + REPLY_LEASE_MS,
        })
      )
      const before = await f.read()
      for (const changed of [
        { ...first, receipts: ["forged", "next"] },
        {
          ...first,
          parts: [{ text: "changed", files: [] }, first.parts[1]!],
          receipts: ["confirmed", "next"],
        },
      ]) {
        await expect(
          f.run(f.store.checkpoint(f.id, "active", changed))
        ).rejects.toThrow("does not extend")
        expect(await f.read()).toEqual(before)
      }
    })
    it("reconciles provider acceptance followed by a lost checkpoint in the same instance without resending", async () => {
      const f = await fixture(channel)
      f.faults.checkpoint = 1
      await expect(f.deliver()).rejects.toThrow("checkpoint failed")
      expect(await f.read()).toMatchObject({
        state: "uncertain",
        delivery: { receipts: [] },
      })
      await f.pump()
      await f.pump()
      expect(f.sends).toEqual(["first"])
      await expect(
        f.run(
          f.store.retry(
            f.id,
            false,
            crypto.randomUUID(),
            f.now() + REPLY_LEASE_MS
          )
        )
      ).rejects.toThrow()
      await f.run(
        f.store.retry(f.id, true, crypto.randomUUID(), f.now() + REPLY_LEASE_MS)
      )
      f.faults.checkpoint = 0
      await f.deliver()
      expect(f.sends).toEqual(["first", "first", "second"])
      expect((await f.read())?.state).toBe("sent")
    })
    it.each(["finish", "last-checkpoint-ack"] as const)(
      "uses saved receipts after %s failure without another provider call",
      async (failure) => {
        const f = await fixture(channel)
        f.faults.finish = failure === "finish"
        f.faults.afterCheckpoint = failure === "last-checkpoint-ack" ? 2 : 0
        await expect(f.deliver()).rejects.toThrow()
        expect(await f.read()).toMatchObject({
          state: "sent",
          providerId: "provider-2",
          delivery: { receipts: ["provider-1", "provider-2"] },
        })
        await f.pump()
        expect(f.sends).toEqual(["first", "second"])
      }
    )
    it("retains a deadline for same-instance discovery when both checkpoint and immediate recovery writes fail", async () => {
      const f = await fixture(channel)
      f.faults.checkpoint = 1
      f.faults.recover = true
      await expect(f.deliver()).rejects.toThrow()
      expect((await f.read())?.state).toBe("sending")
      expect(await f.pump()).toBe(f.armed[0])
      f.advance(REPLY_LEASE_MS)
      expect(await f.pump()).toBeUndefined()
      expect((await f.read())?.state).toBe("uncertain")
      expect(f.sends).toEqual(["first"])
    })
    it("does not claim or dispatch when prearming fails or the armed deadline has already elapsed", async () => {
      const f = await fixture(channel)
      f.faults.arm = true
      await expect(f.deliver()).rejects.toThrow("arm failed")
      expect((await f.read())?.state).toBe("waiting")
      f.faults.arm = false
      const arm = f.transport.arm
      f.transport.arm = (deadline) =>
        arm(deadline).pipe(
          Effect.tap(() => Effect.sync(() => f.advance(REPLY_LEASE_MS)))
        )
      await f.deliver()
      expect((await f.read())?.state).toBe("waiting")
      expect(f.sends).toEqual([])
    })
    it("fences a late checkpoint and finalizer after deadline recovery and an explicit retry", async () => {
      const f = await fixture(channel)
      const first = { attemptId: "old", deadline: Date.now() + REPLY_LEASE_MS }
      await f.run(f.transport.claim(f.progress, "waiting", first))
      f.advance(REPLY_LEASE_MS + 1000)
      await f.pump()
      await f.run(
        f.store.retry(f.id, true, crypto.randomUUID(), f.now() + REPLY_LEASE_MS)
      )
      const next = {
        attemptId: "new",
        deadline: Date.now() + 3 * REPLY_LEASE_MS,
      }
      expect(await f.run(f.transport.claim(f.progress, "waiting", next))).toBe(
        true
      )
      expect(
        await f.run(
          f.store.checkpoint(f.id, "old", { ...f.progress, receipts: ["late"] })
        )
      ).toBe(false)
      await f.run(f.transport.recover("old"))
      expect(await f.read()).toMatchObject({
        state: "sending",
        delivery: { receipts: [] },
      })
    })
    it("joins cancellation cleanup, preserves its defect, and then reconciles the owned send", async () => {
      const f = await fixture(channel)
      const started = Deferred.makeUnsafe<void>(),
        cleaning = Deferred.makeUnsafe<void>(),
        release = Deferred.makeUnsafe<void>()
      f.transport.send = () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Deferred.succeed(cleaning, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Effect.die("provider cleanup failed"))
            )
          )
        )
      const exit = await f.run(
        Effect.gen(function* () {
          const sender = yield* Effect.forkChild(
            deliverReply(f.progress, f.transport)
          )
          yield* Deferred.await(started)
          const stopping = yield* Effect.forkChild(Fiber.interrupt(sender))
          yield* Deferred.await(cleaning)
          expect((yield* f.store.get(f.id))?.state).toBe("sending")
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(stopping)
          return yield* Fiber.await(sender)
        })
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        expect(Cause.pretty(exit.cause)).toContain("provider cleanup failed")
      }
      expect((await f.read())?.state).toBe("uncertain")
    })
    it("preserves compound provider failure instead of converting a defect into a normal rejected reply", async () => {
      const f = await fixture(channel)
      f.transport.send = () =>
        Effect.failCause(
          Cause.fromReasons([
            Cause.makeFailReason(new ReplySendFailed({ uncertain: false })),
            Cause.makeDieReason("provider defect"),
          ])
        )
      const exit = await f.run(
        Effect.exit(deliverReply(f.progress, f.transport))
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit))
        expect(Cause.pretty(exit.cause)).toContain("provider defect")
      expect((await f.read())?.state).toBe("uncertain")
    })
  }
)
