import { it } from "@effect/vitest"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"

import { sendEmailReply } from "../src/email/adapters/sending"
import type { EmailRecord } from "../src/email/contracts"
import {
  REPLY_LEASE_MS,
  ReplySendFailed,
  type ReplyProgress,
} from "../src/replies/contracts"
import { deliverReply, type ReplyTransport } from "../src/replies/delivery"
import {
  advanceReplyMessage,
  newReplyMessage,
  type ReplyMessageEvent,
} from "../src/replies/message.machine"
import { orDieAll } from "../src/shared/effect"

function fixture() {
  const progress: ReplyProgress = {
    version: 1,
    generation: 1,
    parts: [
      { text: "first", files: [] },
      { text: "second", files: [] },
    ],
    receipts: [],
  }
  let row = newReplyMessage("Reply", true)
  const armed: number[] = [],
    events: string[] = []
  const commit = (event: ReplyMessageEvent) =>
    Effect.sync(() => {
      const before = row
      row = advanceReplyMessage(row, event)
      events.push(event.type)
      return row.revision !== before.revision || row.state !== before.state
    })
  const hooks = { afterClaim: Effect.void }
  const transport: ReplyTransport<never> = {
    arm: (deadline) =>
      Effect.sync(() => {
        armed.push(deadline)
      }),
    claim: (delivery, from, lease) =>
      Effect.gen(function* () {
        const claimed = yield* commit({
          type: "CLAIM",
          from,
          attemptId: lease.attemptId,
          now: yield* Clock.currentTimeMillis,
          deadline: lease.deadline,
          reply: "Reply",
          delivery,
          authorized: true,
          expired: false,
          error: "Authority ended",
        })
        yield* hooks.afterClaim
        return claimed
      }),
    send: () => Effect.die("Provider must be supplied by the test"),
    checkpoint: (delivery, attemptId) =>
      commit({ type: "CHECKPOINT", attemptId, delivery }),
    finish: (state, providerId, attemptId) =>
      commit({
        type: "FINISH",
        state,
        providerId,
        attemptId,
        error: state === "sent" ? null : "Delivery failed or unconfirmed",
      }),
    recover: (attemptId) =>
      Effect.gen(function* () {
        return yield* commit({
          type: "RECOVER",
          attemptId,
          force: true,
          now: yield* Clock.currentTimeMillis,
          error: "Delivery unconfirmed",
        })
      }),
  }
  return {
    progress,
    transport,
    hooks,
    armed,
    events,
    commit,
    read: () => row,
    deliver: () => deliverReply(row.delivery ?? progress, transport),
  }
}

it.effect(
  "uses only the remaining committed lease and does not resend on timeout",
  () =>
    Effect.gen(function* () {
      const f = fixture(),
        claimed = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>(),
        started = yield* Deferred.make<void>()
      let sends = 0
      f.hooks.afterClaim = Deferred.succeed(claimed, undefined).pipe(
        Effect.andThen(Deferred.await(release))
      )
      f.transport.send = () =>
        Effect.sync(() => sends++).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Effect.never)
        )
      const sender = yield* f.deliver().pipe(Effect.forkScoped)
      yield* Deferred.await(claimed)
      yield* TestClock.adjust(REPLY_LEASE_MS - 1000)
      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(started)
      yield* TestClock.adjust(999)
      expect(sender.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      yield* Fiber.join(sender)
      expect(f.read()).toMatchObject({
        state: "uncertain",
        sendDeadline: REPLY_LEASE_MS,
        delivery: { receipts: [] },
      })
      expect(f.armed).toEqual([REPLY_LEASE_MS])
      expect(f.events).not.toContain("CHECKPOINT")
      yield* f.deliver()
      expect(sends).toBe(1)
    }).pipe(Effect.scoped)
)

it.effect(
  "does not construct or dispatch a provider call after the committed lease expires",
  () =>
    Effect.gen(function* () {
      const f = fixture(),
        claimed = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      let sends = 0
      f.hooks.afterClaim = Deferred.succeed(claimed, undefined).pipe(
        Effect.andThen(Deferred.await(release))
      )
      f.transport.send = () => {
        sends++
        return Effect.succeed("must-not-send")
      }
      const sender = yield* f.deliver().pipe(Effect.forkScoped)
      yield* Deferred.await(claimed)
      yield* TestClock.adjust(REPLY_LEASE_MS)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(sender)
      expect(sends).toBe(0)
      expect(f.read()).toMatchObject({
        state: "failed",
        delivery: { receipts: [] },
      })
      expect(f.events).not.toContain("CHECKPOINT")
    }).pipe(Effect.scoped)
)

it.effect(
  "joins timeout cleanup before finishing or reconciling the owned attempt",
  () =>
    Effect.gen(function* () {
      const f = fixture(),
        started = yield* Deferred.make<void>(),
        cleaning = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      f.transport.send = () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Deferred.succeed(cleaning, undefined).pipe(
              Effect.andThen(Deferred.await(release))
            )
          )
        )
      const sender = yield* f.deliver().pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* TestClock.adjust(REPLY_LEASE_MS)
      yield* Deferred.await(cleaning)
      expect(sender.pollUnsafe()).toBeUndefined()
      expect(f.read().state).toBe("sending")
      expect(f.events).not.toContain("FINISH")
      expect(f.events).not.toContain("RECOVER")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(sender)
      expect(f.read().state).toBe("uncertain")
      expect(f.events.slice(-2)).toEqual(["FINISH", "RECOVER"])
    }).pipe(Effect.scoped)
)

it.effect(
  "retains every failed cleanup reason instead of hiding it behind ordinary timeout uncertainty",
  () =>
    Effect.gen(function* () {
      const f = fixture(),
        started = yield* Deferred.make<void>(),
        cleaning = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>(),
        refused = Cause.makeFailReason(
          new ReplySendFailed({ uncertain: false })
        ),
        defect = Cause.makeDieReason(new Error("Provider teardown defect"))
      f.transport.send = () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Deferred.succeed(cleaning, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(
                orDieAll(Effect.failCause(Cause.fromReasons([refused, defect])))
              )
            )
          )
        )
      const sender = yield* f.deliver().pipe(Effect.exit, Effect.forkScoped)
      yield* Deferred.await(started)
      yield* TestClock.adjust(REPLY_LEASE_MS)
      yield* Deferred.await(cleaning)
      expect(f.read().state).toBe("sending")
      yield* Deferred.succeed(release, undefined)
      const exit = yield* Fiber.join(sender)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(
          exit.cause.reasons.some(
            (reason) => reason._tag === "Die" && reason.defect === defect.defect
          )
        ).toBe(true)
        expect(
          exit.cause.reasons.some(
            (reason) =>
              reason._tag === "Die" &&
              Cause.isReason(reason.defect) &&
              Cause.isFailReason(reason.defect) &&
              reason.defect.error === refused.error
          )
        ).toBe(true)
        expect(Cause.hasFails(exit.cause)).toBe(false)
      }
      expect(f.events).not.toContain("FINISH")
      expect(f.read().state).toBe("uncertain")
    }).pipe(Effect.scoped)
)

it.effect(
  "ignores a non-abortable provider's late receipt after timeout and an explicitly acknowledged retry",
  () =>
    Effect.gen(function* () {
      const f = fixture(),
        started = yield* Deferred.make<void>(),
        retried = yield* Deferred.make<void>()
      let resolveOld!: (receipt: string) => void,
        resolveNew!: (receipt: string) => void,
        sends = 0
      const old = new Promise<string>((resolve) => {
          resolveOld = resolve
        }),
        fresh = new Promise<string>((resolve) => {
          resolveNew = resolve
        })
      f.transport.send = () => {
        sends++
        if (sends === 1)
          return Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.promise(() => old))
          )
        if (sends === 2)
          return Deferred.succeed(retried, undefined).pipe(
            Effect.andThen(Effect.promise(() => fresh))
          )
        return Effect.succeed("new-second")
      }
      const first = yield* f.deliver().pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* TestClock.adjust(REPLY_LEASE_MS)
      yield* Fiber.join(first)
      expect(f.read().state).toBe("uncertain")
      yield* f.commit({
        type: "RETRY",
        waiting: true,
        acknowledgeDuplicateRisk: true,
        deadline: (yield* Clock.currentTimeMillis) + REPLY_LEASE_MS,
      })
      const second = yield* f.deliver().pipe(Effect.forkScoped)
      yield* Deferred.await(retried)
      const current = f.read()
      resolveOld("old-late-receipt")
      yield* Effect.promise(() => old)
      yield* Effect.yieldNow
      expect(f.read()).toEqual(current)
      expect(f.events).not.toContain("CHECKPOINT")
      expect(sends).toBe(2)
      resolveNew("new-first")
      yield* Fiber.join(second)
      expect(sends).toBe(3)
      expect(f.read()).toMatchObject({
        state: "sent",
        providerId: "new-second",
        delivery: { receipts: ["new-first", "new-second"] },
      })
    }).pipe(Effect.scoped)
)

it.effect("retains a confirmed prefix when a later part times out", () =>
  Effect.gen(function* () {
    const f = fixture(),
      started = yield* Deferred.make<void>()
    let sends = 0
    f.transport.send = () => {
      sends++
      return sends === 1
        ? Effect.succeed("confirmed-first")
        : Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never)
          )
    }
    const sender = yield* f.deliver().pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    yield* TestClock.adjust(REPLY_LEASE_MS)
    yield* Fiber.join(sender)
    expect(sends).toBe(2)
    expect(f.read()).toMatchObject({
      state: "uncertain",
      providerId: null,
      delivery: { receipts: ["confirmed-first"] },
    })
  }).pipe(Effect.scoped)
)

const emailRecord: EmailRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  fingerprint: "a".repeat(64),
  messageId: "<deadline@example.com>",
  sender: "owner@example.com",
  recipient: "agent@example.com",
  subject: "Provider deadline",
  body: "Reply",
  references: "",
  purpose: "request",
  state: "waiting",
  reply: "Reply",
  providerId: null,
  error: null,
  createdAt: 0,
}

for (const late of ["success", "rejection"] as const)
  it.effect(
    `the production Email adapter releases the deadline and ignores late provider ${late} during an acknowledged retry`,
    () =>
      Effect.gen(function* () {
        const f = fixture()
        let resolveOld!: (response: EmailSendResult) => void,
          rejectOld!: (error: unknown) => void,
          resolveNew!: (response: EmailSendResult) => void,
          firstStarted!: () => void,
          nextStarted!: () => void,
          sends = 0
        const original = new Promise<EmailSendResult>((resolve, reject) => {
            resolveOld = resolve
            rejectOld = reject
          }),
          current = new Promise<EmailSendResult>((resolve) => {
            resolveNew = resolve
          }),
          entered = new Promise<void>((resolve) => {
            firstStarted = resolve
          }),
          retried = new Promise<void>((resolve) => {
            nextStarted = resolve
          })
        const binding: SendEmail = {
          send: () => {
            sends++
            if (sends === 1) {
              firstStarted()
              return original
            }
            if (sends === 2) {
              nextStarted()
              return current
            }
            return Promise.resolve({ messageId: "retry-second" })
          },
        }
        f.transport.send = (part) =>
          sendEmailReply(binding, emailRecord, part.text)
        const first = yield* f.deliver().pipe(Effect.forkScoped)
        yield* Effect.promise(() => entered)
        yield* TestClock.adjust(REPLY_LEASE_MS)
        yield* Fiber.join(first)
        expect(sends).toBe(1)
        expect(f.read()).toMatchObject({
          state: "uncertain",
          delivery: { receipts: [] },
        })
        yield* f.commit({
          type: "RETRY",
          waiting: true,
          acknowledgeDuplicateRisk: true,
          deadline: (yield* Clock.currentTimeMillis) + REPLY_LEASE_MS,
        })
        const retry = yield* f.deliver().pipe(Effect.forkScoped)
        yield* Effect.promise(() => retried)
        const admitted = f.read()
        if (late === "success")
          resolveOld({ messageId: "old-provider-receipt" })
        else rejectOld(new Error("Old provider rejection"))
        yield* Effect.promise(() =>
          original.then(
            () => undefined,
            () => undefined
          )
        )
        yield* Effect.yieldNow
        expect(f.read()).toEqual(admitted)
        expect(f.events).not.toContain("CHECKPOINT")
        expect(sends).toBe(2)
        resolveNew({ messageId: "retry-first" })
        yield* Fiber.join(retry)
        expect(sends).toBe(3)
        expect(f.read()).toMatchObject({
          state: "sent",
          providerId: "retry-second",
          delivery: { receipts: ["retry-first", "retry-second"] },
        })
      }).pipe(Effect.scoped)
  )

it.effect(
  "keeps synchronous Email rendering defects and never dispatches an invalid template",
  () =>
    Effect.gen(function* () {
      const failure = new Error("Email template failed"),
        broken = Object.defineProperty({ ...emailRecord }, "purpose", {
          get: () => {
            throw failure
          },
        })
      let sends = 0
      const exit = yield* Effect.exit(
        sendEmailReply(
          {
            send: async () => {
              sends++
              return { messageId: "must-not-send" }
            },
          },
          broken,
          "Reply"
        )
      )
      expect(sends).toBe(0)
      expect(
        Exit.isFailure(exit) &&
          exit.cause.reasons.some(
            (reason) => reason._tag === "Die" && reason.defect === failure
          )
      ).toBe(true)
    })
)

it.effect(
  "preserves full native Email failure Causes while the provider invocation is active",
  () =>
    Effect.gen(function* () {
      const rejected = new Error("Native checked failure"),
        defect = new Error("Native provider defect"),
        interruption = Cause.makeInterruptReason(987),
        failure = Cause.fromReasons([
          Cause.makeFailReason(rejected),
          Cause.makeDieReason(defect),
          interruption,
        ])
      const exit = yield* Effect.exit(
        sendEmailReply(
          { send: () => Promise.reject(failure) },
          emailRecord,
          "Reply"
        )
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(
          exit.cause.reasons.some(
            (reason) => reason._tag === "Die" && reason.defect === rejected
          )
        ).toBe(true)
        expect(
          exit.cause.reasons.some(
            (reason) => reason._tag === "Die" && reason.defect === defect
          )
        ).toBe(true)
        expect(exit.cause.reasons).toContainEqual(interruption)
        expect(Cause.hasFails(exit.cause)).toBe(false)
      }
    })
)

it.effect(
  "preserves Email schema validation defects while the provider invocation is active",
  () =>
    Effect.gen(function* () {
      const invalid = Schema.decodeUnknownExit(Schema.String)(123)
      if (Exit.isSuccess(invalid)) throw new Error("Expected invalid fixture")
      const reason = invalid.cause.reasons.find(Cause.isFailReason)
      if (!reason) throw new Error("Expected validation error")
      const exit = yield* Effect.exit(
        sendEmailReply(
          { send: () => Promise.reject(reason.error) },
          emailRecord,
          "Reply"
        )
      )
      expect(
        Exit.isFailure(exit) &&
          exit.cause.reasons.some(
            (present) =>
              present._tag === "Die" && present.defect === reason.error
          )
      ).toBe(true)
    })
)
