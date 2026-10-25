import { it } from "@effect/vitest"
import { send, waitFor } from "@xstate/effect"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { expect } from "vitest"

import type { Submission } from "../src/conversations/turns"
import { makeSubmission } from "../src/features/conversation/submission-owner"
import { makeTurnCommand } from "../src/features/conversation/turn-command-owner"
import { ApiError } from "../src/http/client"
import { nativeOperation } from "../src/shared/interop"

const input = {
  text: "Keep this request",
  mode: "followUp" as const,
  files: [],
  profile: "auto" as const,
  job: "conversation" as const,
}
const saved: Submission = {
  ...input,
  operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
}
const defaults = {
  persist: () => Effect.succeed(true),
  send: () => Effect.void,
  acknowledge: () => Effect.void,
  rejectModel: () => Effect.void,
}

it.effect(
  "does not send restored uncertainty until an explicit request reuses its identity",
  () =>
    Effect.gen(function* () {
      const sent: Submission[] = []
      const owner = yield* makeSubmission(saved, {
        ...defaults,
        send: (value) =>
          Effect.sync(() => {
            sent.push(value)
          }),
      })
      yield* Effect.yieldNow
      expect(sent).toEqual([])
      expect(yield* owner.submit(input)).toBe(true)
      expect(sent).toEqual([saved])
    }).pipe(Effect.scoped)
)

it.effect(
  "cannot dispatch before persistence or admit a second click while persistence is held",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<boolean>()
      let sends = 0
      const owner = yield* makeSubmission(null, {
        ...defaults,
        persist: () =>
          Effect.andThen(
            Deferred.succeed(entered, undefined),
            Deferred.await(release)
          ),
        send: () =>
          Effect.sync(() => {
            sends++
          }),
      })
      const first = yield* owner.submit(input).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      expect(yield* owner.submit(input)).toBe(false)
      expect(sends).toBe(0)
      yield* Deferred.succeed(release, true)
      expect(yield* Fiber.join(first)).toBe(true)
      expect(sends).toBe(1)
    }).pipe(Effect.scoped)
)

it.effect(
  "failed persistence retains the draft and admits no network request",
  () =>
    Effect.gen(function* () {
      let sends = 0
      const owner = yield* makeSubmission(null, {
        ...defaults,
        persist: () => Effect.succeed(false),
        send: () =>
          Effect.sync(() => {
            sends++
          }),
      })
      expect(yield* owner.submit(input)).toBe(false)
      expect(sends).toBe(0)
      expect(owner.actor.getSnapshot().context.pending?.text).toBe(input.text)
    }).pipe(Effect.scoped)
)

it.effect(
  "a lost acknowledgement retains one operation id across explicit retries",
  () =>
    Effect.gen(function* () {
      const sent: string[] = []
      const owner = yield* makeSubmission(null, {
        ...defaults,
        send: (attempt) =>
          Effect.andThen(
            Effect.sync(() => sent.push(attempt.operationId)),
            Effect.fail(new Error("response lost"))
          ),
      })
      expect(yield* owner.submit(input)).toBe(false)
      yield* waitFor(owner.actor, (state) => state.matches("ready"))
      yield* Effect.yieldNow
      expect(sent).toHaveLength(1)
      expect(yield* owner.submit(input)).toBe(false)
      expect(sent).toHaveLength(2)
      expect(sent[1]).toBe(sent[0])
    }).pipe(Effect.scoped)
)

it.effect(
  "explicit model rejection clears the attempt while transport failure does not",
  () =>
    Effect.gen(function* () {
      let cleared = 0
      const owner = yield* makeSubmission(saved, {
        ...defaults,
        send: () =>
          Effect.fail(
            new ApiError(422, "Choose another model", "model_unavailable")
          ),
        rejectModel: () =>
          Effect.sync(() => {
            cleared++
          }),
      })
      expect(yield* owner.submit(input)).toBe(false)
      expect(cleared).toBe(1)
      expect(owner.actor.getSnapshot().context.pending).toBeNull()
    }).pipe(Effect.scoped)
)

it.effect(
  "closing joins a held native send, preserves its attempt, and never clears a late acknowledgement",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make(),
        entered = yield* Deferred.make<void>(),
        aborted = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      let acknowledged = 0
      const owner = yield* makeSubmission(saved, {
        ...defaults,
        send: () =>
          nativeOperation(
            async (signal) => {
              Effect.runSync(Deferred.succeed(entered, undefined))
              signal.addEventListener(
                "abort",
                () => Effect.runSync(Deferred.succeed(aborted, undefined)),
                { once: true }
              )
              await Effect.runPromise(Deferred.await(release))
            },
            (cause) => cause
          ),
        acknowledge: () =>
          Effect.sync(() => {
            acknowledged++
          }),
      }).pipe(Effect.provideService(Scope.Scope, scope))
      const result = yield* owner.submit(input).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.forkChild
      )
      yield* Deferred.await(aborted)
      expect(closing.pollUnsafe()).toBeUndefined()
      expect(acknowledged).toBe(0)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(closing)
      expect(yield* Fiber.join(result)).toBe(false)
      expect(acknowledged).toBe(0)
      expect(owner.actor.getSnapshot().context.pending?.operationId).toBe(
        saved.operationId
      )
    })
)

for (const kind of ["submission", "retry", "cancel"] as const)
  for (const withDefect of [false, true])
    it.effect(
      `${kind} retains annotated late native failure and interruption (defect: ${withDefect})`,
      () =>
        Effect.gen(function* () {
          const scope = yield* Scope.make(),
            entered = yield* Deferred.make<void>(),
            aborted = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>()
          const defect = new Error("native teardown failed")
          const annotations = Context.makeUnsafe(
            new Map([["conversation/command-cleanup", kind]])
          )
          const interrupted = Cause.makeInterruptReason(
            kind === "submission" ? 90104 : 90105
          ).annotate(annotations)
          const compound = Cause.fromReasons([
            Cause.makeFailReason("checked").annotate(annotations),
            interrupted,
            ...(withDefect ? [Cause.makeDieReason(defect)] : []),
          ])
          const request = () =>
            nativeOperation(
              async (signal) => {
                Deferred.doneUnsafe(entered, Effect.void)
                signal.addEventListener(
                  "abort",
                  () => {
                    Deferred.doneUnsafe(aborted, Effect.void)
                  },
                  { once: true }
                )
                await Effect.runPromise(Deferred.await(release))
                throw compound
              },
              (cause) => cause
            )
          if (kind === "submission") {
            const owner = yield* makeSubmission(saved, {
              ...defaults,
              send: request,
            }).pipe(Effect.provideService(Scope.Scope, scope))
            yield* owner.submit(input).pipe(Effect.forkChild)
          } else {
            const owner = yield* makeTurnCommand(request).pipe(
              Effect.provideService(Scope.Scope, scope)
            )
            if (kind === "retry")
              yield* send(owner, {
                type: "RETRY",
                turnId: saved.operationId,
                allowed: true,
              })
            else
              yield* send(owner, { type: "CANCEL", turnId: saved.operationId })
          }
          yield* Deferred.await(entered)
          const closing = yield* Scope.close(scope, Exit.void).pipe(
            Effect.exit,
            Effect.forkChild
          )
          yield* Deferred.await(aborted)
          expect(closing.pollUnsafe()).toBeUndefined()
          yield* Deferred.succeed(release, undefined)
          const result = yield* Fiber.join(closing)
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isFailure(result)) {
            const retainedInterrupt = result.cause.reasons.find(
              (reason) =>
                reason._tag === "Interrupt" &&
                reason.fiberId === interrupted.fiberId
            )
            expect(
              retainedInterrupt?.annotations.get("conversation/command-cleanup")
            ).toBe(kind)
            expect(
              result.cause.reasons.some(
                (reason) =>
                  reason._tag === "Die" &&
                  typeof reason.defect === "object" &&
                  reason.defect !== null &&
                  "_tag" in reason.defect &&
                  reason.defect._tag === "Fail" &&
                  "annotations" in reason.defect &&
                  reason.defect.annotations instanceof Map &&
                  reason.defect.annotations.get(
                    "conversation/command-cleanup"
                  ) === kind
              )
            ).toBe(true)
            if (withDefect)
              expect(
                result.cause.reasons.some(
                  (reason) => reason._tag === "Die" && reason.defect === defect
                )
              ).toBe(true)
            expect(
              result.cause.reasons.some(
                (reason) =>
                  reason._tag === "Die" && Cause.isCause(reason.defect)
              )
            ).toBe(false)
          }
        })
    )

it.effect(
  "retry admission is serialized, preserves uncertain ids, and never automatically retries",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      const requests: string[] = []
      const owner = yield* makeTurnCommand((request) =>
        Effect.gen(function* () {
          requests.push(request.operationId)
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
          return yield* Effect.fail(new Error("uncertain"))
        })
      )
      yield* send(owner, {
        type: "RETRY",
        turnId: saved.operationId,
        allowed: false,
      })
      yield* Effect.yieldNow
      expect(requests).toEqual([])
      yield* send(owner, {
        type: "RETRY",
        turnId: saved.operationId,
        allowed: true,
      })
      yield* Deferred.await(entered)
      yield* send(owner, {
        type: "RETRY",
        turnId: saved.operationId,
        allowed: true,
      })
      yield* Deferred.succeed(release, undefined)
      yield* waitFor(
        owner,
        (state) => state.matches("ready") && !!state.context.failure
      )
      expect(requests).toHaveLength(1)
      yield* send(owner, {
        type: "RETRY",
        turnId: saved.operationId,
        allowed: true,
      })
      yield* waitFor(
        owner,
        (state) => state.matches("ready") && requests.length === 2
      )
      expect(requests[1]).toBe(requests[0])
    }).pipe(Effect.scoped)
)

it.effect(
  "turn cancellation retains native cleanup ownership until a late request settles",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make(),
        entered = yield* Deferred.make<void>(),
        aborted = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      const requests: string[] = []
      const owner = yield* makeTurnCommand((request) =>
        nativeOperation(
          async (signal) => {
            requests.push(request.operationId)
            Effect.runSync(Deferred.succeed(entered, undefined))
            signal.addEventListener(
              "abort",
              () => Effect.runSync(Deferred.succeed(aborted, undefined)),
              { once: true }
            )
            await Effect.runPromise(Deferred.await(release))
          },
          (cause) => cause
        )
      ).pipe(Effect.provideService(Scope.Scope, scope))
      yield* send(owner, { type: "CANCEL", turnId: saved.operationId })
      yield* Deferred.await(entered)
      yield* send(owner, { type: "CANCEL", turnId: saved.operationId })
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.forkChild
      )
      yield* Deferred.await(aborted)
      expect(closing.pollUnsafe()).toBeUndefined()
      expect(requests).toEqual([saved.operationId])
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(closing)
      expect(requests).toEqual([saved.operationId])
    })
)

it.effect(
  "Stop for distinct active turns proceeds during held retry and cancellation acknowledgements",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make(),
        retryEntered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      const calls: { action: string; turnId: string; signal: AbortSignal }[] =
        []
      const owner = yield* makeTurnCommand((input) =>
        nativeOperation(
          async (signal) => {
            calls.push({ ...input, signal })
            if (input.action === "retry")
              Effect.runSync(Deferred.succeed(retryEntered, undefined))
            await Effect.runPromise(Deferred.await(release))
          },
          (cause) => cause
        )
      ).pipe(Effect.provideService(Scope.Scope, scope))
      yield* send(owner, {
        type: "RETRY",
        turnId: "failed-original",
        allowed: true,
      })
      yield* Deferred.await(retryEntered)
      yield* send(owner, { type: "CANCEL", turnId: "running-a" })
      yield* send(owner, { type: "CANCEL", turnId: "running-b" })
      yield* send(owner, { type: "CANCEL", turnId: "running-a" })
      yield* Effect.promise(async () => {
        for (let count = 0; count < 20 && calls.length < 3; count++)
          await new Promise((resolve) => setTimeout(resolve, 1))
      })
      expect(calls.map(({ action, turnId }) => `${action}:${turnId}`)).toEqual([
        "retry:failed-original",
        "cancel:running-a",
        "cancel:running-b",
      ])
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.forkChild
      )
      yield* Effect.yieldNow
      expect(closing.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(closing)
      expect(calls.every(({ signal }) => signal.aborted)).toBe(true)
    })
)
