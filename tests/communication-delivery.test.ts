import { it } from "@effect/vitest"
import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"

import { AgentId } from "../src/agents/domain"
import { sqliteMailbox } from "../src/communication/adapters/sqlite"
import {
  failure,
  type CommunicationError,
  type Envelope,
} from "../src/communication/contracts"
import { deliverNext, receive } from "../src/communication/delivery"
import { deliveryMachine } from "../src/communication/delivery.machine"
import { incomingAdmissionMachine } from "../src/communication/incoming.machine"
import { Mailbox, MailboxTransport } from "../src/communication/mailbox"
import { database } from "./database"

const from = Schema.decodeUnknownSync(AgentId)("home")
const to = Schema.decodeUnknownSync(AgentId)(
  "00000000-0000-4000-8000-000000000001"
)
const envelope: Envelope = {
  version: 1,
  id: "delivery-1",
  taskId: "delivery-1",
  owner: "synthetic-owner",
  from,
  to,
  correlationId: "turn-1",
  causationId: "tool-1",
  createdAt: 0,
  deadline: 1000000,
  depth: 1,
  payload: { kind: "question", objective: "What is 2 + 2?", context: "" },
}
const receipt = { id: envelope.id, taskId: envelope.taskId, acceptedAt: 0 }

const fixture = Effect.gen(function* () {
  const repository = sqliteMailbox(database())
  const mailbox = yield* repository.initialize
  yield* repository.bindIdentity({ owner: envelope.owner, bot: from })
  yield* mailbox.enqueue(envelope, 0, { discoveryDeadline: 60000 })
  return mailbox
})
const transport = (
  deliver: MailboxTransport["Service"]["deliver"]
): MailboxTransport["Service"] => ({
  deliver,
  authenticate: () => Effect.void,
  permitted: () => Effect.succeed(true),
})

// The actor stays in sending until the timed transport's finalizer has joined.
// A retry ledger update while release is blocked would let a future pump overlap it.
describe("scoped communication delivery", () => {
  it.effect("joins timeout cleanup before the machine records a retry", () =>
    Effect.gen(function* () {
      const mailbox = yield* fixture
      const entered = yield* Deferred.make<void>()
      const cleanup = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const actor = yield* createEffectActor(
        deliveryMachine(
          mailbox,
          transport(() =>
            Effect.acquireUseRelease(
              Deferred.succeed(entered, undefined),
              () => Effect.never,
              () =>
                Deferred.succeed(cleanup, undefined).pipe(
                  Effect.andThen(Deferred.await(release))
                )
            )
          )
        )
      )
      yield* Deferred.await(entered)
      const advanced = yield* TestClock.adjust("10 seconds").pipe(
        Effect.forkChild
      )
      yield* Deferred.await(cleanup)
      expect(actor.getSnapshot().matches("sending")).toBe(true)
      expect((yield* mailbox.deliveries())[0]).toMatchObject({
        status: "delivering",
        attempts: 1,
        receipt: null,
      })
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(advanced)
      const done = yield* waitFor(actor, (state) => state.status === "done")
      expect(yield* done.output!).toBe(true)
      const delivery = (yield* mailbox.deliveries())[0]!
      expect(delivery).toMatchObject({
        status: "pending",
        attempts: 1,
        receipt: null,
      })
      expect(delivery.nextAt).toBeGreaterThanOrEqual(10750)
      expect(delivery.nextAt).toBeLessThanOrEqual(11250)
    }).pipe(Effect.scoped)
  )

  it.effect(
    "retains a cleanup defect on timeout without authorizing a retry",
    () =>
      Effect.gen(function* () {
        const mailbox = yield* fixture
        const entered = yield* Deferred.make<void>()
        const defect = new Error("Transport cleanup failed")
        const pending = yield* deliverNext().pipe(
          Effect.provideService(Mailbox, mailbox),
          Effect.provideService(
            MailboxTransport,
            transport(() =>
              Effect.acquireUseRelease(
                Deferred.succeed(entered, undefined),
                () => Effect.never,
                () => Effect.die(defect)
              )
            )
          ),
          Effect.exit,
          Effect.forkChild
        )
        yield* Deferred.await(entered)
        yield* TestClock.adjust("10 seconds")
        const exit = yield* Fiber.join(pending)
        expect(
          Exit.isFailure(exit) &&
            exit.cause.reasons.some(
              (reason) => reason._tag === "Die" && reason.defect === defect
            )
        ).toBe(true)
        expect((yield* mailbox.deliveries())[0]?.status).toBe("delivering")
      }).pipe(Effect.scoped)
  )

  it.effect("joins cancellation cleanup and retains its fatal cause", () =>
    Effect.gen(function* () {
      const mailbox = yield* fixture
      const entered = yield* Deferred.make<void>()
      const cleanup = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const defect = new Error("Interrupted transport cleanup failed")
      const pending = yield* deliverNext().pipe(
        Effect.provideService(Mailbox, mailbox),
        Effect.provideService(
          MailboxTransport,
          transport(() =>
            Effect.acquireUseRelease(
              Deferred.succeed(entered, undefined),
              () => Effect.never,
              () =>
                Deferred.succeed(cleanup, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(Effect.die(defect))
                )
            )
          )
        ),
        Effect.forkChild
      )
      yield* Deferred.await(entered)
      const stopped = yield* Fiber.interrupt(pending).pipe(Effect.forkChild)
      yield* Deferred.await(cleanup)
      expect(stopped.pollUnsafe()).toBeUndefined()
      expect((yield* mailbox.deliveries())[0]?.status).toBe("delivering")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(stopped)
      const exit = yield* Fiber.await(pending)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(
        Exit.isFailure(exit) &&
          exit.cause.reasons.some(
            (reason) => reason._tag === "Die" && reason.defect === defect
          )
      ).toBe(true)
      expect((yield* mailbox.deliveries())[0]?.status).toBe("delivering")
    }).pipe(Effect.scoped)
  )

  it.effect(
    "acknowledges the claimed identity and does not send it twice",
    () =>
      Effect.gen(function* () {
        const mailbox = yield* fixture
        let sends = 0
        const attempt = deliverNext().pipe(
          Effect.provideService(Mailbox, mailbox),
          Effect.provideService(
            MailboxTransport,
            transport((sent) =>
              Effect.sync(() => {
                expect(sent).toEqual(envelope)
                sends++
                return receipt
              })
            )
          )
        )
        expect(yield* attempt).toBe(true)
        expect(yield* attempt).toBe(false)
        expect(sends).toBe(1)
        expect((yield* mailbox.deliveries())[0]).toMatchObject({
          status: "accepted",
          attempts: 1,
          receipt,
        })
      })
  )

  it.effect(
    "records a permanent rejection without retrying transport locally",
    () =>
      Effect.gen(function* () {
        const mailbox = yield* fixture
        let sends = 0
        expect(
          yield* deliverNext().pipe(
            Effect.provideService(Mailbox, mailbox),
            Effect.provideService(
              MailboxTransport,
              transport(() =>
                Effect.sync(() => sends++).pipe(
                  Effect.andThen(
                    Effect.fail(failure("forbidden", "Access revoked"))
                  )
                )
              )
            )
          )
        ).toBe(true)
        expect(sends).toBe(1)
        expect((yield* mailbox.deliveries())[0]).toMatchObject({
          status: "failed",
          attempts: 1,
        })
      })
  )
})

const recipient = Effect.gen(function* () {
  const repository = sqliteMailbox(database())
  const mailbox = yield* repository.initialize
  yield* repository.bindIdentity({ owner: envelope.owner, bot: to })
  return mailbox
})
const cancellation: Envelope = {
  ...envelope,
  id: "cancel:delivery-1",
  causationId: envelope.id,
  payload: { kind: "cancel", reason: "The owner requested cancellation." },
}

describe("communication receipt admission", () => {
  it.effect(
    "authenticates an exact receipt replay without renewing discovery",
    () =>
      Effect.gen(function* () {
        const mailbox = yield* recipient
        let authentications = 0
        const service = {
          ...transport(() => Effect.die("Unexpected delivery")),
          authenticate: () =>
            Effect.sync(() => {
              authentications++
            }),
        }
        const first = yield* receive(envelope, Effect.succeed(60000)).pipe(
          Effect.provideService(Mailbox, mailbox),
          Effect.provideService(MailboxTransport, service)
        )
        const replay = yield* receive(
          envelope,
          Effect.die("Replay must not renew discovery")
        ).pipe(
          Effect.provideService(Mailbox, mailbox),
          Effect.provideService(MailboxTransport, service)
        )
        expect(replay).toEqual(first)
        expect(authentications).toBe(2)
        expect(yield* mailbox.tasks()).toHaveLength(1)
      })
  )

  it.effect("rejects expired discovery before committing a fresh request", () =>
    Effect.gen(function* () {
      const mailbox = yield* recipient
      const exit = yield* receive(envelope, Effect.succeed(0)).pipe(
        Effect.provideService(Mailbox, mailbox),
        Effect.provideService(
          MailboxTransport,
          transport(() => Effect.die("Unexpected delivery"))
        ),
        Effect.exit
      )
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
      expect(yield* mailbox.accepted(envelope)).toBeUndefined()
      expect(yield* mailbox.tasks()).toHaveLength(0)
    })
  )

  it.effect(
    "persists cancellation despite a compound discovery failure and retains every cause",
    () =>
      Effect.gen(function* () {
        const mailbox = yield* recipient
        const refused = Cause.makeFailReason(
          failure("storage", "Discovery unavailable")
        )
        const defect = Cause.makeDieReason(
          new Error("Discovery cleanup failed")
        )
        const interrupt = Cause.makeInterruptReason(123)
        const exit = yield* receive(
          cancellation,
          Effect.failCause(Cause.fromReasons([refused, defect, interrupt]))
        ).pipe(
          Effect.provideService(Mailbox, mailbox),
          Effect.provideService(
            MailboxTransport,
            transport(() => Effect.die("Unexpected delivery"))
          ),
          Effect.exit
        )
        expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
          { _tag: "Die", defect: { _tag: "Fail", error: refused.error } },
          { _tag: "Die", defect: defect.defect },
          { _tag: "Interrupt", fiberId: 123 },
        ])
        expect(yield* mailbox.accepted(cancellation)).toMatchObject({
          id: cancellation.id,
        })
        // The saved tombstone prevents the original request acquiring execution.
        yield* mailbox.accept(envelope, 0, { discoveryDeadline: 60000 })
        expect(yield* mailbox.task(envelope.id)).toMatchObject({
          cancelRequested: true,
        })
      })
  )

  it.effect(
    "persists cancellation after discovery is externally interrupted",
    () =>
      Effect.gen(function* () {
        const mailbox = yield* recipient
        const entered = yield* Deferred.make<void>()
        const pending = yield* receive(
          cancellation,
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never)
          )
        ).pipe(
          Effect.provideService(Mailbox, mailbox),
          Effect.provideService(
            MailboxTransport,
            transport(() => Effect.die("Unexpected delivery"))
          ),
          Effect.forkChild
        )
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(pending)
        const exit = yield* Fiber.await(pending)
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
          true
        )
        expect(yield* mailbox.accepted(cancellation)).toMatchObject({
          id: cancellation.id,
        })
      }).pipe(Effect.scoped)
  )
})

describe("incoming admission progression", () => {
  it.effect(
    "does not begin acceptance after discovery reports external interruption",
    () =>
      Effect.gen(function* () {
        const interrupted =
          yield* Deferred.make<Cause.Cause<CommunicationError>>()
        let acceptances = 0
        const actor = yield* createEffectActor(
          incomingAdmissionMachine({
            envelope,
            mailbox: {
              accepted: () => Effect.succeed(undefined),
              accept: () =>
                Effect.sync(() => {
                  acceptances++
                  return receipt
                }),
            },
            transport: { authenticate: () => Effect.void },
            arm: Deferred.succeed(interrupted, Cause.interrupt(321)).pipe(
              Effect.as(60000)
            ),
            interrupted,
          })
        )
        const done = yield* waitFor(
          actor,
          (snapshot) => snapshot.status === "done"
        )
        expect(Exit.isFailure(done.output!)).toBe(true)
        expect(acceptances).toBe(0)
      }).pipe(Effect.scoped)
  )

  it.effect(
    "joins timed-out request discovery before returning and never admits it later",
    () =>
      Effect.gen(function* () {
        const mailbox = yield* recipient
        const entered = yield* Deferred.make<void>()
        const cleanup = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const pending = yield* receive(
          envelope,
          Effect.acquireUseRelease(
            Deferred.succeed(entered, undefined),
            () => Effect.never,
            () =>
              Deferred.succeed(cleanup, undefined).pipe(
                Effect.andThen(Deferred.await(release))
              )
          )
        ).pipe(
          Effect.provideService(Mailbox, mailbox),
          Effect.provideService(
            MailboxTransport,
            transport(() => Effect.die("Unexpected delivery"))
          ),
          Effect.timeout("1 second"),
          Effect.exit,
          Effect.forkChild
        )
        yield* Deferred.await(entered)
        const advanced = yield* TestClock.adjust("1 second").pipe(
          Effect.forkChild
        )
        yield* Deferred.await(cleanup)
        expect(pending.pollUnsafe()).toBeUndefined()
        expect(yield* mailbox.accepted(envelope)).toBeUndefined()
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(advanced)
        const exit = yield* Fiber.join(pending)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* mailbox.accepted(envelope)).toBeUndefined()
        expect(yield* mailbox.tasks()).toHaveLength(0)
      }).pipe(Effect.scoped)
  )

  it.effect(
    "joins interrupted discovery cleanup before cancellation settles and retains its defect",
    () =>
      Effect.gen(function* () {
        const mailbox = yield* recipient
        const entered = yield* Deferred.make<void>()
        const cleanup = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const defect = new Error("Interrupted discovery cleanup failed")
        const pending = yield* receive(
          cancellation,
          Effect.acquireUseRelease(
            Deferred.succeed(entered, undefined),
            () => Effect.never,
            () =>
              Deferred.succeed(cleanup, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.die(defect))
              )
          )
        ).pipe(
          Effect.provideService(Mailbox, mailbox),
          Effect.provideService(
            MailboxTransport,
            transport(() => Effect.die("Unexpected delivery"))
          ),
          Effect.forkChild
        )
        yield* Deferred.await(entered)
        const stopped = yield* Fiber.interrupt(pending).pipe(Effect.forkChild)
        yield* Deferred.await(cleanup)
        expect(stopped.pollUnsafe()).toBeUndefined()
        expect(yield* mailbox.accepted(cancellation)).toBeUndefined()
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(stopped)
        const exit = yield* Fiber.await(pending)
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
          true
        )
        expect(
          Exit.isFailure(exit) &&
            exit.cause.reasons.some(
              (reason) => reason._tag === "Die" && reason.defect === defect
            )
        ).toBe(true)
        expect(yield* mailbox.accepted(cancellation)).toMatchObject({
          id: cancellation.id,
        })
      }).pipe(Effect.scoped)
  )
})
