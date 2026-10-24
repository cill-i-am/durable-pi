import { AsyncLocalStorage } from "node:async_hooks"

import { it as effectIt } from "@effect/vitest"
import type { LifecycleJob, LifecycleJobPushOptions } from "agents/lifecycle"
import { Cause, Context, Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, describe, expect, it, vi } from "vitest"
import { initialTransition, transition } from "xstate"

import {
  WorkspaceRunner,
  observeWorkspaceSchedule,
} from "../src/workspace/adapters/lifecycle"
import {
  armWorkspaceDiscovery,
  observeWorkspaceDiscovery,
  readWorkspaceDiscovery,
  decideWorkspacePump,
  readWorkspacePump,
} from "../src/workspace/discovery.machine"
import { WorkspaceUnavailable } from "../src/workspace/files"
import { WORKSPACE_RECOVERY_MS } from "../src/workspace/preparation.machine"
import { workspaceRunnerMachine } from "../src/workspace/runner.machine"
import type { PreparationClaim } from "../src/workspace/workspace"

vi.mock("agents/lifecycle", () => ({ LifecycleCapability: class {} }))
const owners = new Set<WorkspaceRunner<unknown>>()
afterEach(async () => {
  await Promise.allSettled([...owners].map((owner) => owner.dispose()))
  owners.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const claim: PreparationClaim = {
  id: "file",
  kind: "document",
  attemptId: "attempt-1",
  attempts: 1,
}
function barrier() {
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  return {
    enter: () => Effect.runPromise(Deferred.succeed(entered, undefined)),
    entered: () => Effect.runPromise(Deferred.await(entered)),
    wait: () => Effect.runPromise(Deferred.await(release)),
    release: () => Effect.runPromise(Deferred.succeed(release, undefined)),
  }
}
function fixture(existing = new Map<string, LifecycleJob>()) {
  const jobs = existing
  let pending: number | undefined
  let recovery: number | undefined
  const committed: Array<PreparationClaim | undefined> = []
  const step = vi.fn(
    async (
      onClaim: (
        claim: PreparationClaim
      ) => Effect.Effect<void, WorkspaceUnavailable>
    ) => {
      await Effect.runPromise(onClaim(claim))
      return undefined as number | undefined
    }
  )
  const restore = vi.fn((): Effect.Effect<void, unknown> => Effect.void)
  const nextWake = vi.fn(
    (): Effect.Effect<number | undefined, WorkspaceUnavailable> =>
      Effect.succeed(pending)
  )
  const exhaust = vi.fn(
    (
      attempt: PreparationClaim | undefined,
      current: () => boolean
    ): Effect.Effect<number | undefined, WorkspaceUnavailable> =>
      Effect.sync(() => {
        if (!current()) return undefined
        committed.push(attempt)
        return recovery
      })
  )
  const runner = new WorkspaceRunner<unknown>({
    run: Effect.runPromise,
    step,
    restore,
    nextWake,
    exhaust,
  })
  owners.add(runner)
  const get = vi.fn((id: string) => jobs.get(id))
  const push = vi.fn(async (options: LifecycleJobPushOptions) => {
    const job: LifecycleJob = {
      id: options.id!,
      capability: "workspace-extraction",
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
      jobs: { get, push, reschedule, rearm },
    },
  })
  return {
    runner,
    get,
    jobs,
    step,
    restore,
    nextWake,
    exhaust,
    committed,
    push,
    reschedule,
    rearm,
    pump: () => jobs.get("workspace-extraction:pump")!,
    discovery: () => jobs.get("workspace-extraction:recovery")!,
    pending: (time?: number) => {
      pending = time
    },
    recovery: (time?: number) => {
      recovery = time
    },
    failStep: () =>
      step.mockImplementation(async (onClaim) => {
        await Effect.runPromise(onClaim(claim))
        throw new Error("joined preparation defect")
      }),
    failPersistence: () =>
      exhaust.mockImplementation(() =>
        Effect.fail(new WorkspaceUnavailable({}))
      ),
  }
}
async function failAttempt(
  f: ReturnType<typeof fixture>,
  job = f.pump(),
  attempt = 1
) {
  await expect(f.runner.onJob({ job, attempt })).rejects.toBeDefined()
}

describe("Workspace retained discovery", () => {
  it("validates restored state/events and retains an early empty lease", () => {
    const saved = armWorkspaceDiscovery(undefined, 2000, "a")
    expect(readWorkspaceDiscovery(JSON.parse(JSON.stringify(saved)))).toEqual(
      saved
    )
    expect(armWorkspaceDiscovery(saved, 1000, "b").armedUntil).toBe(2000)
    expect(
      observeWorkspaceDiscovery(saved, { now: 999, pending: false })
    ).toEqual([{ type: "reschedule", at: 2000 }])
    expect(
      observeWorkspaceDiscovery(saved, { now: 2000, pending: true })
    ).toEqual([{ type: "wake" }])
    expect(
      observeWorkspaceDiscovery(saved, { now: 2000, pending: false })
    ).toEqual([])
    expect(() =>
      readWorkspaceDiscovery({ ...saved, workflowVersion: 2 })
    ).toThrow()
    expect(() => armWorkspaceDiscovery(saved, -1, "b")).toThrow()
    expect(() =>
      observeWorkspaceDiscovery(saved, { now: -1, pending: false })
    ).toThrow()
  })
  it("prearms a separate 60 second job without changing an existing pump", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(1000)
    const f = fixture()
    await f.runner.wake()
    const job = f.pump()
    expect(await f.runner.armDiscovery()).toBe(61000)
    expect(f.pump()).toBe(job)
    expect(f.discovery()).toMatchObject({
      capability: "workspace-extraction",
      fn: "recover",
      retry: { maxAttempts: 3 },
      payload: { armedUntil: 61000 },
    })
    expect(await f.runner.onJob({ job: f.discovery(), attempt: 1 })).toEqual({
      rescheduleAt: 61000,
    })
    f.jobs.delete("workspace-extraction:pump")
    f.pending(1000)
    await f.runner.onJob({ job: f.discovery(), attempt: 1 })
    expect(f.pump()).toBeDefined()
  })
  it("retains scan-start time when the lease ends while storage is held", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(1000)
    const f = fixture()
    const until = await f.runner.armDiscovery()
    const b = barrier()
    f.nextWake.mockImplementationOnce(() =>
      Effect.promise(async () => {
        await b.enter()
        await b.wait()
        return undefined
      })
    )
    const work = f.runner.onJob({ job: f.discovery(), attempt: 1 })
    await b.entered()
    vi.setSystemTime(until + 1)
    f.pending(until)
    await b.release()
    expect(await work).toEqual({ rescheduleAt: until })
    await f.runner.onJob({ job: f.discovery(), attempt: 1 })
    expect(f.pump()).toBeDefined()
  })
  it("a late old empty scan preserves a replacement lease", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(1000)
    const f = fixture()
    await f.runner.armDiscovery()
    const old = f.discovery()
    const b = barrier()
    f.nextWake.mockImplementationOnce(() =>
      Effect.promise(async () => {
        await b.enter()
        await b.wait()
        return undefined
      })
    )
    const work = f.runner.onJob({ job: old, attempt: 1 })
    await b.entered()
    vi.setSystemTime(100_000)
    await f.runner.armDiscovery()
    const replacement = f.discovery()
    await b.release()
    expect(await work).toEqual({ rescheduleAt: replacement.time })
    expect(f.discovery()).toBe(replacement)
  })
  it("retains only the finite lease after discovery storage exhaustion", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(1000)
    const f = fixture()
    const until = await f.runner.armDiscovery()
    const job = f.discovery()
    expect(
      await f.runner.onJobError({ job, attempt: 3 }, "read failed")
    ).toEqual({ rescheduleAt: until })
    vi.setSystemTime(until)
    expect(
      await f.runner.onJobError({ job, attempt: 3 }, "read failed")
    ).toBeUndefined()
    expect(f.step).not.toHaveBeenCalled()
  })
})

describe("Workspace pump ownership and finite cleanup", () => {
  it("preserves the original failed claim across SDK retries before scanning any other work", async () => {
    const f = fixture()
    await f.runner.wake()
    const job = f.pump()
    f.failStep()
    f.failPersistence()
    await failAttempt(f, job)
    await failAttempt(f, job, 2)
    expect(f.step).toHaveBeenCalledTimes(1)
    expect(f.exhaust).toHaveBeenCalledWith(claim, expect.any(Function))
    expect(f.nextWake).not.toHaveBeenCalled()
    f.exhaust.mockImplementation((attempt, current) =>
      Effect.sync(() => {
        if (current()) f.committed.push(attempt)
        return undefined
      })
    )
    expect(await f.runner.onJob({ job, attempt: 3 })).toBeUndefined()
    expect(f.committed).toEqual([claim])
    expect(f.step).toHaveBeenCalledTimes(1)
  })
  it("new admissions and doorbells cannot renew a failed pump SDK budget", async () => {
    const f = fixture()
    await f.runner.wake()
    const job = f.pump()
    f.failStep()
    await failAttempt(f, job)
    await f.runner.armDiscovery()
    await f.runner.wake()
    expect(f.pump()).toBe(job)
    expect(f.reschedule).not.toHaveBeenCalled()
    expect(f.push).toHaveBeenCalledTimes(2)
    await f.runner.onJob({ job, attempt: 2 })
    expect(f.step).toHaveBeenCalledTimes(1)
  })
  it("retains a durable exact cleanup receipt for one delayed three-attempt batch, then stops", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(1000)
    const f = fixture()
    await f.runner.wake()
    const job = f.pump()
    f.failStep()
    f.failPersistence()
    for (let attempt = 1; attempt <= 3; attempt++)
      await failAttempt(f, job, attempt)
    const at = 1000 + WORKSPACE_RECOVERY_MS
    expect(await f.runner.onJobError({ job, attempt: 3 }, "failed")).toEqual({
      rescheduleAt: at,
    })
    const cleanup = f.pump()
    expect(cleanup).toMatchObject({
      time: at,
      retry: { maxAttempts: 3 },
      payload: { phase: "cleanup", claim, finalBatch: true, cleanupAt: at },
    })
    expect(readWorkspacePump(cleanup.payload).token).not.toBe(
      readWorkspacePump(job.payload).token
    )
    await f.runner.wake()
    await f.runner.armDiscovery()
    expect(f.pump()).toBe(cleanup)
    expect(f.reschedule).not.toHaveBeenCalled()
    expect(await f.runner.onJob({ job: cleanup, attempt: 1 })).toEqual({
      rescheduleAt: at,
    })
    vi.setSystemTime(at)
    for (let attempt = 1; attempt <= 3; attempt++)
      await failAttempt(f, cleanup, attempt)
    const writes = f.push.mock.calls.length
    expect(
      await f.runner.onJobError({ job: cleanup, attempt: 3 }, "still failed")
    ).toBeUndefined()
    expect(f.push).toHaveBeenCalledTimes(writes)
    expect(f.step).toHaveBeenCalledTimes(1)
    expect(f.exhaust).toHaveBeenCalledTimes(5)
  })
  it("cold restore of a cleanup payload exhausts the original identity without provider work", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(1000)
    const warm = fixture()
    await warm.runner.wake()
    warm.failStep()
    warm.failPersistence()
    const job = warm.pump()
    for (let attempt = 1; attempt <= 3; attempt++)
      await failAttempt(warm, job, attempt)
    await warm.runner.onJobError({ job, attempt: 3 }, "failed")
    const cold = fixture(new Map(JSON.parse(JSON.stringify([...warm.jobs]))))
    vi.setSystemTime(cold.pump().time)
    await cold.runner.reconcile()
    await cold.runner.onJob({ job: cold.pump(), attempt: 1 })
    expect(cold.restore).toHaveBeenCalledTimes(1)
    expect(cold.committed).toEqual([claim])
    expect(cold.step).not.toHaveBeenCalled()
  })
  it("keeps a warm exact receipt even when persisting the cleanup job also fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(1000)
    const f = fixture()
    await f.runner.wake()
    f.failStep()
    f.failPersistence()
    const job = f.pump()
    await failAttempt(f, job)
    f.push.mockRejectedValueOnce(new Error("job storage unavailable"))
    const result = await f.runner.onJobError({ job, attempt: 3 }, "failed")
    expect(result).toEqual({ rescheduleAt: 1000 + WORKSPACE_RECOVERY_MS })
    vi.setSystemTime(1000 + WORKSPACE_RECOVERY_MS)
    const reloaded = { ...job, time: Date.now() }
    f.jobs.set("workspace-extraction:pump", reloaded)
    await failAttempt(f, reloaded)
    expect(f.step).toHaveBeenCalledTimes(1)
    expect(f.exhaust).toHaveBeenCalledWith(claim, expect.any(Function))
  })
  it("a hung same-token replacement cannot dispatch or exhaust a still-held owner", async () => {
    const f = fixture()
    await f.runner.wake()
    const job = f.pump()
    const b = barrier()
    f.step.mockImplementation(async (onClaim) => {
      await Effect.runPromise(onClaim(claim))
      await b.enter()
      await b.wait()
      return undefined
    })
    const work = f.runner.onJob({ job, attempt: 1 })
    await b.entered()
    const replacement = { ...job }
    f.jobs.set("workspace-extraction:pump", replacement)
    expect(
      await f.runner.onJob({ job: replacement, attempt: 1 })
    ).toHaveProperty("rescheduleAt")
    expect(
      await f.runner.onJobError({ job: replacement, attempt: 3 }, "hung")
    ).toHaveProperty("rescheduleAt")
    expect(f.exhaust).not.toHaveBeenCalled()
    expect(f.step).toHaveBeenCalledTimes(1)
    await f.runner.wake()
    expect(f.reschedule).not.toHaveBeenCalled()
    await b.release()
    await work
  })
  it("different-token replacement also waits for the native owner to join", async () => {
    const f = fixture()
    await f.runner.wake()
    const job = f.pump()
    const b = barrier()
    f.step.mockImplementation(async (onClaim) => {
      await Effect.runPromise(onClaim(claim))
      await b.enter()
      await b.wait()
      return undefined
    })
    const work = f.runner.onJob({ job, attempt: 1 })
    await b.entered()
    const replacement = {
      ...job,
      payload: { ...readWorkspacePump(job.payload), token: "new-owner" },
    }
    f.jobs.set("workspace-extraction:pump", replacement)
    expect(
      await f.runner.onJob({ job: replacement, attempt: 1 })
    ).toHaveProperty("rescheduleAt")
    expect(f.step).toHaveBeenCalledTimes(1)
    await b.release()
    await work
    await f.runner.onJob({ job: replacement, attempt: 1 })
    expect(f.step).toHaveBeenCalledTimes(2)
  })
  it("an early cleanup alarm releases callback occupancy for its later durable pass", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(1000)
    const f = fixture()
    await f.runner.wake()
    const original = f.pump()
    f.failStep()
    f.failPersistence()
    await failAttempt(f, original)
    await f.runner.onJobError({ job: original, attempt: 3 }, "failed")
    const cleanup = f.pump()
    await f.runner.onJob({ job: cleanup, attempt: 1 })
    vi.setSystemTime(cleanup.time)
    const reloaded = { ...cleanup }
    f.jobs.set("workspace-extraction:pump", reloaded)
    await failAttempt(f, reloaded)
    expect(f.exhaust).toHaveBeenCalledWith(claim, expect.any(Function))
    expect(f.step).toHaveBeenCalledTimes(1)
  })
  it("holds the failed SDK owner while its cleanup-payload write is unresolved", async () => {
    const f = fixture()
    await f.runner.wake()
    const job = f.pump()
    f.failStep()
    await failAttempt(f, job)
    const b = barrier()
    const push = f.push.getMockImplementation()!
    f.push.mockImplementationOnce(async (options) => {
      await b.enter()
      await b.wait()
      return push(options)
    })
    const failed = f.runner.onJobError({ job, attempt: 3 }, "failed")
    await b.entered()
    const replacement = { ...job }
    f.jobs.set("workspace-extraction:pump", replacement)
    expect(
      await f.runner.onJob({ job: replacement, attempt: 1 })
    ).toHaveProperty("rescheduleAt")
    expect(f.step).toHaveBeenCalledTimes(1)
    expect(f.exhaust).not.toHaveBeenCalled()
    await b.release()
    await failed
  })
  it("a superseded failed owner transfers its original cleanup claim instead of scanning", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(1000)
    const f = fixture()
    await f.runner.wake()
    const job = f.pump()
    f.failStep()
    await failAttempt(f, job)
    const replacement = {
      ...job,
      payload: { ...readWorkspacePump(job.payload), token: "replacement" },
    }
    f.jobs.set("workspace-extraction:pump", replacement)
    await f.runner.onJobError({ job, attempt: 3 }, "superseded")
    expect(await f.runner.onJob({ job: replacement, attempt: 1 })).toEqual({
      rescheduleAt: 1000 + WORKSPACE_RECOVERY_MS,
    })
    vi.setSystemTime(1000 + WORKSPACE_RECOVERY_MS)
    await f.runner.onJob({ job: { ...replacement }, attempt: 1 })
    expect(f.committed).toEqual([claim])
    expect(f.step).toHaveBeenCalledTimes(1)
  })
  it("restoration failure before dispatch retains bounded recovery without inventing a claim", async () => {
    const f = fixture()
    await f.runner.wake()
    const job = f.pump()
    f.restore.mockImplementation(() =>
      Effect.fail(new WorkspaceUnavailable({}))
    )
    for (let attempt = 1; attempt <= 3; attempt++)
      await failAttempt(f, job, attempt)
    await f.runner.onJobError({ job, attempt: 3 }, "restore failed")
    expect(f.pump().payload).toMatchObject({
      phase: "cleanup",
      claim: null,
      finalBatch: true,
    })
    expect(f.step).not.toHaveBeenCalled()
    expect(f.exhaust).not.toHaveBeenCalled()
  })
  it("a failure before claiming waits for pending recovery expiry instead of provider retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(1000)
    const f = fixture()
    await f.runner.wake()
    const job = f.pump()
    f.step.mockRejectedValueOnce(new Error("read failed"))
    f.recovery(9000)
    await failAttempt(f, job)
    expect(await f.runner.onJob({ job, attempt: 2 })).toEqual({
      rescheduleAt: 9000,
    })
    expect(f.pump().payload).toMatchObject({
      phase: "cleanup",
      claim: null,
      finalBatch: true,
    })
    expect(f.nextWake).not.toHaveBeenCalled()
    expect(f.step).toHaveBeenCalledTimes(1)
  })
  it("retains the exact claim if the next scan fails after terminal persistence", async () => {
    const f = fixture()
    await f.runner.wake()
    const job = f.pump()
    f.failStep()
    await failAttempt(f, job)
    f.nextWake.mockImplementationOnce(() =>
      Effect.fail(new WorkspaceUnavailable({}))
    )
    await failAttempt(f, job, 2)
    await f.runner.onJob({ job, attempt: 3 })
    expect(f.committed).toEqual([claim, claim])
    expect(f.step).toHaveBeenCalledTimes(1)
  })
  it("fences stale exhaustion inside the eventual transaction", async () => {
    const f = fixture()
    await f.runner.wake()
    const job = f.pump()
    f.failStep()
    await failAttempt(f, job)
    const b = barrier()
    f.exhaust.mockImplementation((attempt, current) =>
      Effect.promise(async () => {
        await b.enter()
        await b.wait()
        if (current()) f.committed.push(attempt)
        return undefined
      })
    )
    const work = f.runner.onJob({ job, attempt: 2 })
    await b.entered()
    const replacement = {
      ...job,
      time: Date.now() + 2000,
      payload: { ...readWorkspacePump(job.payload), token: "replacement" },
    }
    f.jobs.set("workspace-extraction:pump", replacement)
    await b.release()
    expect(await work).toEqual({ rescheduleAt: replacement.time })
    expect(f.committed).toEqual([])
  })
  it("a stale callback after restore cannot call the provider", async () => {
    const f = fixture()
    await f.runner.wake()
    const job = f.pump()
    const b = barrier()
    f.restore.mockImplementation(() =>
      Effect.promise(async () => {
        await b.enter()
        await b.wait()
      })
    )
    const work = f.runner.onJob({ job, attempt: 1 })
    await b.entered()
    const replacement = {
      ...job,
      payload: { ...readWorkspacePump(job.payload), token: "replacement" },
    }
    f.jobs.set("workspace-extraction:pump", replacement)
    await b.release()
    expect(await work).toEqual({ rescheduleAt: replacement.time })
    expect(f.step).not.toHaveBeenCalled()
  })
  it("restores exactly once and re-arms existing jobs without replacing them", async () => {
    const f = fixture()
    f.pending(Date.now())
    await Promise.all([f.runner.reconcile(), f.runner.reconcile()])
    const job = f.pump()
    await f.runner.reconcile()
    expect(f.restore).toHaveBeenCalledTimes(1)
    expect(f.push).toHaveBeenCalledTimes(1)
    expect(f.pump()).toBe(job)
  })
  it("recovers the literal historical workspace-extraction:pump queue row without creating another identity", async () => {
    // Historical TurnRunner.wake used this full SQL id. Seed independently of
    // the new runner and fixture helpers so an accidental rename is visible.
    const historical: LifecycleJob = {
      id: "workspace-extraction:pump",
      capability: "workspace-extraction",
      fn: "pump",
      time: 1234,
      createdAt: 1000,
      payload: null,
      retry: undefined,
      singleflight: true,
      exclusive: false,
      recoveryLoop: true,
    }
    const f = fixture(new Map([[historical.id, historical]]))
    await f.runner.reconcile()
    expect(f.push).not.toHaveBeenCalled()
    expect(f.jobs.get("workspace-extraction:pump")).toBe(historical)
    await f.runner.wake()
    expect(f.reschedule).toHaveBeenCalledWith(
      "workspace-extraction:pump",
      expect.any(Number)
    )
    expect([...f.jobs.keys()]).toEqual(["workspace-extraction:pump"])
    const reloaded = f.jobs.get("workspace-extraction:pump")!
    await f.runner.onJob({ job: reloaded, attempt: 1 })
    expect(f.step).toHaveBeenCalledTimes(1)
    expect(f.restore).toHaveBeenCalledTimes(1)
    expect(reloaded).toMatchObject({
      capability: "workspace-extraction",
      fn: "pump",
      payload: null,
    })
  })
  it.each(["pump", "recover"])(
    "rejects future %s data before any restoration or work",
    async (fn) => {
      const f = fixture()
      await f.runner.wake()
      await f.runner.armDiscovery()
      const source = fn === "pump" ? f.pump() : f.discovery()
      const job = {
        ...source,
        payload: { ...(source.payload as object), schemaVersion: 2 },
      }
      f.jobs.set(job.id, job)
      await expect(f.runner.onJob({ job, attempt: 1 })).rejects.toThrow()
      await expect(f.runner.reconcile()).rejects.toThrow()
      expect(f.restore).not.toHaveBeenCalled()
      expect(f.step).not.toHaveBeenCalled()
    }
  )
  it("machine rejects invalid claim events and unknown phases", async () => {
    const f = fixture()
    await f.runner.wake()
    const state = readWorkspacePump(f.pump().payload)
    expect(() =>
      decideWorkspacePump(state, {
        type: "CLAIMED",
        claim: { ...claim, attempts: 9 },
      })
    ).toThrow()
    expect(() => readWorkspacePump({ ...state, phase: "future" })).toThrow()
    expect(() =>
      decideWorkspacePump(state, { type: "FAILED", now: -1 })
    ).toThrow()
  })
})

class Reason extends Context.Service<Reason, string>()(
  "WorkspaceScheduleReason"
) {}
it("schedule observation preserves mixed Cause reasons and annotations", async () => {
  const reason = new WorkspaceUnavailable({})
  const cause = Cause.fromReasons([
    Cause.makeFailReason(reason).annotate(Context.make(Reason, "fail")),
    Cause.makeDieReason("defect").annotate(Context.make(Reason, "die")),
    Cause.makeInterruptReason(12).annotate(Context.make(Reason, "interrupt")),
  ])
  const result = await Effect.runPromise(
    Effect.exit(observeWorkspaceSchedule("arm", () => Promise.reject(cause)))
  )
  expect(Exit.isFailure(result)).toBe(true)
  if (Exit.isFailure(result)) expect(result.cause).toEqual(cause)
})
effectIt.effect(
  "schedule observation has a five-second deadline even in an uninterruptible admission",
  () =>
    Effect.gen(function* () {
      let resolve!: (value: number) => void
      const started = Deferred.makeUnsafe<void>()
      const work = yield* Effect.uninterruptible(
        observeWorkspaceSchedule("arm", () => {
          Deferred.doneUnsafe(started, Exit.succeed(undefined))
          return new Promise<number>((accept) => {
            resolve = accept
          })
        })
      ).pipe(Effect.exit, Effect.forkChild)
      yield* Deferred.await(started)
      yield* TestClock.adjust(4999)
      expect(work.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      yield* Effect.yieldNow
      const atDeadline = work.pollUnsafe()
      resolve(60000)
      const exit = yield* Fiber.join(work)
      expect(atDeadline).toBeDefined()
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasFails(exit.cause)).toBe(true)
    })
)

it("defers dispatch while an accepted wake is still updating the native job", async () => {
  const f = fixture(),
    b = barrier()
  await f.runner.wake()
  const job = f.pump(),
    reschedule = f.reschedule.getMockImplementation()!
  f.reschedule.mockImplementationOnce(async (...args) => {
    await b.enter()
    await b.wait()
    return reschedule(...args)
  })
  const wake = f.runner.wake()
  await b.entered()
  try {
    expect(await f.runner.onJob({ job, attempt: 1 })).toHaveProperty(
      "rescheduleAt"
    )
    expect(f.step).not.toHaveBeenCalled()
  } finally {
    await b.release()
    await wake
  }
})

it("defers a duplicate exact discovery callback while its storage scan is held", async () => {
  const f = fixture(),
    b = barrier()
  await f.runner.armDiscovery()
  const job = f.discovery()
  f.nextWake.mockImplementationOnce(() =>
    Effect.promise(async () => {
      await b.enter()
      await b.wait()
      return undefined
    })
  )
  const scanning = f.runner.onJob({ job, attempt: 1 })
  await b.entered()
  try {
    expect(await f.runner.onJob({ job, attempt: 1 })).toHaveProperty(
      "rescheduleAt"
    )
    expect(f.nextWake).toHaveBeenCalledTimes(1)
  } finally {
    await b.release()
    await scanning
  }
})

function completion<A>() {
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
        started = completion<void>(),
        held = completion<void>()
      const annotation = Context.make(Reason, "original")
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
    started = completion<void>(),
    held = completion<void>()
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
    entered = completion<void>(),
    held = completion<void>()
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

it("rejects malformed callback admission through the official validator", () => {
  const machine = workspaceRunnerMachine(() => Effect.void)
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
  "joins held cleanup and preserves its complete failure (defect %s)",
  async (defect) => {
    const f = fixture(),
      b = barrier()
    await f.runner.wake()
    const job = f.pump()
    f.failStep()
    await failAttempt(f, job)
    const checked = new WorkspaceUnavailable({}),
      died = new Error("cleanup finalizer")
    const cause = Cause.fromReasons([
      Cause.makeFailReason(checked),
      ...(defect ? [Cause.makeDieReason(died)] : []),
      Cause.makeInterruptReason(838),
    ])
    f.runner.host.exhaust = () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => b.enter())
        yield* Effect.promise(() => b.wait())
        return yield* Effect.failCause(cause)
      })
    const cleanup = f.runner
      .onJob({ job, attempt: 2 })
      .catch((error: unknown) => error)
    await b.entered()
    let closed = false
    const closing = f.runner
      .dispose()
      .catch((error: unknown) => error)
      .finally(() => {
        closed = true
      })
    await expect(f.runner.armDiscovery()).rejects.toThrow("stopped")
    expect(closed).toBe(false)
    await b.release()
    for (const result of await Promise.all([cleanup, closing])) {
      expect(Cause.isCause(result)).toBe(true)
      if (!Cause.isCause(result))
        throw new Error("Expected complete cleanup Cause")
      expect(
        result.reasons.some((r) => r._tag === "Fail" && r.error === checked)
      ).toBe(true)
      expect(
        result.reasons.some((r) => r._tag === "Die" && r.defect === died)
      ).toBe(defect)
      expect(
        result.reasons.some((r) => r._tag === "Interrupt" && r.fiberId === 838)
      ).toBe(true)
    }
  }
)

it("joins a failed retained-receipt write during close without losing its Cause", async () => {
  const f = fixture(),
    b = barrier()
  await f.runner.wake()
  const job = f.pump()
  f.failStep()
  await failAttempt(f, job)
  const cause = Cause.fromReasons([
    Cause.makeDieReason("job storage failed"),
    Cause.makeInterruptReason(839),
  ])
  f.push.mockImplementationOnce(async () => {
    await b.enter()
    await b.wait()
    throw cause
  })
  const cleanup = f.runner
    .onJobError({ job, attempt: 3 }, "exhausted")
    .catch((error: unknown) => error)
  await b.entered()
  let closed = false
  const closing = f.runner
    .dispose()
    .catch((error: unknown) => error)
    .finally(() => {
      closed = true
    })
  await expect(f.runner.armDiscovery()).rejects.toThrow("stopped")
  expect(closed).toBe(false)
  await b.release()
  for (const result of await Promise.all([cleanup, closing])) {
    expect(Cause.isCause(result)).toBe(true)
    if (!Cause.isCause(result)) throw new Error("Expected complete write Cause")
    expect(result.reasons).toEqual(cause.reasons)
  }
})

it.each([null, { ...claim, attempts: 9 }])(
  "rejects a malformed native claim before its acknowledgement",
  async (receipt) => {
    const f = fixture()
    await f.runner.wake()
    f.step.mockImplementationOnce(async (onClaim) => {
      await Effect.runPromise(onClaim(receipt as PreparationClaim))
      return undefined
    })
    await expect(
      f.runner.onJob({ job: f.pump(), attempt: 1 })
    ).rejects.toBeDefined()
    expect(f.committed).toEqual([])
  }
)
