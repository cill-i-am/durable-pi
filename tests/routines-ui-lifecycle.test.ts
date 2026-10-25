import { it } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"

import { makeRoutinesOwner } from "../src/features/routines/routines-owner"
import {
  routinesUiMachine,
  type RoutineCommand,
  type RoutinesWork,
} from "../src/features/routines/routines-ui.machine"
import { makeWebhookOwner } from "../src/features/routines/webhook-owner"
import {
  webhookUiMachine,
  type WebhookWork,
} from "../src/features/routines/webhook-ui.machine"
import type {
  Routine,
  RoutineChange,
  RoutineList,
} from "../src/routines/contracts"
import { nativeOperation } from "../src/shared/interop"
import type { ConfigureWebhook, WebhookInfo } from "../src/webhooks/contracts"

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  operationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const routine: Routine = {
  id,
  title: "Proof",
  prompt: "Read notes",
  schedule: { type: "webhook" },
  status: "active",
  revision: 1,
  nextAt: null,
  createdAt: 1,
  updatedAt: 1,
}
const list: RoutineList = { routines: [routine], runs: [] }
const change: RoutineCommand = {
  path: "status",
  body: { id, operationId, expectedRevision: 1, status: "paused" },
}
const changed: RoutineChange = {
  routine: { ...routine, status: "paused", revision: 2 },
  run: null,
}
const work = (override: Partial<RoutinesWork> = {}): RoutinesWork => ({
  read: () => Effect.succeed(list),
  change: () => Effect.succeed(changed),
  resolve: () => Effect.succeed({ applied: true, data: list }),
  stop: () => Effect.succeed(list),
  ...override,
})
const hook: WebhookInfo = {
  routineId: id,
  enabled: false,
  revision: 1,
  accepted: 0,
}
const configured: WebhookInfo = { ...hook, enabled: true, revision: 2 }
const command: ConfigureWebhook = {
  routineId: id,
  operationId,
  expectedRevision: 1,
  key: "rpwh_" + "a".repeat(64),
}
const hookWork = (override: Partial<WebhookWork> = {}): WebhookWork => ({
  read: () => Effect.succeed(hook),
  change: () => Effect.succeed({ result: configured, current: configured }),
  resolve: () => Effect.succeed({ applied: true, current: configured }),
  ...override,
})

it.effect(
  "a lost acknowledgement retains the exact routine operation and blocks different or duplicate commands",
  () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<RoutineChange, Error>()
      const calls: RoutineCommand[] = []
      const actor = yield* createEffectActor(
        routinesUiMachine(
          work({
            change: (input) =>
              Effect.sync(() => calls.push(input)).pipe(
                Effect.andThen(Deferred.await(gate))
              ),
          })
        ),
        { input: { view: "editor" } }
      )
      yield* waitFor(actor, (s) => s.matches("waiting"))
      yield* send(actor, { type: "SEND", change, view: "editor" })
      yield* waitFor(actor, (s) => s.matches("submitting"))
      yield* send(actor, { type: "SEND", change, view: "editor" })
      yield* Deferred.fail(gate, new Error("acknowledgement lost"))
      yield* waitFor(actor, (s) => s.matches("uncertain"))
      yield* send(actor, {
        type: "SEND",
        change: { ...change, body: { ...change.body, operationId: id } },
        view: "editor",
      })
      yield* send(actor, { type: "STOP", id })
      yield* Effect.yieldNow
      expect(calls).toHaveLength(1)
      yield* send(actor, { type: "RETRY" })
      yield* waitFor(actor, (s) => s.matches("uncertain") && calls.length === 2)
      expect(calls).toEqual([change, change])
      expect(actor.getSnapshot().context.attempt).toEqual(change)
    }).pipe(Effect.scoped)
)

it.effect(
  "a held acknowledgement cannot close an editor after A to B to A navigation",
  () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<RoutineChange>()
      const actor = yield* createEffectActor(
        routinesUiMachine(work({ change: () => Deferred.await(gate) })),
        { input: { view: "A" } }
      )
      const applied: unknown[] = []
      actor.on("applied", (e) => applied.push(e))
      yield* waitFor(actor, (s) => s.matches("waiting"))
      yield* send(actor, { type: "SEND", change, view: "A" })
      yield* waitFor(actor, (s) => s.matches("submitting"))
      yield* send(actor, { type: "VIEW", view: "B" })
      yield* send(actor, { type: "VIEW", view: "A" })
      yield* waitFor(actor, (s) => s.context.viewRevision === 2)
      yield* Deferred.succeed(gate, changed)
      yield* waitFor(actor, (s) => s.context.attempt === null)
      expect(applied).toEqual([])
    }).pipe(Effect.scoped)
)

it.effect(
  "cancel resolution cannot retire an uncertain request until the authoritative read succeeds",
  () =>
    Effect.gen(function* () {
      let resolves = 0
      const actor = yield* createEffectActor(
        routinesUiMachine(
          work({
            change: () => Effect.fail(new Error("lost")),
            resolve: () =>
              Effect.suspend(() =>
                ++resolves === 1
                  ? Effect.fail(new Error("current read unavailable"))
                  : Effect.succeed({ applied: false, data: list })
              ),
          })
        ),
        { input: { view: "list" } }
      )
      yield* waitFor(actor, (s) => s.matches("waiting"))
      yield* send(actor, { type: "SEND", change, view: "list" })
      yield* waitFor(actor, (s) => s.matches("uncertain"))
      yield* send(actor, { type: "RESOLVE" })
      yield* waitFor(
        actor,
        (s) => s.context.error === "current read unavailable"
      )
      expect(actor.getSnapshot().context.attempt).toEqual(change)
      yield* send(actor, { type: "RESOLVE" })
      yield* waitFor(actor, (s) => s.context.attempt === null)
      expect(resolves).toBe(2)
    }).pipe(Effect.scoped)
)

it.effect(
  "an uncertain Stop keeps its exact existing run, and cannot become a fresh run command",
  () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const actor = yield* createEffectActor(
        routinesUiMachine(
          work({
            stop: (id) =>
              Effect.sync(() => calls.push(id)).pipe(
                Effect.andThen(Effect.fail(new Error("Stop uncertain")))
              ),
          })
        ),
        { input: { view: "list" } }
      )
      yield* waitFor(actor, (s) => s.matches("waiting"))
      yield* send(actor, { type: "STOP", id })
      yield* waitFor(actor, (s) => s.matches("uncertain"))
      yield* send(actor, { type: "STOP", id: operationId })
      yield* send(actor, { type: "SEND", change, view: "list" })
      yield* Effect.yieldNow
      expect(calls).toEqual([id])
      expect(actor.getSnapshot().context.attempt).toBeNull()
      yield* send(actor, { type: "RETRY_STOP" })
      yield* waitFor(actor, (s) => s.matches("uncertain") && calls.length === 2)
      expect(calls).toEqual([id, id])
    }).pipe(Effect.scoped)
)

it.effect(
  "routine observation recovers after four transient failures at the original four-second cadence",
  () =>
    Effect.gen(function* () {
      let reads = 0,
        healthy = false
      const actor = yield* createEffectActor(
        routinesUiMachine(
          work({
            read: () =>
              Effect.suspend(() => {
                reads++
                return healthy
                  ? Effect.succeed(list)
                  : Effect.fail(new Error("offline"))
              }),
          })
        ),
        { input: { view: "list" } }
      )
      yield* waitFor(actor, (s) => s.context.failures === 1)
      for (let failure = 2; failure <= 4; failure++) {
        yield* TestClock.adjust(4000)
        yield* waitFor(actor, (s) => s.context.failures === failure)
      }
      expect(actor.getSnapshot().matches("waiting")).toBe(true)
      expect(reads).toBe(4)
      healthy = true
      yield* TestClock.adjust(3999)
      expect(reads).toBe(4)
      yield* TestClock.adjust(1)
      yield* waitFor(actor, (s) => s.context.failures === 0)
      expect(reads).toBe(5)
      expect(actor.getSnapshot().context.data).toEqual(list)
    }).pipe(Effect.scoped)
)

it.effect(
  "webhook verification hides a stale secret after a newer configuration wins",
  () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<{
        result: WebhookInfo
        current: WebhookInfo
      }>()
      const actor = yield* createEffectActor(
        webhookUiMachine(hookWork({ change: () => Deferred.await(gate) })),
        { input: { routineId: id } }
      )
      yield* waitFor(actor, (s) => s.matches("ready"))
      yield* send(actor, { type: "SEND", change: command })
      yield* waitFor(actor, (s) => s.matches("submitting"))
      yield* Deferred.succeed(gate, {
        result: configured,
        current: { ...configured, revision: 3 },
      })
      yield* waitFor(actor, (s) => s.matches("ready"))
      expect(actor.getSnapshot().context.key).toBeNull()
      expect(actor.getSnapshot().context.info?.revision).toBe(3)
      expect(actor.getSnapshot().context.message).toContain("changed again")
    }).pipe(Effect.scoped)
)

it.effect(
  "webhook retries preserve exact key, expected revision and operation identity until resolution",
  () =>
    Effect.gen(function* () {
      const calls: ConfigureWebhook[] = []
      const actor = yield* createEffectActor(
        webhookUiMachine(
          hookWork({
            change: (input) =>
              Effect.sync(() => calls.push(input)).pipe(
                Effect.andThen(Effect.fail(new Error("lost ack")))
              ),
          })
        ),
        { input: { routineId: id } }
      )
      yield* waitFor(actor, (s) => s.matches("ready"))
      yield* send(actor, { type: "SEND", change: command })
      yield* waitFor(actor, (s) => s.matches("uncertain"))
      yield* send(actor, {
        type: "SEND",
        change: { ...command, key: "rpwh_" + "b".repeat(64) },
      })
      yield* send(actor, { type: "REFRESH" })
      yield* Effect.yieldNow
      expect(calls).toEqual([command])
      yield* send(actor, { type: "RETRY" })
      yield* waitFor(actor, (s) => s.matches("uncertain") && calls.length === 2)
      expect(calls).toEqual([command, command])
      yield* send(actor, { type: "RESOLVE" })
      yield* waitFor(actor, (s) => s.matches("ready"))
      expect(actor.getSnapshot().context.key).toEqual({
        value: command.key,
        revision: 2,
      })
    }).pipe(Effect.scoped)
)

for (const kind of ["routine", "webhook"] as const) {
  it.effect(
    `${kind} owner aborts and joins native work, retaining its full late cleanup Cause`,
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make(),
          started = yield* Deferred.make<void>(),
          aborted = yield* Deferred.make<void>()
        let reject!: (cause: unknown) => void
        const held = nativeOperation<never, unknown>(
          (signal) =>
            new Promise((_, fail) => {
              reject = fail
              signal.addEventListener("abort", () =>
                Effect.runSync(Deferred.succeed(aborted, undefined))
              )
              Effect.runSync(Deferred.succeed(started, undefined))
            }),
          (cause) => cause
        )
        if (kind === "routine") {
          const actor = yield* makeRoutinesOwner(
            "list",
            work({ change: () => held })
          ).pipe(Scope.provide(scope))
          yield* waitFor(actor, (s) => s.matches("waiting"))
          yield* send(actor, { type: "SEND", change, view: "list" })
        } else {
          const actor = yield* makeWebhookOwner(
            id,
            hookWork({ change: () => held })
          ).pipe(Scope.provide(scope))
          yield* waitFor(actor, (s) => s.matches("ready"))
          yield* send(actor, { type: "SEND", change: command })
        }
        yield* Deferred.await(started)
        const closing = yield* Effect.forkChild(
          Effect.exit(Scope.close(scope, Exit.void))
        )
        yield* Deferred.await(aborted)
        expect(closing.pollUnsafe()).toBeUndefined()
        const defect = new Error("late cleanup")
        reject(
          Cause.fromReasons([
            ...Cause.fail("checked fault").reasons,
            ...Cause.die(defect).reasons,
            ...Cause.interrupt(89123).reasons,
          ])
        )
        const result = yield* Fiber.join(closing)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          expect(result.cause.reasons).toContainEqual(
            expect.objectContaining({ _tag: "Die", defect })
          )
          expect(result.cause.reasons).toContainEqual(
            expect.objectContaining({ _tag: "Interrupt", fiberId: 89123 })
          )
          expect(Cause.pretty(result.cause)).toContain("checked fault")
        }
      })
  )
}

it.effect(
  "malformed or foreign webhook commands and malformed routine IDs never dispatch",
  () =>
    Effect.gen(function* () {
      let requests = 0
      const routines = yield* createEffectActor(
        routinesUiMachine(
          work({
            change: () =>
              Effect.sync(() => {
                requests++
                return changed
              }),
          })
        ),
        { input: { view: "list" } }
      )
      const webhook = yield* createEffectActor(
        webhookUiMachine(
          hookWork({
            change: () =>
              Effect.sync(() => {
                requests++
                return { result: configured, current: configured }
              }),
          })
        ),
        { input: { routineId: id } }
      )
      yield* waitFor(routines, (s) => s.matches("waiting"))
      yield* waitFor(webhook, (s) => s.matches("ready"))
      yield* send(routines, {
        type: "SEND",
        change: { ...change, body: { ...change.body, operationId: "bad" } },
        view: "list",
      } as never)
      yield* send(webhook, {
        type: "SEND",
        change: { ...command, key: "bad" },
      } as never)
      yield* send(webhook, {
        type: "SEND",
        change: { ...command, routineId: operationId },
      })
      yield* send(webhook, {
        type: "SEND",
        change: { ...command, expectedRevision: 99 },
      })
      yield* Effect.yieldNow
      expect(requests).toBe(0)
    }).pipe(Effect.scoped)
)

it.effect(
  "a hidden mounted page retains the original no-read polling behavior until a visible tick",
  () =>
    Effect.gen(function* () {
      let reads = 0
      const actor = yield* createEffectActor(
        routinesUiMachine(
          work({
            read: () =>
              Effect.sync(() => {
                reads++
                return list
              }),
          })
        ),
        { input: { view: "list", visible: false } }
      )
      yield* waitFor(actor, (state) => state.matches("waiting"))
      yield* TestClock.adjust(4000)
      expect(reads).toBe(0)
      yield* send(actor, { type: "VISIBLE", visible: true })
      yield* waitFor(actor, (state) => state.context.visible)
      yield* TestClock.adjust(3999)
      expect(reads).toBe(0)
      yield* TestClock.adjust(1)
      yield* waitFor(actor, (state) => state.context.data !== null)
      expect(reads).toBe(1)
    }).pipe(Effect.scoped)
)

for (const path of ["save", "status", "run"] as const) {
  it.effect(
    `${path} retries retain their admitted fields after caller mutation`,
    () =>
      Effect.gen(function* () {
        const input = {
          path,
          body: {
            id,
            operationId,
            expectedRevision: 1,
            ...(path === "run" ? {} : { status: "paused" }),
            ...(path === "save"
              ? {
                  title: "Admitted title",
                  prompt: "Admitted prompt",
                  schedule: { type: "interval", at: 1000, minutes: 15 },
                }
              : {}),
          },
        }
        const original = structuredClone(input)
        const calls: RoutineCommand[] = [],
          resolved: RoutineCommand[] = []
        const actor = yield* makeRoutinesOwner(
          "editor",
          work({
            change: (value) =>
              Effect.sync(() => calls.push(structuredClone(value))).pipe(
                Effect.andThen(Effect.fail("uncertain"))
              ),
            resolve: (value) =>
              Effect.sync(() => {
                resolved.push(structuredClone(value))
                return { applied: false, data: list }
              }),
          })
        )
        yield* waitFor(actor, (s) => s.matches("waiting"))
        yield* send(actor, {
          type: "SEND",
          change: input as RoutineCommand,
          view: "editor",
        })
        yield* waitFor(actor, (s) => s.matches("uncertain"))
        input.body.operationId = id
        input.body.expectedRevision = 99
        if (input.body.status) input.body.status = "active"
        if (input.body.schedule) {
          input.body.schedule.minutes = 60
          input.body.schedule.at = 9000
          input.body.title = "New title"
        }
        yield* send(actor, { type: "RETRY" })
        yield* waitFor(
          actor,
          (s) => s.matches("uncertain") && calls.length === 2
        )
        yield* send(actor, { type: "RESOLVE" })
        yield* waitFor(actor, (s) => s.context.attempt === null)
        expect(calls).toEqual([original, original])
        expect(resolved).toEqual([original])
      }).pipe(Effect.scoped)
  )
}

it.effect(
  "webhook retry and resolution retain the admitted secret and CAS identity after caller mutation",
  () =>
    Effect.gen(function* () {
      const input = { ...command },
        original = { ...command }
      const calls: ConfigureWebhook[] = [],
        resolved: ConfigureWebhook[] = []
      const actor = yield* makeWebhookOwner(
        id,
        hookWork({
          change: (value) =>
            Effect.sync(() => calls.push({ ...value })).pipe(
              Effect.andThen(Effect.fail("uncertain"))
            ),
          resolve: (value) =>
            Effect.sync(() => {
              resolved.push({ ...value })
              return { applied: true, current: configured }
            }),
        })
      )
      yield* waitFor(actor, (s) => s.matches("ready"))
      yield* send(actor, { type: "SEND", change: input })
      yield* waitFor(actor, (s) => s.matches("uncertain"))
      input.operationId = id
      input.expectedRevision = 99
      input.key = "rpwh_" + "b".repeat(64)
      yield* send(actor, { type: "RETRY" })
      yield* waitFor(actor, (s) => s.matches("uncertain") && calls.length === 2)
      yield* send(actor, { type: "RESOLVE" })
      yield* waitFor(actor, (s) => s.matches("ready"))
      expect(calls).toEqual([original, original])
      expect(resolved).toEqual([original])
      expect(actor.getSnapshot().context.key?.value).toBe(original.key)
    }).pipe(Effect.scoped)
)

class CleanupOrigin extends Context.Service<CleanupOrigin, string>()(
  "RoutineCleanupOrigin"
) {}
for (const mode of ["native", "effect"] as const) {
  for (const kind of ["routine", "webhook"] as const) {
    it.effect(
      `${kind} joins ${mode} cleanup and retains annotated Fail plus Interrupt without Die`,
      () =>
        Effect.gen(function* () {
          const scope = yield* Scope.make(),
            entered = yield* Deferred.make<void>(),
            aborted = yield* Deferred.make<void>(),
            released = yield* Deferred.make<void>()
          let reject!: (value: unknown) => void
          const annotation = Context.make(
            CleanupOrigin,
            "original native cleanup"
          )
          const failure =
            Cause.makeFailReason("checked cleanup").annotate(annotation)
          const interruption =
            Cause.makeInterruptReason(91234).annotate(annotation)
          const cause = Cause.fromReasons([failure, interruption])
          const held =
            mode === "native"
              ? nativeOperation<never, unknown>(
                  (signal) =>
                    new Promise((_, fail) => {
                      reject = fail
                      signal.addEventListener(
                        "abort",
                        () =>
                          Effect.runSync(Deferred.succeed(aborted, undefined)),
                        { once: true }
                      )
                      Effect.runSync(Deferred.succeed(entered, undefined))
                    }),
                  (value) => value
                )
              : Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(released)),
                  Effect.andThen(Effect.failCause(cause)),
                  Effect.uninterruptible
                )
          if (kind === "routine")
            yield* makeRoutinesOwner("list", work({ read: () => held })).pipe(
              Scope.provide(scope)
            )
          else
            yield* makeWebhookOwner(id, hookWork({ read: () => held })).pipe(
              Scope.provide(scope)
            )
          yield* Deferred.await(entered)
          const closing = yield* Effect.forkChild(
            Effect.exit(Scope.close(scope, Exit.void))
          )
          if (mode === "native") yield* Deferred.await(aborted)
          else yield* Effect.yieldNow
          expect(closing.pollUnsafe()).toBeUndefined()
          if (mode === "native") reject(cause)
          else yield* Deferred.succeed(released, undefined)
          const exit = yield* Fiber.join(closing)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const retainedInterrupt = exit.cause.reasons.find(
              (reason) =>
                reason._tag === "Interrupt" && reason.fiberId === 91234
            )
            expect(retainedInterrupt).toBeDefined()
            expect(retainedInterrupt?.annotations.get(CleanupOrigin.key)).toBe(
              "original native cleanup"
            )
            const retainedFail = exit.cause.reasons.find(
              (reason) =>
                reason._tag === "Die" &&
                Cause.isReason(reason.defect) &&
                Cause.isFailReason(reason.defect) &&
                reason.defect.error === "checked cleanup"
            )
            expect(retainedFail).toBeDefined()
            if (
              retainedFail?._tag === "Die" &&
              Cause.isReason(retainedFail.defect) &&
              Cause.isFailReason(retainedFail.defect)
            )
              expect(
                retainedFail.defect.annotations.get(CleanupOrigin.key)
              ).toBe("original native cleanup")
            expect(
              exit.cause.reasons.some(
                (reason) =>
                  reason._tag === "Die" && Cause.isCause(reason.defect)
              )
            ).toBe(false)
          }
        })
    )
  }
}
