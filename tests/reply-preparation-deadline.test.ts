import { it } from "@effect/vitest"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"

import {
  AgentOutcome,
  agentRpc,
  observeAgentRpc,
} from "../src/agents/adapters/rpc"
import { homeAgentId } from "../src/agents/domain"
import { prepareReply, type ReplyPreparation } from "../src/replies/preparation"
import { orDieAll } from "../src/shared/effect"
import {
  WhatsAppOutcome,
  whatsappRemote,
  whatsappRpc,
} from "../src/whatsapp/adapters/rpc"

class Unavailable extends Schema.TaggedError<Unavailable>()(
  "PreparationUnavailable",
  {}
) {}
const draft = { text: "Reply", files: [] as string[], includeFiles: false }
const ready = { draft, ready: true, notify: false }
function fixture(kind: ReplyPreparation<Unavailable>["kind"] = "control") {
  const calls: string[] = []
  const step = <A>(name: string, value: A) =>
    Effect.sync(() => {
      calls.push(name)
      return value
    })
  const work: ReplyPreparation<Unavailable> = {
    kind,
    deadline: 1000,
    timeout: new Unavailable(),
    draft,
    check: step("check", "allowed" as const),
    cancel: step("cancel", undefined),
    expire: step("expire", undefined),
    control: step("control", "Reply"),
    media: {
      claim: step("media.claim", 1),
      import: step("media.import", { fileId: "file" }),
      save: () => step("media.save", true),
      fail: () => step("media.fail", undefined),
    },
    admit: () => step("admit", undefined),
    prepared: () => step("prepared", undefined),
    observe: step("observe", ready),
    notify: step("notify", undefined),
    deliver: () => step("deliver", undefined),
  }
  return { work, calls, step }
}

for (const stage of [
  "control",
  "media",
  "admit",
  "observe",
  "deliver",
] as const)
  it.effect(
    `bounds a held ${stage} invocation and cannot advance after its committed deadline`,
    () =>
      Effect.gen(function* () {
        const f = fixture(stage),
          entered = yield* Deferred.make<void>()
        const held = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never)
        )
        if (stage === "control") f.work.control = held
        if (stage === "media") f.work.media!.import = held
        if (stage === "admit") f.work.admit = () => held
        if (stage === "observe") f.work.observe = held
        if (stage === "deliver") f.work.deliver = () => held
        const pass = yield* prepareReply(f.work).pipe(
          Effect.exit,
          Effect.forkScoped
        )
        yield* Deferred.await(entered)
        yield* TestClock.adjust(999)
        expect(pass.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust(1)
        const exit = yield* Fiber.join(pass)
        expect(
          Exit.isFailure(exit) &&
            exit.cause.reasons.some(
              (reason) =>
                reason._tag === "Fail" && reason.error === f.work.timeout
            )
        ).toBe(true)
        expect(f.calls).not.toContain("prepared")
        expect(f.calls).not.toContain("media.save")
        expect(f.calls).not.toContain("deliver")
      }).pipe(Effect.scoped)
  )

it.effect(
  "successive preparation stages share one absolute deadline, including nested delivery preparation",
  () =>
    Effect.gen(function* () {
      const f = fixture("observe"),
        entered = yield* Deferred.make<void>()
      f.work.check = Effect.sleep(250).pipe(Effect.andThen(f.work.check))
      f.work.observe = Effect.sleep(350).pipe(
        Effect.andThen(f.step("observe", { ...ready, notify: true }))
      )
      f.work.notify = Effect.sleep(300).pipe(Effect.andThen(f.work.notify))
      f.work.deliver = () =>
        f
          .step("delivery preparation", undefined)
          .pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Effect.never)
          )
      const pass = yield* prepareReply(f.work).pipe(
        Effect.exit,
        Effect.forkScoped
      )
      yield* TestClock.adjust(900)
      yield* Deferred.await(entered)
      expect(yield* Clock.currentTimeMillis).toBe(900)
      yield* TestClock.adjust(99)
      expect(pass.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      const exit = yield* Fiber.join(pass)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(f.calls).toEqual([
        "check",
        "observe",
        "notify",
        "delivery preparation",
      ])
    }).pipe(Effect.scoped)
)

it.effect(
  "does not begin any preparation work when its durable deadline already elapsed",
  () =>
    Effect.gen(function* () {
      const f = fixture("deliver")
      f.work.deadline = 0
      f.work.deliver = () => {
        f.calls.push("constructed provider dispatch")
        return Effect.void
      }
      const exit = yield* Effect.exit(prepareReply(f.work))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(f.calls).toEqual([])
    })
)

it.effect(
  "joins preparation cleanup and retains all failed teardown reasons at the deadline",
  () =>
    Effect.gen(function* () {
      const f = fixture(),
        entered = yield* Deferred.make<void>(),
        cleaning = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>(),
        refused = Cause.makeFailReason(new Unavailable()),
        defect = new Error("Preparation cleanup failed")
      f.work.control = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Deferred.succeed(cleaning, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(
              orDieAll(
                Effect.failCause(
                  Cause.fromReasons([refused, Cause.makeDieReason(defect)])
                )
              )
            )
          )
        )
      )
      const pass = yield* prepareReply(f.work).pipe(
        Effect.exit,
        Effect.forkScoped
      )
      yield* Deferred.await(entered)
      yield* TestClock.adjust(1000)
      yield* Deferred.await(cleaning)
      expect(pass.pollUnsafe()).toBeUndefined()
      expect(f.calls).not.toContain("prepared")
      yield* Deferred.succeed(release, undefined)
      const exit = yield* Fiber.join(pass)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(
          exit.cause.reasons.some(
            (reason) => reason._tag === "Die" && reason.defect === defect
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
        expect(
          exit.cause.reasons.some(
            (reason) =>
              reason._tag === "Fail" && reason.error === f.work.timeout
          )
        ).toBe(true)
      }
    }).pipe(Effect.scoped)
)

it.effect(
  "joins external cancellation of a timed preparation and preserves late cleanup failure",
  () =>
    Effect.gen(function* () {
      const f = fixture(),
        entered = yield* Deferred.make<void>(),
        cleaning = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>(),
        defect = new Error("Cancelled preparation cleanup failed")
      f.work.control = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Deferred.succeed(cleaning, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.die(defect))
          )
        )
      )
      const pass = yield* prepareReply(f.work).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      const stopping = yield* Fiber.interrupt(pass).pipe(Effect.forkScoped)
      yield* Deferred.await(cleaning)
      expect(stopping.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(stopping)
      const exit = yield* Fiber.await(pass)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(
        Exit.isFailure(exit) &&
          exit.cause.reasons.some(
            (reason) => reason._tag === "Die" && reason.defect === defect
          )
      ).toBe(true)
      expect(f.calls).not.toContain("prepared")
    }).pipe(Effect.scoped)
)

for (const remote of ["WhatsApp Turn", "Email profile"] as const)
  for (const late of ["success", "rejection"] as const)
    it.effect(
      `production ${remote} observation stops at the preparation deadline and ignores late ${late}`,
      () =>
        Effect.gen(function* () {
          const f = fixture(remote === "WhatsApp Turn" ? "observe" : "deliver")
          let resolve!: (value: unknown) => void,
            reject!: (cause: unknown) => void,
            started!: () => void,
            requests = 0
          const result = new Promise<unknown>((accept, refuse) => {
              resolve = accept
              reject = refuse
            }),
            entered = new Promise<void>((accept) => {
              started = accept
            })
          const request = () => {
            requests++
            started()
            return result
          }
          if (remote === "WhatsApp Turn")
            f.work.observe = whatsappRemote(() =>
              whatsappRpc({ whatsappV1: request }).turn("owner", "message")
            ).pipe(
              Effect.mapError(() => f.work.timeout),
              Effect.as(ready)
            )
          else
            f.work.deliver = () =>
              observeAgentRpc(() =>
                agentRpc({ agentV1: request }).profile(homeAgentId)
              ).pipe(
                Effect.mapError(() => f.work.timeout),
                Effect.andThen(f.step("provider dispatch", undefined))
              )
          const pass = yield* prepareReply(f.work).pipe(
            Effect.exit,
            Effect.forkScoped
          )
          yield* Effect.promise(() => entered)
          yield* TestClock.adjust(1000)
          const exit = yield* Fiber.join(pass)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(requests).toBe(1)
          if (late === "rejection") reject(new Error("Late remote failure"))
          else
            resolve(
              remote === "WhatsApp Turn"
                ? WhatsAppOutcome.encode(Exit.succeed(null))
                : AgentOutcome.encode(Exit.succeed(null))
            )
          yield* Effect.promise(() =>
            result.then(
              () => undefined,
              () => undefined
            )
          )
          yield* Effect.yieldNow
          expect(f.calls).toEqual(["check"])
          expect(requests).toBe(1)
        }).pipe(Effect.scoped)
    )
