import { it as effectIt } from "@effect/vitest"
import type { LifecycleJob, LifecycleJobPushOptions } from "agents/lifecycle"
import { Cause, Context, Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  ConversationRunner,
  observeConversationSchedule,
  type ConversationControlAttempt,
} from "../src/conversations/adapters/lifecycle"
import { ConversationExecutionError } from "../src/conversations/execution"
import {
  armConversationDiscovery,
  observeConversationDiscovery,
  readConversationDiscovery,
} from "../src/conversations/recovery-discovery.machine"

vi.mock("agents/lifecycle", () => ({ LifecycleCapability: class {} }))
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function fixture() {
  const jobs = new Map<string, LifecycleJob>()
  const committed: ConversationControlAttempt[] = []
  let currentRevision = 1
  let pending = false
  let beforeTransaction: Effect.Effect<void> = Effect.void
  let failurePersistence = false
  const step = vi.fn(
    async (onAttempt: (attempt: ConversationControlAttempt) => void) => {
      onAttempt({ rootId: "root", revision: currentRevision, phase: "observe" })
      return undefined as number | undefined
    }
  )
  const restore = vi.fn(() => Effect.void)
  const nextWake = vi.fn(() => Effect.succeed(pending ? Date.now() : undefined))
  const runner = new ConversationRunner<never>({
    run: Effect.runPromise,
    step,
    restore,
    nextWake,
    exhaust: (attempt, _error, eligible) =>
      Effect.gen(function* () {
        yield* beforeTransaction
        if (failurePersistence) return yield* Effect.die("database unavailable")
        // The real store checks all three facts in one synchronous SQL transaction.
        if (!eligible() || attempt.revision !== currentRevision) return false
        committed.push(attempt)
        pending = false
        return true
      }),
  })
  const push = vi.fn(async (options: LifecycleJobPushOptions) => {
    const job: LifecycleJob = {
      id: options.id!,
      capability: "personal-chat",
      fn: options.fn,
      time: options.time,
      payload: options.payload,
      retry: options.retry,
      singleflight: options.singleflight ?? false,
      exclusive: options.exclusive ?? false,
      recoveryLoop: options.recoveryLoop ?? false,
      createdAt: Date.now(),
    }
    jobs.set(job.id, job)
    return job
  })
  const reschedule = vi.fn(async (id: string, time: number) => {
    const current = jobs.get(id)
    if (!current) return false
    jobs.set(id, { ...current, time })
    return true
  })
  const rearm = vi.fn(async () => {})
  Object.defineProperty(runner, "lifecycle", {
    value: {
      jobs: { get: (id: string) => jobs.get(id), push, reschedule, rearm },
    },
  })
  return {
    runner,
    jobs,
    step,
    restore,
    nextWake,
    committed,
    push,
    reschedule,
    rearm,
    pump: () => jobs.get("pump")!,
    discovery: () => jobs.get("conversation-recovery")!,
    setPending: (value: boolean) => {
      pending = value
    },
    advanceRevision: () => {
      currentRevision++
      pending = true
    },
    failPersistence: () => {
      failurePersistence = true
    },
    holdTransaction: () => {
      const entered = Deferred.makeUnsafe<void>()
      const release = Deferred.makeUnsafe<void>()
      beforeTransaction = Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
      })
      return {
        entered: () => Effect.runPromise(Deferred.await(entered)),
        release: () => Effect.runPromise(Deferred.succeed(release, undefined)),
      }
    },
  }
}

async function failedPass(f: ReturnType<typeof fixture>, job = f.pump()) {
  f.step.mockImplementation(async (onAttempt) => {
    onAttempt({ rootId: "root", revision: 1, phase: "observe" })
    throw new Error("native observation failed")
  })
  await expect(f.runner.onJob({ job, attempt: 3 })).rejects.toThrow(
    "native observation failed"
  )
  return job
}

describe("conversation discovery lease", () => {
  it("retains the maximum overlapping lease after an early empty scan", () => {
    const first = armConversationDiscovery(undefined, 2000, "first")
    const earlier = armConversationDiscovery(first, 1000, "second")
    expect(earlier.armedUntil).toBe(2000)
    expect(
      observeConversationDiscovery(earlier, { now: 500, pending: false })
    ).toEqual([{ type: "reschedule", at: 2000 }])
    expect(
      observeConversationDiscovery(earlier, { now: 2000, pending: true })
    ).toEqual([{ type: "wake" }])
    expect(
      observeConversationDiscovery(earlier, { now: 2000, pending: false })
    ).toEqual([])
  })

  it("restores exact versioned state and rejects malformed events or future formats", () => {
    const saved = armConversationDiscovery(undefined, 2000, "lease")
    expect(
      readConversationDiscovery(JSON.parse(JSON.stringify(saved)))
    ).toEqual(saved)
    expect(() =>
      readConversationDiscovery({ ...saved, schemaVersion: 2 })
    ).toThrow()
    expect(() => armConversationDiscovery(saved, -1, "invalid")).toThrow()
    expect(() =>
      observeConversationDiscovery(saved, { now: -1, pending: false })
    ).toThrow()
  })

  it("prearms separately from an existing pump and keeps the existing identities", async () => {
    const f = fixture()
    await f.runner.wake()
    const pump = f.pump()
    const before = Date.now()
    const deadline = await f.runner.armDiscovery()
    expect(deadline).toBeGreaterThanOrEqual(before + 60_000)
    expect(f.pump()).toBe(pump)
    expect(f.discovery()).toMatchObject({
      capability: "personal-chat",
      fn: "recover",
      retry: { maxAttempts: 3 },
      payload: { armedUntil: deadline },
    })
    expect(pump).toMatchObject({
      id: "pump",
      fn: "pump",
      retry: { maxAttempts: 3 },
    })
  })

  it("retains discovery when it runs before admission commits", async () => {
    const f = fixture()
    const deadline = await f.runner.armDiscovery()
    const result = await f.runner.onJob({ job: f.discovery(), attempt: 1 })
    expect(result).toEqual({ rescheduleAt: deadline })
    expect(f.pump()).toBeUndefined()
    f.setPending(true)
    await f.runner.onJob({ job: f.discovery(), attempt: 1 })
    expect(f.pump()).toBeDefined()
  })

  it("retains the scan start time when admission commits during a slow scan", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(1000)
    const f = fixture()
    const deadline = await f.runner.armDiscovery()
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    f.nextWake.mockImplementationOnce(() =>
      Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
        return undefined
      })
    )
    const scanning = f.runner.onJob({ job: f.discovery(), attempt: 1 })
    await Effect.runPromise(Deferred.await(entered))
    // The scan observed no row before a valid admission, but its completion
    // arrives after the lease deadline. It must leave one more discovery pass.
    f.setPending(true)
    vi.setSystemTime(deadline + 1)
    await Effect.runPromise(Deferred.succeed(release, undefined))
    expect(await scanning).toEqual({ rescheduleAt: deadline })
    expect(
      await f.runner.onJob({ job: f.discovery(), attempt: 1 })
    ).toBeUndefined()
    expect(f.pump()).toBeDefined()
  })

  it("retains a newer running discovery job when an old empty scan finishes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(1000)
    const f = fixture()
    const deadline = await f.runner.armDiscovery()
    const old = f.discovery()
    vi.setSystemTime(deadline + 1)
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    f.nextWake.mockImplementationOnce(() =>
      Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
        return undefined
      })
    )
    const oldScan = f.runner.onJob({ job: old, attempt: 1 })
    await Effect.runPromise(Deferred.await(entered))
    await f.runner.armDiscovery()
    const newer = f.discovery()
    // The newer alarm has started, setting the SDK's single running bit again.
    await f.runner.onJob({ job: newer, attempt: 1 })
    await Effect.runPromise(Deferred.succeed(release, undefined))
    const outcome = await oldScan
    expect(outcome).toEqual({ rescheduleAt: newer.time })
    // SDK applyOutcome would delete the newer row if this outcome were absent.
    if (!outcome) f.jobs.delete(newer.id)
    expect(f.discovery().payload).toEqual(newer.payload)
  })

  it("retains a newer discovery job after the old lease exhausts its retries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(1000)
    const f = fixture()
    const deadline = await f.runner.armDiscovery()
    const old = f.discovery()
    vi.setSystemTime(deadline + 1)
    await f.runner.armDiscovery()
    const newer = f.discovery()
    expect(
      await f.runner.onJobError({ job: old, attempt: 3 }, "failed")
    ).toEqual({
      rescheduleAt: newer.time,
    })
  })

  it("does not apply the admission lease as a Pi execution or approval deadline", async () => {
    const f = fixture()
    await f.runner.armDiscovery()
    await f.runner.wake()
    const future = Date.now() + 300_000
    f.step.mockResolvedValue(future)
    expect(await f.runner.onJob({ job: f.pump(), attempt: 1 })).toEqual({
      rescheduleAt: future,
    })
  })
})

describe("conversation job ownership", () => {
  it("rearms repeated wakes during a failed dispatch without replacing or retiming its retry", async () => {
    const f = fixture()
    await f.runner.wake()
    const job = await failedPass(f)
    const pushes = f.push.mock.calls.length
    await f.runner.wake()
    await f.runner.wake()
    await f.runner.wake()
    expect(f.push).toHaveBeenCalledTimes(pushes)
    expect(f.reschedule).not.toHaveBeenCalled()
    expect(f.rearm).toHaveBeenCalledTimes(3)
    expect(f.pump()).toBe(job)
    await f.runner.onJobError({ job, attempt: 3 }, "failed")
    expect(f.committed).toEqual([
      { rootId: "root", revision: 1, phase: "observe" },
    ])
  })

  it("uses the SDK's next attempt without changing native control receipt identity", async () => {
    const f = fixture()
    await f.runner.wake()
    const job = await failedPass(f)
    f.step.mockResolvedValueOnce(Date.now() + 30_000)
    await f.runner.onJob({ job, attempt: 2 })
    expect(f.step).toHaveBeenCalledTimes(2)
    await f.runner.wake()
    expect(f.reschedule).toHaveBeenCalledTimes(1)
  })

  it("requests immediate followup after a successful pass when Stop rings its doorbell", async () => {
    const f = fixture()
    await f.runner.wake()
    let finish!: (next: number) => void
    f.step.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve
        })
    )
    const work = f.runner.onJob({ job: f.pump(), attempt: 1 })
    await f.runner.wake()
    const now = Date.now()
    finish(now + 30_000)
    const result = await work
    expect(result).toEqual({ rescheduleAt: expect.any(Number) })
    expect((result as { rescheduleAt: number }).rescheduleAt).toBeLessThan(
      now + 1000
    )
    expect(f.reschedule).not.toHaveBeenCalled()
  })

  it("does not let a warm hung replacement dispatch while the original owns native work", async () => {
    const f = fixture()
    await f.runner.wake()
    const job = f.pump()
    let finish!: () => void
    f.step.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined)
        })
    )
    const original = f.runner.onJob({ job, attempt: 1 })
    const replacement = await f.runner.onJob({ job: { ...job }, attempt: 1 })
    expect(replacement).toEqual({ rescheduleAt: expect.any(Number) })
    expect(f.step).toHaveBeenCalledTimes(1)
    finish()
    await original
  })

  it("retains a newer pump job when old joined work completes", async () => {
    const f = fixture()
    await f.runner.wake()
    const old = f.pump()
    let finish!: () => void
    f.step.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined)
        })
    )
    const work = f.runner.onJob({ job: old, attempt: 1 })
    f.jobs.delete(old.id)
    await f.runner.wake()
    const newer = f.pump()
    finish()
    expect(await work).toEqual({ rescheduleAt: newer.time })
    expect(f.pump()).toBe(newer)
  })

  it("does not dispatch a stale queued callback over a newer pump token", async () => {
    const f = fixture()
    await f.runner.wake()
    const old = f.pump()
    f.jobs.delete(old.id)
    await f.runner.wake()
    const newer = f.pump()
    expect(await f.runner.onJob({ job: old, attempt: 1 })).toEqual({
      rescheduleAt: newer.time,
    })
    expect(f.step).not.toHaveBeenCalled()
  })

  it("exhausts the original root even when an unrelated later admission prearms", async () => {
    const f = fixture()
    await f.runner.wake()
    const job = await failedPass(f)
    const held = f.holdTransaction()
    const work = f.runner.onJobError({ job, attempt: 3 }, "failed")
    await held.entered()
    await f.runner.armDiscovery()
    await held.release()
    await work
    expect(f.committed).toHaveLength(1)
  })

  it("rejects an old failure after a newer Stop revision and retains that Stop wake", async () => {
    const f = fixture()
    await f.runner.wake()
    const job = await failedPass(f)
    const held = f.holdTransaction()
    const work = f.runner.onJobError({ job, attempt: 3 }, "failed")
    await held.entered()
    f.advanceRevision()
    await held.release()
    expect(await work).toEqual({ rescheduleAt: expect.any(Number) })
    expect(f.committed).toEqual([])
  })

  it("re-reads the job token inside the exhaustion transaction", async () => {
    const f = fixture()
    await f.runner.wake()
    const job = await failedPass(f)
    const held = f.holdTransaction()
    const work = f.runner.onJobError({ job, attempt: 3 }, "failed")
    await held.entered()
    f.jobs.delete("pump")
    await f.runner.wake()
    await held.release()
    expect(await work).toEqual({ rescheduleAt: f.pump().time })
    expect(f.committed).toEqual([])
  })

  it("does not renew exhausted work when its failure cannot be persisted", async () => {
    const f = fixture()
    await f.runner.wake()
    const job = await failedPass(f)
    f.setPending(true)
    f.failPersistence()
    expect(
      await f.runner.onJobError({ job, attempt: 3 }, "failed")
    ).toBeUndefined()
    expect(f.committed).toEqual([])
    expect(f.nextWake).not.toHaveBeenCalled()
  })

  it("restores cold owners once even when reconciliation is requested repeatedly", async () => {
    const f = fixture()
    f.setPending(true)
    await Promise.all([f.runner.reconcile(), f.runner.reconcile()])
    await f.runner.reconcile()
    expect(f.restore).toHaveBeenCalledTimes(1)
    expect(f.push).toHaveBeenCalledTimes(1)
    expect(f.pump()).toBeDefined()
  })

  it("rearms existing queue intent without replacing its retry identity", async () => {
    const f = fixture()
    await f.runner.wake()
    const job = f.pump()
    await f.runner.reconcile()
    expect(f.pump()).toBe(job)
    expect(f.push).toHaveBeenCalledTimes(1)
    expect(f.reschedule).not.toHaveBeenCalled()
  })

  it("supports restored legacy payloadless pump jobs", async () => {
    const f = fixture()
    await f.runner.wake()
    const job = { ...f.pump(), payload: undefined }
    f.jobs.set(job.id, job)
    await f.runner.onJob({ job, attempt: 1 })
    expect(f.step).toHaveBeenCalledTimes(1)
  })

  it.each(["pump", "recover"] as const)(
    "rejects unknown %s payload versions before dispatch",
    async (fn) => {
      const f = fixture()
      await f.runner.wake()
      await f.runner.armDiscovery()
      const original = fn === "pump" ? f.pump() : f.discovery()
      const job = {
        ...original,
        payload: { ...(original.payload as object), workflowVersion: 2 },
      }
      f.jobs.set(job.id, job)
      await expect(f.runner.onJob({ job, attempt: 1 })).rejects.toThrow()
      await expect(f.runner.reconcile()).rejects.toThrow()
      expect(f.step).not.toHaveBeenCalled()
      expect(f.restore).not.toHaveBeenCalled()
      expect(f.nextWake).not.toHaveBeenCalled()
    }
  )

  it("rejects an unknown function instead of dispatching it as a pump", async () => {
    const f = fixture()
    await f.runner.wake()
    await expect(
      f.runner.onJob({ job: { ...f.pump(), fn: "future" }, attempt: 1 })
    ).rejects.toThrow("Unsupported conversation job")
    expect(f.step).not.toHaveBeenCalled()
  })
})

class PrearmReason extends Context.Service<PrearmReason, string>()(
  "ConversationPrearmReason"
) {}

for (const scheduling of ["prearm", "wake"] as const)
  for (const late of ["success", "failure"] as const)
    effectIt.effect(
      `${scheduling} deadline lets uninterruptible Stop revoke before late ${late}`,
      () =>
        Effect.gen(function* () {
          let resolve!: (deadline: number) => void,
            reject!: (cause: unknown) => void,
            started!: () => void,
            armed = false,
            admitted = false,
            revoked = false
          const pending = new Promise<number>((accept, refuse) => {
              resolve = accept
              reject = refuse
            }),
            entered = new Promise<void>((accept) => {
              started = accept
            })
          const f = fixture()
          const push = f.push.getMockImplementation()!
          f.push.mockImplementationOnce(async (options) => {
            started()
            await pending
            // This is the only late effect: the actual runner prearm eventually
            // reaches Lifecycle. No turn admission or native work happens here.
            armed = true
            return push(options)
          })
          const stop = yield* Effect.uninterruptible(
            observeConversationSchedule<number | void>(
              "arm conversation discovery",
              () =>
                scheduling === "prearm"
                  ? f.runner.armDiscovery()
                  : f.runner.wake()
            ).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  admitted = true
                })
              ),
              Effect.exit,
              Effect.tap(() =>
                Effect.sync(() => {
                  revoked = true
                })
              )
            )
          ).pipe(Effect.forkChild)
          yield* Effect.promise(() => entered)
          yield* TestClock.adjust(4999)
          expect(stop.pollUnsafe()).toBeUndefined()
          expect(revoked).toBe(false)
          yield* TestClock.adjust(1)
          yield* Effect.yieldNow
          const completedAtDeadline = stop.pollUnsafe()
          // Release a broken implementation before asserting so the negative
          // control cannot leave an uninterruptible test fiber waiting forever.
          if (!completedAtDeadline) {
            reject(new Error("Observation failed to honor its deadline"))
            yield* Fiber.join(stop)
          }
          expect(completedAtDeadline).toBeDefined()
          const exit = yield* Fiber.join(stop)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit))
            expect(exit.cause.reasons).toMatchObject([
              {
                _tag: "Fail",
                error: {
                  _tag: "ConversationExecutionError",
                  operation: "arm conversation discovery",
                },
              },
            ])
          expect(revoked).toBe(true)
          expect(admitted).toBe(false)
          expect(armed).toBe(false)
          if (late === "success") resolve(60_000)
          else reject(new Error("Late queue rejection"))
          yield* Effect.promise(() =>
            pending.then(
              () => undefined,
              () => undefined
            )
          )
          yield* Effect.yieldNow
          expect(armed).toBe(late === "success")
          expect(!!f.discovery()).toBe(
            late === "success" && scheduling === "prearm"
          )
          expect(!!f.pump()).toBe(late === "success" && scheduling === "wake")
          expect(f.step).not.toHaveBeenCalled()
          expect(f.committed).toEqual([])
          expect(admitted).toBe(false)
          expect(revoked).toBe(true)
        })
    )

describe("conversation prearm observation failures", () => {
  it("starts once lazily and returns only the confirmed lease value", async () => {
    const start = vi.fn(async () => 60_000)
    const work = observeConversationSchedule(
      "arm conversation discovery",
      start
    )
    expect(start).not.toHaveBeenCalled()
    expect(await Effect.runPromise(work)).toBe(60_000)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it.each(["ordinary", "declared"] as const)(
    "keeps synchronous %s setup throws fatal",
    async (kind) => {
      const defect =
        kind === "ordinary"
          ? new Error("Synchronous queue setup failed")
          : new ConversationExecutionError({
              operation: "setup",
              cause: "invalid",
            })
      const exit = await Effect.runPromiseExit(
        observeConversationSchedule("arm conversation discovery", () => {
          throw defect
        })
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit))
        expect(exit.cause.reasons).toMatchObject([{ _tag: "Die", defect }])
    }
  )

  it("maps an asynchronous scheduling rejection to its declared execution failure", async () => {
    const error = new Error("Queue unavailable")
    const exit = await Effect.runPromiseExit(
      observeConversationSchedule("arm conversation discovery", () =>
        Promise.reject(error)
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
      expect(exit.cause.reasons).toMatchObject([
        {
          _tag: "Fail",
          error: { _tag: "ConversationExecutionError", cause: error },
        },
      ])
  })

  it.each([true, false])(
    "preserves compound causes and annotations (declared checked failure: %s)",
    async (declared) => {
      const error = declared
        ? new ConversationExecutionError({
            operation: "arm",
            cause: "unavailable",
          })
        : { _tag: "UnknownCheckedFailure" }
      const original = Cause.fromReasons([
        Cause.makeFailReason(error).annotate(
          Context.make(PrearmReason, "checked")
        ),
        Cause.makeDieReason(new Error("Cleanup defect")).annotate(
          Context.make(PrearmReason, "defect")
        ),
        Cause.makeInterruptReason(81).annotate(
          Context.make(PrearmReason, "interrupted")
        ),
      ])
      const exit = await Effect.runPromiseExit(
        observeConversationSchedule("arm conversation discovery", () =>
          Promise.reject(original)
        )
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual([
          declared ? "Fail" : "Die",
          "Die",
          "Interrupt",
        ])
        expect(exit.cause.reasons[1]).toBe(original.reasons[1])
        expect(exit.cause.reasons[2]).toBe(original.reasons[2])
        expect(
          exit.cause.reasons.map((reason) =>
            reason.annotations.get(PrearmReason.key)
          )
        ).toEqual(["checked", "defect", "interrupted"])
      }
    }
  )
})
