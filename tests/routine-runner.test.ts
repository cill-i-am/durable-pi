import type { LifecycleJob, LifecycleJobPushOptions } from "agents/lifecycle"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  RoutineRunner,
  type RoutineControlAttempt,
} from "../src/routines/adapters/lifecycle"
import {
  armRoutineDiscovery,
  observeRoutineDiscovery,
} from "../src/routines/discovery.machine"

vi.mock("agents/lifecycle", () => ({ LifecycleCapability: class {} }))
afterEach(() => vi.useRealTimers())
function fixture() {
  const jobs = new Map<string, LifecycleJob>()
  const owner = {}
  let pending = false
  const step = vi.fn(
    async (attempt: (value: RoutineControlAttempt) => void) => {
      attempt({ id: "run", controlRevision: 1 })
      return undefined as number | undefined
    }
  )
  const exhaust = vi.fn(
    (_attempt: RoutineControlAttempt, eligible: () => boolean) =>
      Effect.sync(eligible)
  )
  const push = vi.fn(async (options: LifecycleJobPushOptions) => {
    const job: LifecycleJob = {
      id: options.id!,
      fn: options.fn,
      capability: "routines",
      payload: options.payload,
      time: options.time,
      createdAt: Date.now(),
      singleflight: true,
      exclusive: false,
      recoveryLoop: true,
      retry: options.retry,
    }
    jobs.set(job.id, job)
    return job
  })
  const reschedule = vi.fn(async (id: string, time: number) => {
    const current = jobs.get(id)
    if (current) jobs.set(id, { ...current, time })
    return !!current
  })
  const rearm = vi.fn(async () => {})
  const make = () => {
    const runner = new RoutineRunner({
      owner,
      run: Effect.runPromise,
      step,
      nextWake: () => Effect.succeed(pending ? Date.now() : undefined),
      exhaust,
    })
    Object.defineProperty(runner, "lifecycle", {
      value: {
        jobs: { get: (id: string) => jobs.get(id), push, reschedule, rearm },
      },
    })
    return runner
  }
  return {
    runner: make(),
    make,
    jobs,
    step,
    exhaust,
    push,
    reschedule,
    rearm,
    pump: () => jobs.get("routines:pump")!,
    discovery: () => jobs.get("routines:discovery")!,
    setPending: () => {
      pending = true
    },
  }
}
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("routine Lifecycle recovery", () => {
  it("retains discovery after an empty scan, then finds a commit with no new request", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const f = fixture(),
      deadline = await f.runner.armDiscovery(),
      job = f.discovery()
    expect(deadline).toBe(61000)
    const empty = await f.runner.onJob({ job, attempt: 1 })
    expect(empty).toEqual({ rescheduleAt: deadline })
    f.setPending()
    vi.setSystemTime(deadline)
    await f.runner.onJob({ job, attempt: 1 })
    expect(f.pump()).toMatchObject({ retry: { maxAttempts: 3 } })
  })
  it("negative control: dropping empty discovery loses a later commit", async () => {
    const f = fixture()
    await f.runner.armDiscovery()
    f.jobs.delete("routines:discovery")
    f.setPending()
    expect(f.jobs.size).toBe(0)
    // There is no request or alarm left to call reconcile: the positive test's
    // retained alarm is what permits progress, not a subsequent GET.
    expect(f.step).not.toHaveBeenCalled()
  })
  it("warm facade and duplicate alarm cannot reclaim live observation or reset its budget", async () => {
    const f = fixture(),
      entered = deferred(),
      release = deferred()
    f.step.mockImplementation(async (attempt) => {
      attempt({ id: "run", controlRevision: 1 })
      entered.resolve()
      await release.promise
      return undefined
    })
    await f.runner.wake()
    const job = f.pump(),
      running = f.runner.onJob({ job, attempt: 1 })
    await entered.promise
    const warm = f.make()
    await warm.wake()
    await warm.onJob({ job: { ...job }, attempt: 1 })
    await warm.onJob({ job, attempt: 1 })
    expect(f.step).toHaveBeenCalledTimes(1)
    expect(f.push).toHaveBeenCalledTimes(1)
    expect(f.reschedule).not.toHaveBeenCalled()
    release.resolve()
    await running
  })
  it("exhausts only the correlated run after its third failed pass", async () => {
    const f = fixture()
    f.step.mockImplementation(async (attempt) => {
      attempt({ id: "run", controlRevision: 3 })
      throw new Error("storage unavailable")
    })
    await f.runner.wake()
    const job = f.pump()
    for (let attempt = 1; attempt <= 3; attempt++)
      await expect(f.runner.onJob({ job, attempt })).rejects.toThrow(
        "storage unavailable"
      )
    await f.runner.onJobError({ job, attempt: 3 }, "failed")
    expect(f.exhaust).toHaveBeenCalledTimes(1)
    expect(f.exhaust.mock.calls[0]?.[0]).toEqual({
      id: "run",
      controlRevision: 3,
    })
    expect(f.exhaust.mock.calls[0]?.[1]()).toBe(true)
  })
  it("stale exhaustion cannot erase a newer job or mark its run failed", async () => {
    const f = fixture()
    f.step.mockImplementation(async (attempt) => {
      attempt({ id: "run", controlRevision: 1 })
      throw new Error("failed")
    })
    await f.runner.wake()
    const old = f.pump()
    await expect(f.runner.onJob({ job: old, attempt: 3 })).rejects.toThrow()
    f.jobs.set(old.id, {
      ...old,
      payload: { schemaVersion: 1, workflowVersion: 1, token: "new" },
      time: 98765,
    })
    expect(
      await f.runner.onJobError({ job: old, attempt: 3 }, "failed")
    ).toEqual({ rescheduleAt: 98765 })
    expect(f.exhaust).not.toHaveBeenCalled()
  })
  it("restores legacy pump identity and rejects future discovery without replacing it", async () => {
    const f = fixture()
    await f.runner.wake()
    const current = f.pump()
    f.jobs.set(current.id, { ...current, payload: undefined })
    await f.runner.reconcile()
    await f.runner.armDiscovery()
    const discovery = f.discovery()
    f.jobs.set(discovery.id, {
      ...discovery,
      payload: { ...(discovery.payload as object), workflowVersion: 2 },
    })
    await expect(f.runner.armDiscovery()).rejects.toThrow()
    expect(f.discovery().payload).toMatchObject({ workflowVersion: 2 })
  })
  it("machine validates discovery versions and event time before emitting wake intent", () => {
    const saved = armRoutineDiscovery(undefined, 2000, "first")
    expect(armRoutineDiscovery(saved, 1000, "second").armedUntil).toBe(2000)
    expect(
      observeRoutineDiscovery(saved, { now: 1500, pending: false })
    ).toEqual([{ type: "reschedule", at: 2000 }])
    expect(() =>
      observeRoutineDiscovery(saved, { now: -1, pending: true })
    ).toThrow()
    expect(() =>
      armRoutineDiscovery({ ...saved, schemaVersion: 2 }, 3000, "future")
    ).toThrow()
  })
})
