import { AsyncLocalStorage } from "node:async_hooks"

import { it as effectIt } from "@effect/vitest"
import type { LifecycleJob, LifecycleJobPushOptions } from "agents/lifecycle"
import { Cause, Context, Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, describe, expect, it, vi } from "vitest"
import { initialTransition, transition } from "xstate"

import {
  CommunicationRunner,
  observeCommunicationSchedule,
  type CommunicationControlAttempt,
} from "../src/communication/adapters/lifecycle"
import { CommunicationError } from "../src/communication/contracts"
import {
  armCommunicationDiscovery,
  observeCommunicationDiscovery,
  readCommunicationDiscovery,
} from "../src/communication/recovery.machine"
import { communicationRunnerMachine } from "../src/communication/runner.machine"

vi.mock("agents/lifecycle", () => ({ LifecycleCapability: class {} }))
const owners = new Set<CommunicationRunner<unknown>>()
afterEach(async () => {
  await Promise.allSettled([...owners].map((owner) => owner.dispose()))
  owners.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function fixture() {
  const jobs = new Map<string, LifecycleJob>()
  const records = new Map<string, unknown>()
  type Storage = {
    get: (key: string) => Promise<unknown>
    put: (key: string, value: unknown) => Promise<void>
    delete: (key: string) => Promise<boolean>
    transaction: <T>(work: (tx: Storage) => Promise<T>) => Promise<T>
  }
  const storage: Storage = {
    get: async (key: string) => records.get(key),
    put: async (key: string, value: unknown) => {
      records.set(key, value)
    },
    delete: async (key: string) => records.delete(key),
    transaction: async <T>(work: (tx: Storage) => Promise<T>): Promise<T> =>
      work(storage),
  }
  const committed: CommunicationControlAttempt[] = []
  let currentRevision = 1
  let pending = false
  let beforeTransaction: Effect.Effect<void> = Effect.void
  let failurePersistence = false
  const step = vi.fn(
    async (
      onAttempt: (attempt: CommunicationControlAttempt | undefined) => void
    ) => {
      onAttempt({
        taskId: "root",
        owner: "owner",
        revision: currentRevision,
        phase: "observe",
      })
      return undefined as number | undefined
    }
  )
  const restore = vi.fn<() => Effect.Effect<void, unknown>>(() => Effect.void)
  const nextWake = vi.fn(() => Effect.succeed(pending ? Date.now() : undefined))
  const runner = new CommunicationRunner<unknown>({
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
  owners.add(runner)
  const get = vi.fn((id: string) => jobs.get(id))
  const push = vi.fn(async (options: LifecycleJobPushOptions) => {
    const job: LifecycleJob = {
      id: options.id!,
      capability: "bot-communication",
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
      storage,
      jobs: {
        get,
        push,
        reschedule,
        rearm,
        cancel: async (id: string) => jobs.delete(id),
      },
    },
  })
  return {
    runner,
    get,
    jobs,
    records,
    storage,
    step,
    restore,
    nextWake,
    committed,
    push,
    reschedule,
    rearm,
    pump: () => jobs.get("bot-communication:pump")!,
    discovery: () => jobs.get("bot-communication:recovery")!,
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
    onAttempt({ taskId: "root", owner: "owner", revision: 1, phase: "observe" })
    throw new Error("native observation failed")
  })
  await expect(f.runner.onJob({ job, attempt: 3 })).rejects.toThrow(
    "native observation failed"
  )
  return job
}

describe("communication discovery lease", () => {
  it("retains the maximum overlapping lease after an early empty scan", () => {
    const first = armCommunicationDiscovery(undefined, 2000, "first")
    const earlier = armCommunicationDiscovery(first, 1000, "second")
    expect(earlier.armedUntil).toBe(2000)
    expect(
      observeCommunicationDiscovery(earlier, { now: 500, pending: false })
    ).toEqual([{ type: "reschedule", at: 2000 }])
    expect(
      observeCommunicationDiscovery(earlier, { now: 2000, pending: true })
    ).toEqual([{ type: "wake" }])
    expect(
      observeCommunicationDiscovery(earlier, { now: 2000, pending: false })
    ).toEqual([])
  })

  it("restores exact versioned state and rejects malformed events or future formats", () => {
    const saved = armCommunicationDiscovery(undefined, 2000, "lease")
    expect(
      readCommunicationDiscovery(JSON.parse(JSON.stringify(saved)))
    ).toEqual(saved)
    expect(() =>
      readCommunicationDiscovery({ ...saved, schemaVersion: 2 })
    ).toThrow()
    expect(() => armCommunicationDiscovery(saved, -1, "invalid")).toThrow()
    expect(() =>
      observeCommunicationDiscovery(saved, { now: -1, pending: false })
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
      capability: "bot-communication",
      fn: "recover",
      retry: { maxAttempts: 3 },
      payload: { armedUntil: deadline },
    })
    expect(pump).toMatchObject({
      id: "bot-communication:pump",
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

describe("communication job ownership", () => {
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
      { taskId: "root", owner: "owner", revision: 1, phase: "observe" },
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
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    f.step.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined)
          markEntered()
        })
    )
    const original = f.runner.onJob({ job, attempt: 1 })
    await entered
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
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    f.step.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined)
          markEntered()
        })
    )
    const work = f.runner.onJob({ job: old, attempt: 1 })
    await entered
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
    f.jobs.delete("bot-communication:pump")
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
    ).rejects.toThrow("Unsupported communication job")
    expect(f.step).not.toHaveBeenCalled()
  })
})

class PrearmReason extends Context.Service<PrearmReason, string>()(
  "CommunicationPrearmReason"
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
            observeCommunicationSchedule<number | void>(
              "arm communication discovery",
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
                  _tag: "CommunicationError",
                  code: "storage",
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

describe("communication prearm observation failures", () => {
  it("starts once lazily and returns only the confirmed lease value", async () => {
    const start = vi.fn(async () => 60_000)
    const work = observeCommunicationSchedule(
      "arm communication discovery",
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
          : new CommunicationError({
              code: "storage",
              message: "invalid",
            })
      const exit = await Effect.runPromiseExit(
        observeCommunicationSchedule("arm communication discovery", () => {
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
      observeCommunicationSchedule("arm communication discovery", () =>
        Promise.reject(error)
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
      expect(exit.cause.reasons).toMatchObject([
        {
          _tag: "Fail",
          error: { _tag: "CommunicationError", code: "storage" },
        },
      ])
  })

  it.each([true, false])(
    "preserves compound causes and annotations (declared checked failure: %s)",
    async (declared) => {
      const error = declared
        ? new CommunicationError({
            code: "storage",
            message: "unavailable",
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
        observeCommunicationSchedule("arm communication discovery", () =>
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

async function unownedFailure(f: ReturnType<typeof fixture>) {
  f.step.mockImplementation(async (onAttempt) => {
    onAttempt(undefined)
    throw new Error("mailbox scan unavailable")
  })
  const job = f.pump()
  for (let attempt = 1; attempt <= 3; attempt++)
    await expect(f.runner.onJob({ job, attempt })).rejects.toThrow(
      "mailbox scan unavailable"
    )
  expect(
    await f.runner.onJobError({ job, attempt: 3 }, new Error("exhausted"))
  ).toBeUndefined()
  f.jobs.delete(job.id)
  return (await f.runner.recovery())!
}

describe("idle mailbox failure recovery", () => {
  it("retains explicit recovery prearm across an alarm before the matching clear commits", async () => {
    const f = fixture()
    await f.runner.wake()
    const failed = await unownedFailure(f)
    f.setPending(true)
    const deadline = await f.runner.armRecovery(failed.epoch)
    const discovery = f.discovery()
    expect(await f.runner.onJob({ job: discovery, attempt: 1 })).toEqual({
      rescheduleAt: deadline,
    })
    expect(f.pump()).toBeUndefined()
    expect(await f.runner.recovery()).toEqual(failed)
    await f.runner.retryRecovery(failed.epoch, deadline)
    expect(await f.runner.recovery()).toBeNull()
    await f.runner.onJob({ job: discovery, attempt: 1 })
    expect(f.pump()).toBeDefined()
  })

  it("preserves a newer admission prearm when an older dispatch later exhausts", async () => {
    const f = fixture()
    await f.runner.armDiscovery()
    const oldDiscovery = f.discovery()
    await f.runner.wake()
    const job = f.pump()
    f.step.mockImplementation(async () => {
      throw new Error("scan failed")
    })
    await expect(f.runner.onJob({ job, attempt: 1 })).rejects.toThrow(
      "scan failed"
    )
    await f.runner.armDiscovery()
    const newer = f.discovery()
    for (const attempt of [2, 3])
      await expect(f.runner.onJob({ job, attempt })).rejects.toThrow(
        "scan failed"
      )
    await f.runner.onJobError({ job, attempt: 3 }, new Error("exhausted"))
    f.jobs.delete(job.id)
    expect(f.discovery()).toBe(newer)
    const recovery = await f.runner.recovery()
    expect(recovery?.discoveryToken).toBe(
      readCommunicationDiscovery(oldDiscovery.payload).token
    )
    f.setPending(true)
    await f.runner.onJob({ job: newer, attempt: 1 })
    expect(f.pump()).toBeDefined()
    expect(f.pump().payload).not.toEqual(job.payload)
    expect(await f.runner.recovery()).toEqual(recovery)
  })

  it("keeps the same failed epoch idle across cold restore and ordinary wakes", async () => {
    const f = fixture()
    await f.runner.wake()
    const recovery = await unownedFailure(f)
    const cold = new CommunicationRunner(f.runner.host)
    owners.add(cold)
    Object.defineProperty(cold, "lifecycle", {
      value: {
        storage: f.storage,
        jobs: {
          get: (id: string) => f.jobs.get(id),
          rearm: f.rearm,
          push: f.push,
          reschedule: f.reschedule,
        },
      },
    })
    f.setPending(true)
    await cold.reconcile()
    await cold.reconcileQueue()
    await cold.wake()
    expect(await cold.recovery()).toEqual(recovery)
    expect(f.jobs.size).toBe(0)
    expect(f.restore).toHaveBeenCalledTimes(1)
  })

  it("rejects expired or stale retry receipts without clearing a newer failure", async () => {
    const f = fixture()
    await f.runner.wake()
    const original = await unownedFailure(f)
    const deadline = await f.runner.armRecovery(original.epoch)
    const later = { ...original, epoch: "newer-epoch" }
    f.records.set("bot-communication:failure", later)
    await expect(
      f.runner.retryRecovery(original.epoch, deadline)
    ).rejects.toMatchObject({ code: "conflict" })
    expect(await f.runner.recovery()).toEqual(later)
    f.setPending(true)
    await f.runner.onJob({ job: f.discovery(), attempt: 1 })
    expect(f.pump()).toBeUndefined()
    vi.spyOn(Date, "now").mockReturnValue(deadline)
    await expect(
      f.runner.retryRecovery(later.epoch, deadline)
    ).rejects.toMatchObject({ code: "storage" })
    expect(await f.runner.recovery()).toEqual(later)
    f.records.set("bot-communication:failure", { ...later, workflowVersion: 2 })
    await expect(f.runner.recovery()).rejects.toThrow()
  })

  it("fences stale failed jobs and replays an exact warm failure after a failed storage write", async () => {
    const f = fixture()
    await f.runner.wake()
    const job = f.pump()
    f.step.mockImplementation(async () => {
      throw new Error("scan failed")
    })
    await expect(f.runner.onJob({ job, attempt: 3 })).rejects.toThrow(
      "scan failed"
    )
    const put = vi
      .spyOn(f.storage, "put")
      .mockRejectedValueOnce(new Error("storage failed"))
    await expect(
      f.runner.onJobError({ job, attempt: 3 }, new Error("exhausted"))
    ).rejects.toThrow("storage failed")
    f.jobs.delete(job.id)
    f.setPending(true)
    await f.runner.reconcileQueue()
    const recovery = await f.runner.recovery()
    expect(recovery?.epoch).toBe((job.payload as { token: string }).token)
    expect(f.jobs.size).toBe(0)
    expect(put).toHaveBeenCalledTimes(2)
    await f.runner.armDiscovery()
    await f.runner.wake()
    const newJob = f.pump()
    await f.runner.onJobError({ job, attempt: 3 }, new Error("late callback"))
    expect(f.pump()).toBe(newJob)
    expect(await f.runner.recovery()).toEqual(recovery)
  })
})

it("records bounded discovery scan exhaustion without abandoning pending work invisibly", async () => {
  const f = fixture()
  await f.runner.armDiscovery()
  const discovery = f.discovery()
  f.nextWake.mockImplementation(() => Effect.die("scan unavailable"))
  for (let attempt = 1; attempt <= 3; attempt++)
    await expect(
      f.runner.onJob({ job: discovery, attempt })
    ).rejects.toBeDefined()
  expect(
    await f.runner.onJobError(
      { job: discovery, attempt: 3 },
      new Error("exhausted")
    )
  ).toBeUndefined()
  expect(await f.runner.recovery()).toMatchObject({
    epoch: readCommunicationDiscovery(discovery.payload).token,
    discoveryToken: readCommunicationDiscovery(discovery.payload).token,
  })
  expect(f.jobs.size).toBe(0)
  f.nextWake.mockImplementation(() => Effect.succeed(Date.now()))
  await f.runner.reconcileQueue()
  expect(f.jobs.size).toBe(0)
})

it("does not dispatch an exhausted epoch whose SDK row survived the failure-summary commit", async () => {
  const f = fixture()
  await f.runner.wake()
  const job = f.pump()
  f.step.mockImplementation(async () => {
    throw new Error("scan failed")
  })
  for (let attempt = 1; attempt <= 3; attempt++)
    await expect(f.runner.onJob({ job, attempt })).rejects.toThrow(
      "scan failed"
    )
  await f.runner.onJobError({ job, attempt: 3 }, new Error("exhausted"))
  // Crash window: the summary commit is acknowledged, but SDK applyOutcome
  // has not deleted the original pump row yet.
  const recovery = await f.runner.recovery()
  await f.runner.wake()
  expect(f.reschedule).not.toHaveBeenCalled()
  const cold = new CommunicationRunner(f.runner.host)
  owners.add(cold)
  Object.defineProperty(cold, "lifecycle", {
    value: {
      storage: f.storage,
      jobs: {
        get: (id: string) => f.jobs.get(id),
        rearm: f.rearm,
        push: f.push,
        reschedule: f.reschedule,
      },
    },
  })
  await cold.reconcile()
  expect(await cold.onJob({ job, attempt: 1 })).toBeUndefined()
  expect(f.step).toHaveBeenCalledTimes(3)
  expect(await cold.recovery()).toEqual(recovery)
  // A fresh admission gets a distinct epoch, even before SDK removes the old row.
  await cold.armDiscovery()
  await cold.wake()
  const newer = f.pump()
  expect(newer.payload).not.toEqual(job.payload)
  expect(await cold.onJob({ job, attempt: 1 })).toEqual({
    rescheduleAt: newer.time,
  })
  expect(f.step).toHaveBeenCalledTimes(3)
  f.step.mockResolvedValue(undefined)
  await cold.onJob({ job: newer, attempt: 1 })
  expect(f.step).toHaveBeenCalledTimes(4)
  expect(await cold.recovery()).toEqual(recovery)
})

it("gives explicit recovery a new epoch when the exhausted SDK row survived, fencing stale retries", async () => {
  const f = fixture()
  await f.runner.wake()
  const firstJob = f.pump()
  f.step.mockImplementation(async () => {
    throw new Error("scan failed")
  })
  for (let attempt = 1; attempt <= 3; attempt++)
    await expect(f.runner.onJob({ job: firstJob, attempt })).rejects.toThrow(
      "scan failed"
    )
  await f.runner.onJobError(
    { job: firstJob, attempt: 3 },
    new Error("exhausted")
  )
  const first = (await f.runner.recovery())!
  const deadline = await f.runner.armRecovery(first.epoch)
  await f.runner.retryRecovery(first.epoch, deadline)
  // A concurrent new admission may replace the recovery prearm; retirement
  // must outlive that replaceable lease and the lease's eventual expiry.
  await f.runner.armDiscovery()
  f.jobs.delete("bot-communication:recovery")
  // Lost postcommit wake cannot dispatch the retired old token.
  expect(await f.runner.onJob({ job: firstJob, attempt: 1 })).toBeUndefined()
  expect(f.step).toHaveBeenCalledTimes(3)
  await f.runner.wake()
  const secondJob = f.pump()
  expect(secondJob.payload).not.toEqual(firstJob.payload)
  for (let attempt = 1; attempt <= 3; attempt++)
    await expect(f.runner.onJob({ job: secondJob, attempt })).rejects.toThrow(
      "scan failed"
    )
  await f.runner.onJobError(
    { job: secondJob, attempt: 3 },
    new Error("exhausted again")
  )
  const second = (await f.runner.recovery())!
  expect(second.epoch).not.toBe(first.epoch)
  await expect(f.runner.armRecovery(first.epoch)).rejects.toMatchObject({
    code: "conflict",
  })
  expect(await f.runner.recovery()).toEqual(second)
})

it("lets fresh admission replace an unsuccessful explicit recovery prearm without clearing its failure", async () => {
  const f = fixture()
  await f.runner.wake()
  const first = await unownedFailure(f)
  await f.runner.armRecovery(first.epoch)
  await f.runner.wake()
  expect(f.pump()).toBeUndefined()
  await f.runner.armDiscovery()
  expect(
    readCommunicationDiscovery(f.discovery().payload).recoveryEpoch
  ).toBeNull()
  await f.runner.wake()
  expect(f.pump()).toBeDefined()
  expect(await f.runner.recovery()).toEqual(first)
})

it("preserves retired pump authority when a recovery discovery itself exhausts before the new pump exists", async () => {
  const f = fixture()
  await f.runner.wake()
  const pump = f.pump()
  f.step.mockImplementation(async () => {
    throw new Error("scan failed")
  })
  for (let attempt = 1; attempt <= 3; attempt++)
    await expect(f.runner.onJob({ job: pump, attempt })).rejects.toThrow(
      "scan failed"
    )
  await f.runner.onJobError(
    { job: pump, attempt: 3 },
    new Error("pump exhausted")
  )
  const first = (await f.runner.recovery())!
  await f.runner.retryRecovery(
    first.epoch,
    await f.runner.armRecovery(first.epoch)
  )
  const discovery = f.discovery()
  f.nextWake.mockImplementation(() => Effect.die("discovery scan failed"))
  for (let attempt = 1; attempt <= 3; attempt++)
    await expect(
      f.runner.onJob({ job: discovery, attempt })
    ).rejects.toBeDefined()
  await f.runner.onJobError(
    { job: discovery, attempt: 3 },
    new Error("discovery exhausted")
  )
  const second = (await f.runner.recovery())!
  expect(second.epoch).not.toBe(first.epoch)
  await f.runner.retryRecovery(
    second.epoch,
    await f.runner.armRecovery(second.epoch)
  )
  expect(await f.runner.onJob({ job: pump, attempt: 1 })).toBeUndefined()
  expect(f.step).toHaveBeenCalledTimes(3)
  await f.runner.wake()
  expect(f.pump().payload).not.toEqual(pump.payload)
})

describe("communication callback admission regressions", () => {
  it("refuses an overlapping invocation of the exact same SDK callback", async () => {
    const f = fixture()
    await f.runner.wake()
    let release!: () => void, entered!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.step.mockImplementationOnce(async () => {
      entered()
      await held
      return undefined
    })
    const job = f.pump()
    const first = f.runner.onJob({ job, attempt: 1 })
    await started
    try {
      expect(await f.runner.onJob({ job, attempt: 1 })).toEqual({
        rescheduleAt: expect.any(Number),
      })
      expect(f.step).toHaveBeenCalledTimes(1)
    } finally {
      release()
      await first
    }
  })

  it("refuses premature exhaustion while the exact callback is still running", async () => {
    const f = fixture()
    await f.runner.wake()
    let release!: () => void, entered!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.step.mockImplementationOnce(async (onAttempt) => {
      onAttempt({
        taskId: "root",
        owner: "owner",
        revision: 1,
        phase: "observe",
      })
      entered()
      await held
      return undefined
    })
    const job = f.pump()
    const first = f.runner.onJob({ job, attempt: 1 })
    await started
    try {
      await f.runner.onJobError({ job, attempt: 3 }, "premature failure")
      expect(f.committed).toEqual([])
    } finally {
      release()
      await first
    }
  })
})

function barrier<A>() {
  let resolve!: (value: A) => void, reject!: (reason: unknown) => void
  const promise = new Promise<A>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

for (const mode of ["step", "restore", "storage"] as const)
  it.each([false, true])(
    `joins held ${mode} and preserves annotated native Causes (defect %s)`,
    async (defect) => {
      const f = fixture(),
        started = barrier<void>(),
        held = barrier<void>()
      const annotation = Context.make(PrearmReason, "original")
      const failure = Cause.fromReasons([
        Cause.makeFailReason(new Error("checked native failure")).annotate(
          annotation
        ),
        ...(defect
          ? [
              Cause.makeDieReason(new Error("native cleanup defect")).annotate(
                annotation
              ),
            ]
          : []),
        Cause.makeInterruptReason(715).annotate(annotation),
      ])
      const work = async () => {
        started.resolve()
        await held.promise
      }
      let accepted: Promise<unknown>
      if (mode === "step") {
        await f.runner.wake()
        f.step.mockImplementationOnce(async () => {
          await work()
          return undefined
        })
        accepted = f.runner.onJob({ job: f.pump(), attempt: 1 })
      } else {
        const effect = Effect.gen(function* () {
          started.resolve()
          yield* Effect.promise(() =>
            held.promise.then(
              () => undefined,
              () => undefined
            )
          )
          return yield* Effect.failCause(failure)
        })
        if (mode === "restore") f.restore.mockReturnValueOnce(effect)
        else f.runner.host.nextWake = () => effect.pipe(Effect.as(undefined))
        accepted = f.runner.reconcile()
      }
      const observed = accepted.catch((error: unknown) => error)
      await started.promise
      let disposed = false
      const disposal = f.runner
        .dispose()
        .catch((error: unknown) => error)
        .finally(() => {
          disposed = true
        })
      await expect(f.runner.armDiscovery()).rejects.toThrow("stopped")
      expect(disposed).toBe(false)
      const reads = f.get.mock.calls.length
      await f.runner.wake()
      await f.runner.reconcile()
      await f.runner.onJob({ job: {} as LifecycleJob, attempt: 1 })
      await f.runner.onJobError({ job: {} as LifecycleJob, attempt: 3 }, "late")
      expect(f.get).toHaveBeenCalledTimes(reads)
      held.reject(failure)
      for (const result of await Promise.all([observed, disposal])) {
        expect(Cause.isCause(result)).toBe(true)
        if (!Cause.isCause(result)) throw new Error("Expected a native Cause")
        for (const reason of failure.reasons) {
          const observed = result.reasons.find(
            (candidate) => candidate._tag === reason._tag
          )
          expect(observed?._tag).toBe(reason._tag)
          for (const [key, value] of reason.annotations)
            expect(observed?.annotations.get(key)).toBe(value)
          if (reason._tag === "Fail" && observed?._tag === "Fail")
            expect(observed.error).toBe(reason.error)
          if (reason._tag === "Die" && observed?._tag === "Die")
            expect(observed.defect).toBe(reason.defect)
          if (reason._tag === "Interrupt" && observed?._tag === "Interrupt")
            expect(observed.fiberId).toBe(reason.fiberId)
        }
      }
    }
  )

it("coalesces failed restoration and retries only for a fresh caller", async () => {
  const f = fixture(),
    started = barrier<void>(),
    held = barrier<void>()
  const failure = Cause.fail(new Error("restore unavailable"))
  f.restore.mockReturnValueOnce(
    Effect.gen(function* () {
      started.resolve()
      yield* Effect.promise(() =>
        held.promise.then(
          () => undefined,
          () => undefined
        )
      )
      return yield* Effect.failCause(failure)
    })
  )
  const first = f.runner.reconcile().catch((error: unknown) => error)
  await started.promise
  const second = f.runner.reconcile().catch((error: unknown) => error)
  held.reject(failure)
  for (const result of await Promise.all([first, second])) {
    expect(Cause.isCause(result)).toBe(true)
    if (!Cause.isCause(result)) throw new Error("Expected restoration failure")
    expect(result.reasons).toHaveLength(1)
    const observed = result.reasons[0],
      original = failure.reasons[0]
    expect(observed?._tag).toBe("Fail")
    if (observed?._tag === "Fail" && original?._tag === "Fail")
      expect(observed.error).toBe(original.error)
  }
  expect(f.restore).toHaveBeenCalledTimes(1)
  await f.runner.reconcile()
  await f.runner.reconcile()
  expect(f.restore).toHaveBeenCalledTimes(2)
})

it("starts restoration in the native caller's context", async () => {
  const f = fixture(),
    context = new AsyncLocalStorage<string>()
  let observed: string | undefined
  f.restore.mockImplementation(() =>
    Effect.sync(() => {
      observed = context.getStore()
    })
  )
  await context.run("startup", () => f.runner.reconcile())
  expect(observed).toBe("startup")
})

it("joins a held queue write, refuses its late lease and releases queued wake callers on close", async () => {
  const f = fixture(),
    entered = barrier<void>(),
    held = barrier<void>()
  const push = f.push.getMockImplementation()!
  f.push.mockImplementationOnce(async (options) => {
    entered.resolve()
    await held.promise
    return push(options)
  })
  const armed = f.runner.armDiscovery().catch((error: unknown) => error)
  await entered.promise
  const wake = f.runner.wake()
  let disposed = false
  const disposal = f.runner.dispose().finally(() => {
    disposed = true
  })
  await wake
  expect(disposed).toBe(false)
  expect(f.push).toHaveBeenCalledTimes(1)
  held.resolve()
  expect(await armed).toBeInstanceOf(Error)
  await disposal
  expect(f.step).not.toHaveBeenCalled()
})

it("defers callback admission while an accepted wake is updating the SDK job", async () => {
  const f = fixture(),
    entered = barrier<void>(),
    held = barrier<void>()
  await f.runner.wake()
  const job = f.pump(),
    reschedule = f.reschedule.getMockImplementation()!
  f.reschedule.mockImplementationOnce(async (...args) => {
    entered.resolve()
    await held.promise
    return reschedule(...args)
  })
  const wake = f.runner.wake()
  await entered.promise
  try {
    expect(await f.runner.onJob({ job, attempt: 1 })).toEqual({
      rescheduleAt: expect.any(Number),
    })
    expect(f.step).not.toHaveBeenCalled()
  } finally {
    held.resolve()
    await wake
  }
})

it("does not let a copied SDK callback exhaust the original failed receipt", async () => {
  const f = fixture()
  await f.runner.wake()
  const job = await failedPass(f)
  await f.runner.onJobError({ job: { ...job }, attempt: 3 }, "copied")
  expect(f.committed).toEqual([])
  await f.runner.onJobError({ job, attempt: 3 }, "original")
  expect(f.committed).toHaveLength(1)
})

it("rejects malformed callback admission through the official validator", () => {
  const machine = communicationRunnerMachine(() => Effect.void)
  const [initial] = initialTransition(machine)
  const [state, effects] = transition(machine, initial, {
    type: "ADMIT",
    token: "bad",
    job: null,
    reply: null,
  } as never)
  expect(state.value).toEqual(initial.value)
  expect(
    effects.some(
      (effect) =>
        effect.kind === "builtin" &&
        effect.type === "@xstate.deadLetter" &&
        effect.reason === "invalidEvent"
    )
  ).toBe(true)
})

it.each([false, true])(
  "retains failed exhaustion settlement during shutdown (defect %s)",
  async (defect) => {
    const f = fixture(),
      entered = barrier<void>(),
      held = barrier<void>()
    await f.runner.wake()
    const job = await failedPass(f)
    const checked = new Error("exhaustion storage failed"),
      died = new Error("exhaustion finalizer")
    const failure = Cause.fromReasons([
      Cause.makeFailReason(checked),
      ...(defect ? [Cause.makeDieReason(died)] : []),
      Cause.makeInterruptReason(631),
    ])
    f.runner.host.exhaust = () =>
      Effect.gen(function* () {
        entered.resolve()
        yield* Effect.promise(() => held.promise)
        return yield* Effect.failCause(failure)
      })
    const exhausted = f.runner
      .onJobError({ job, attempt: 3 }, "native failure")
      .catch((error: unknown) => error)
    await entered.promise
    let done = false
    const closing = f.runner
      .dispose()
      .catch((error: unknown) => error)
      .finally(() => {
        done = true
      })
    await expect(f.runner.armDiscovery()).rejects.toThrow("stopped")
    expect(done).toBe(false)
    held.resolve()
    for (const result of await Promise.all([exhausted, closing])) {
      expect(Cause.isCause(result)).toBe(true)
      if (!Cause.isCause(result))
        throw new Error("Expected joined exhaustion failure")
      expect(
        result.reasons.some(
          (reason) => reason._tag === "Fail" && reason.error === checked
        )
      ).toBe(true)
      expect(
        result.reasons.some(
          (reason) => reason._tag === "Die" && reason.defect === died
        )
      ).toBe(defect)
      expect(
        result.reasons.some(
          (reason) => reason._tag === "Interrupt" && reason.fiberId === 631
        )
      ).toBe(true)
    }
  }
)

it("retains an absent original discovery token across failed attempts", async () => {
  const f = fixture()
  await f.runner.wake()
  const job = f.pump()
  f.step.mockRejectedValue(new Error("unowned scan failed"))
  await expect(f.runner.onJob({ job, attempt: 1 })).rejects.toThrow()
  await f.runner.armDiscovery()
  const discovery = f.discovery()
  await expect(f.runner.onJob({ job, attempt: 3 })).rejects.toThrow()
  await f.runner.onJobError({ job, attempt: 3 }, "exhausted")
  expect((await f.runner.recovery())?.discoveryToken).toBeNull()
  expect(f.discovery()).toBe(discovery)
})

it("clears the previous receipt when the next native pass has no claim", async () => {
  const f = fixture()
  await f.runner.wake()
  const job = await failedPass(f)
  f.step.mockImplementationOnce(async (onAttempt) => {
    onAttempt(undefined)
    throw new Error("unowned scan failed")
  })
  await expect(f.runner.onJob({ job, attempt: 3 })).rejects.toThrow()
  await f.runner.onJobError({ job, attempt: 3 }, "exhausted")
  expect(f.committed).toEqual([])
  expect((await f.runner.recovery())?.epoch).toBe(
    (job.payload as { token: string }).token
  )
})

it("does not let an old publication acknowledgement clear a newer pending failure", async () => {
  const f = fixture(),
    entered = barrier<void>(),
    held = barrier<void>()
  await f.runner.wake()
  const old = f.pump()
  f.step.mockRejectedValue(new Error("scan failed"))
  await expect(f.runner.onJob({ job: old, attempt: 3 })).rejects.toThrow()
  const transaction = f.storage.transaction
  vi.spyOn(f.storage, "transaction").mockImplementationOnce(async (work) => {
    const result = await transaction(work)
    entered.resolve()
    await held.promise
    return result
  })
  const first = f.runner.onJobError({ job: old, attempt: 3 }, "first failure")
  await entered.promise
  try {
    const newer = {
      ...old,
      payload: { schemaVersion: 1, workflowVersion: 1, token: "newer" },
    }
    f.jobs.set(old.id, newer)
    await expect(f.runner.onJob({ job: newer, attempt: 3 })).rejects.toThrow()
    vi.spyOn(f.storage, "put").mockRejectedValueOnce(
      new Error("new failure write unavailable")
    )
    await expect(
      f.runner.onJobError({ job: newer, attempt: 3 }, "new failure")
    ).rejects.toThrow("new failure write unavailable")
    held.resolve()
    await first
    expect((await f.runner.recovery())?.epoch).toBe("newer")
  } finally {
    held.resolve()
    await first
  }
})

it("does not republish a retired failure when its delayed transaction resumes after explicit recovery", async () => {
  const f = fixture(),
    entered = barrier<void>(),
    held = barrier<void>()
  await f.runner.wake()
  const job = f.pump(),
    epoch = (job.payload as { token: string }).token
  f.step.mockRejectedValue(new Error("scan failed"))
  await expect(f.runner.onJob({ job, attempt: 3 })).rejects.toThrow()
  const transaction = f.storage.transaction
  vi.spyOn(f.storage, "transaction").mockImplementationOnce(async (work) => {
    entered.resolve()
    await held.promise
    return transaction(work)
  })
  const first = f.runner.onJobError({ job, attempt: 3 }, "exhausted")
  await entered.promise
  try {
    expect((await f.runner.recovery())?.epoch).toBe(epoch)
    const deadline = await f.runner.armRecovery(epoch)
    await f.runner.retryRecovery(epoch, deadline)
    held.resolve()
    await first
    expect(await f.runner.recovery()).toBeNull()
    expect(f.records.get("bot-communication:failure")).toMatchObject({
      retiredEpoch: epoch,
    })
    expect(await f.runner.onJob({ job, attempt: 1 })).toBeUndefined()
    expect(f.step).toHaveBeenCalledTimes(1)
  } finally {
    held.resolve()
    await first
  }
})

it("joins accepted failure publication and refuses recovery calls after close before storage", async () => {
  const f = fixture(),
    entered = barrier<void>(),
    held = barrier<void>()
  await f.runner.wake()
  const job = f.pump()
  f.step.mockRejectedValue(new Error("scan failed"))
  await expect(f.runner.onJob({ job, attempt: 3 })).rejects.toThrow()
  const put = f.storage.put
  vi.spyOn(f.storage, "put").mockImplementationOnce(async (...args) => {
    entered.resolve()
    await held.promise
    return put(...args)
  })
  const publication = f.runner.onJobError({ job, attempt: 3 }, "failed")
  await entered.promise
  let closed = false
  const closing = f.runner.dispose().then(() => {
    closed = true
  })
  await expect(f.runner.armDiscovery()).rejects.toThrow("stopped")
  const read = vi.spyOn(f.storage, "get")
  await expect(f.runner.recovery()).rejects.toThrow("stopped")
  await expect(f.runner.armRecovery("epoch")).rejects.toThrow("stopped")
  await expect(
    f.runner.retryRecovery("epoch", Date.now() + 1000)
  ).rejects.toThrow("stopped")
  await f.runner.reconcileQueue()
  expect(read).not.toHaveBeenCalled()
  expect(closed).toBe(false)
  held.resolve()
  await publication
  await closing
  expect(f.records.get("bot-communication:failure")).toMatchObject({
    recovery: { epoch: (job.payload as { token: string }).token },
  })
})

it("claims discovery exhaustion once and ignores copied or still-running callbacks", async () => {
  const f = fixture(),
    entered = barrier<void>(),
    held = barrier<void>()
  await f.runner.armDiscovery()
  const job = f.discovery()
  f.runner.host.nextWake = () =>
    Effect.gen(function* () {
      entered.resolve()
      yield* Effect.promise(() => held.promise)
      return yield* Effect.die("discovery scan failed")
    })
  const scanning = f.runner
    .onJob({ job, attempt: 3 })
    .catch((error: unknown) => error)
  await entered.promise
  await f.runner.onJobError({ job, attempt: 3 }, "premature")
  expect(f.records.size).toBe(0)
  held.resolve()
  await scanning
  await f.runner.onJobError({ job: { ...job }, attempt: 3 }, "copied")
  expect(f.records.size).toBe(0)
  const put = vi.spyOn(f.storage, "put")
  await Promise.all([
    f.runner.onJobError({ job, attempt: 3 }, "original"),
    f.runner.onJobError({ job, attempt: 3 }, "duplicate"),
  ])
  expect(put).toHaveBeenCalledTimes(1)
  expect((await f.runner.recovery())?.epoch).toBe(
    readCommunicationDiscovery(job.payload).token
  )
})
