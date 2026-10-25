import { it } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { expect, test } from "vitest"

import { requestBackupRecovery } from "../src/features/memory/backup-recovery"
import { makeBackupRecovery } from "../src/features/memory/backup-recovery-owner"
import {
  backupRecoveryMachine,
  type BackupRecoveryRequest,
} from "../src/features/memory/backup-recovery.machine"

const recovery = { attemptId: "failed-one", target: "watermark-one" }

it.effect(
  "backup retry validates the exact failed owner, retains a new failure across late success, and never retries automatically",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const calls: BackupRecoveryRequest[] = []
      const actor = yield* createEffectActor(
        backupRecoveryMachine((request) =>
          Effect.sync(() => {
            calls.push(request)
          }).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Deferred.await(release))
          )
        ),
        { input: { recovery, schedulerRecovery: null } }
      )
      yield* send(actor, { type: "SUBMIT", ...recovery, attemptId: "stale" })
      yield* send(actor, { type: "SUBMIT", ...recovery, target: "different" })
      yield* send(actor, {
        type: "SUBMIT",
        ...recovery,
        attemptId: null,
      } as never)
      yield* send(actor, { type: "SUBMIT", ...recovery })
      yield* Deferred.await(entered)
      yield* send(actor, { type: "SUBMIT", ...recovery })
      const next = { attemptId: "failed-two", target: "watermark-two" }
      yield* send(actor, {
        type: "VIEW",
        recovery: next,
        schedulerRecovery: null,
      })
      yield* waitFor(
        actor,
        (state) => state.context.recovery?.attemptId === next.attemptId
      )
      yield* Deferred.succeed(release, undefined)
      const state = yield* waitFor(actor, (state) => state.matches("ready"))
      expect(state.context.recovery).toEqual(next)
      expect(calls).toEqual([recovery])
      yield* send(actor, { type: "SUBMIT", ...recovery })
      yield* send(actor, { type: "SUBMIT", ...next })
      yield* waitFor(actor, (state) => state.matches("settled"))
      yield* send(actor, { type: "SUBMIT", ...next })
      yield* Effect.yieldNow
      expect(calls).toEqual([recovery, next])
      yield* send(actor, {
        type: "VIEW",
        recovery: null,
        schedulerRecovery: null,
      })
      yield* waitFor(actor, (state) => state.matches("ready"))
    }).pipe(Effect.scoped)
)

it.effect(
  "a failed backup request retains its complete Cause and permits only explicit retry",
  () =>
    Effect.gen(function* () {
      let calls = 0
      const defect = new Error("backup decoder")
      const failure = Cause.fromReasons([
        Cause.makeFailReason("offline"),
        Cause.makeDieReason(defect),
      ])
      const actor = yield* makeBackupRecovery(
        { recovery, schedulerRecovery: null },
        () =>
          Effect.suspend(() => {
            calls++
            return calls === 1 ? Effect.failCause(failure) : Effect.void
          })
      )
      yield* send(actor, { type: "SUBMIT", ...recovery })
      const state = yield* waitFor(
        actor,
        (state) => state.matches("ready") && state.context.outcome !== undefined
      )
      expect(
        state.context.outcome &&
          Exit.isFailure(state.context.outcome) &&
          state.context.outcome.cause.reasons
      ).toMatchObject([
        { _tag: "Fail", error: "offline" },
        { _tag: "Die", defect },
      ])
      yield* send(actor, { type: "VIEW", recovery, schedulerRecovery: null })
      yield* Effect.yieldNow
      expect(calls).toBe(1)
      yield* send(actor, { type: "SUBMIT", ...recovery })
      yield* waitFor(actor, (state) => state.matches("settled"))
      expect(calls).toBe(2)
    }).pipe(Effect.scoped)
)

it.effect(
  "backup control disposal joins pending cleanup and retains late defects",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const cleaning = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      const defect = new Error("late backup cleanup")
      const actor = yield* makeBackupRecovery(
        { recovery, schedulerRecovery: null },
        () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Deferred.succeed(cleaning, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.die(defect))
              )
            )
          )
      ).pipe(Scope.provide(scope))
      yield* send(actor, { type: "SUBMIT", ...recovery })
      yield* Deferred.await(entered)
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.exit,
        Effect.forkChild
      )
      yield* Deferred.await(cleaning)
      expect(closing.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      const exit = yield* Fiber.join(closing)
      expect(Exit.isFailure(exit) && exit.cause.reasons).toContainEqual(
        expect.objectContaining({ _tag: "Die", defect })
      )
      expect(actor.getSnapshot().status).toBe("stopped")
    })
)

test("backup requests send only the failed receipt and refresh after success or conflict", async () => {
  const calls: { path: string; body: unknown; signal: AbortSignal }[] = []
  let refreshes = 0
  const refresh = () => {
    refreshes++
  }
  await Effect.runPromise(
    requestBackupRecovery(
      async (path, body, signal) => {
        calls.push({ path, body, signal })
        return { ok: true }
      },
      refresh,
      recovery
    )
  )
  expect(calls.map(({ path, body }) => ({ path, body }))).toEqual([
    { path: "memory/backup/retry", body: recovery },
  ])
  expect(calls[0]!.signal).toBeInstanceOf(AbortSignal)
  const conflict = new Error("newer backup")
  const exit = await Effect.runPromiseExit(
    requestBackupRecovery(
      async () => {
        throw conflict
      },
      refresh,
      recovery
    )
  )
  expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
    { _tag: "Fail", error: conflict },
  ])
  expect(refreshes).toBe(2)
})

it.effect(
  "scheduler exhaustion admits only its exact epoch and keeps per-backup retry separate",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const calls: unknown[] = []
      const first = {
        epoch: "scheduler-first",
        failedAt: 10,
        message: "Queue unavailable.",
      }
      const actor = yield* createEffectActor(
        backupRecoveryMachine((request) =>
          Effect.sync(() => {
            calls.push(request)
          }).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Deferred.await(release))
          )
        ),
        { input: { recovery: null, schedulerRecovery: first } }
      )
      yield* send(actor, { type: "SUBMIT", ...recovery })
      yield* send(actor, {
        type: "SUBMIT",
        epoch: first.epoch,
        attemptId: "stale-backup",
        target: "stale-target",
      })
      yield* send(actor, { type: "SUBMIT", epoch: "stale" })
      yield* send(actor, { type: "SUBMIT", epoch: first.epoch })
      yield* Deferred.await(entered)
      yield* send(actor, { type: "SUBMIT", epoch: first.epoch })
      const second = { ...first, epoch: "scheduler-second", failedAt: 20 }
      yield* send(actor, { type: "VIEW", recovery, schedulerRecovery: second })
      yield* waitFor(
        actor,
        (state) => state.context.schedulerRecovery?.epoch === second.epoch
      )
      yield* Deferred.succeed(release, undefined)
      yield* waitFor(actor, (state) => state.matches("ready"))
      yield* send(actor, { type: "SUBMIT", ...recovery })
      yield* send(actor, { type: "SUBMIT", epoch: first.epoch })
      yield* Effect.yieldNow
      expect(calls).toEqual([{ epoch: first.epoch }])
      expect(actor.getSnapshot().context.schedulerRecovery).toEqual(second)
      yield* send(actor, { type: "SUBMIT", epoch: second.epoch })
      yield* waitFor(actor, (state) => state.matches("settled"))
      yield* send(actor, { type: "SUBMIT", epoch: second.epoch })
      yield* Effect.yieldNow
      expect(calls).toEqual([{ epoch: first.epoch }, { epoch: second.epoch }])
      yield* send(actor, { type: "VIEW", recovery, schedulerRecovery: null })
      yield* waitFor(actor, (state) => state.matches("ready"))
      expect(calls).toHaveLength(2)
      yield* send(actor, { type: "SUBMIT", ...recovery })
      yield* waitFor(actor, (state) => state.matches("settled"))
      expect(calls).toEqual([
        { epoch: first.epoch },
        { epoch: second.epoch },
        recovery,
      ])
    }).pipe(Effect.scoped)
)

test("backup scheduler recovery posts only its epoch and refreshes after an explicit request", async () => {
  const calls: { path: string; body: unknown }[] = []
  let refreshes = 0
  await Effect.runPromise(
    requestBackupRecovery(
      async (path, body) => {
        calls.push({ path, body })
      },
      () => {
        refreshes++
      },
      { epoch: "scheduler-first" }
    )
  )
  expect(calls).toEqual([
    { path: "memory/backup/recover", body: { epoch: "scheduler-first" } },
  ])
  expect(refreshes).toBe(1)
})
