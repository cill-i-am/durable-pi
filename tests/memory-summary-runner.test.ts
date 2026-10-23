import type { LifecycleJob, LifecycleJobPushOptions } from "agents/lifecycle"
import { Cause, Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SummaryRunner } from "../src/memory/adapters/summary-lifecycle"
import {
  armSummaryDiscovery,
  observeSummaryDiscovery,
  readSummaryDiscovery,
} from "../src/memory/summary-discovery.machine"
import { orDieAll } from "../src/shared/effect"
import { nativeOperation } from "../src/shared/interop"

vi.mock("agents/lifecycle", () => ({ LifecycleCapability: class {} }))
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
const pumpId = "memory-compactor:pump",
  discoveryId = "memory-compactor:discovery"
const gate = () => {
  let release!: () => void
  const wait = new Promise<void>((done) => {
    release = done
  })
  return { release, wait }
}
function fixture(shared?: {
  jobs: Map<string, LifecycleJob>
  storage: Map<string, unknown>
}) {
  const jobs = shared?.jobs ?? new Map<string, LifecycleJob>(),
    storage = shared?.storage ?? new Map<string, unknown>()
  const retained: Promise<void>[] = []
  const step = vi.fn((): Effect.Effect<number | undefined, unknown> =>
    Effect.succeed(undefined)
  )
  const settle = vi.fn((): Effect.Effect<void, unknown> => Effect.void)
  const nextWake = vi.fn((): Effect.Effect<number | undefined, unknown> =>
    Effect.succeed(undefined)
  )
  const restore = vi.fn(() => Effect.void)
  const runner = new SummaryRunner<unknown>({
    run: Effect.runPromise,
    step,
    settle,
    nextWake,
    restore,
    retain: (work) => {
      retained.push(work)
    },
  })
  const push = vi.fn(async (options: LifecycleJobPushOptions) => {
    const job: LifecycleJob = {
      id: options.id!,
      capability: "memory-compactor",
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
    const prior = jobs.get(id)
    if (!prior) return false
    jobs.set(id, { ...prior, time })
    return true
  })
  const rearm = vi.fn(async () => {})
  const get = vi.fn(async (key: string) => storage.get(key))
  const put = vi.fn(async (key: string, value: unknown) => {
    storage.set(key, structuredClone(value))
  })
  const trackAlarmWork = vi.fn()
  Object.defineProperty(runner, "lifecycle", {
    value: {
      storage: { get, put },
      jobs: { get: (id: string) => jobs.get(id), push, reschedule, rearm },
      trackAlarmWork,
    },
  })
  return {
    runner,
    jobs,
    storage,
    retained,
    step,
    settle,
    nextWake,
    restore,
    push,
    reschedule,
    rearm,
    get,
    put,
    trackAlarmWork,
    pump: () => jobs.get(pumpId)!,
    discovery: () => jobs.get(discoveryId)!,
    context: (job = jobs.get(pumpId)!, attempt = 1) => ({ job, attempt }),
  }
}
async function failPass(f: ReturnType<typeof fixture>) {
  f.step.mockImplementation(() => Effect.fail("native or storage failure"))
  f.settle.mockImplementation(() => Effect.fail("receipt write unavailable"))
  await f.runner.wake()
  await f.runner.onJob(f.context())
  await Promise.all(f.retained)
  const job = f.pump()
  for (let attempt = 1; attempt <= 3; attempt++)
    await expect(f.runner.onJob(f.context(job, attempt))).rejects.toBeDefined()
  return job
}
async function exhaust(f: ReturnType<typeof fixture>) {
  const job = await failPass(f)
  await f.runner.onJobError(f.context(job, 3), "SDK attempts exhausted")
  f.jobs.delete(job.id) // Actual SDK deletes on an undefined exhaustion outcome.
  return job
}

describe("Summary scheduler invariants", () => {
  it("retains empty admission discovery and rejects incompatible durable payloads", () => {
    const lease = armSummaryDiscovery(undefined, 2000, "first")
    const next = armSummaryDiscovery(lease, 1000, "second")
    expect(next.armedUntil).toBe(2000)
    expect(observeSummaryDiscovery(next, 500, false)).toEqual([
      { type: "schedule", at: 2000 },
    ])
    expect(observeSummaryDiscovery(next, 2000, true)).toEqual([
      { type: "wake" },
    ])
    expect(readSummaryDiscovery(JSON.parse(JSON.stringify(next)))).toEqual(next)
    expect(() =>
      readSummaryDiscovery({ ...next, workflowVersion: 2 })
    ).toThrow()
    expect(() => observeSummaryDiscovery(next, -1, false)).toThrow()
  })
  it("uses the exact historical payloadless queue identity without restoring warm claims", async () => {
    const f = fixture()
    await f.push({ id: pumpId, fn: "pump", payload: null, time: 1 })
    await f.runner.wake()
    await f.runner.reconcile()
    await f.runner.onJob(f.context())
    await Promise.all(f.retained)
    expect(await f.runner.onJob(f.context())).toBeUndefined()
    expect(f.step).toHaveBeenCalledTimes(1)
    expect(f.restore).not.toHaveBeenCalled()
    expect(f.push).toHaveBeenCalledTimes(1)
    expect(f.pump().payload).toBeNull()
    await f.runner.restore()
    await f.runner.restore()
    expect(f.restore).toHaveBeenCalledTimes(1)
  })
  it("does not consume a discovery lease on an empty scan, including storage crossing its deadline", async () => {
    const f = fixture(),
      now = 1000
    vi.spyOn(Date, "now").mockReturnValue(now)
    const deadline = await f.runner.armDiscovery(),
      job = f.discovery()
    f.nextWake.mockImplementation(() =>
      Effect.sync(() => {
        vi.mocked(Date.now).mockReturnValue(deadline + 1)
        return undefined
      })
    )
    expect(await f.runner.onJob(f.context(job))).toEqual({
      rescheduleAt: deadline,
    })
    expect(f.push).toHaveBeenCalledTimes(1)
    f.nextWake.mockImplementation(() => Effect.succeed(Date.now()))
    await f.runner.onJob(f.context(job))
    expect(f.pump().id).toBe(pumpId)
    expect(f.pump().retry?.maxAttempts).toBe(3)
  })
  it("holds one native producer outside alarm dispatch and ordinary wakes do not reset SDK retries", async () => {
    const f = fixture(),
      entered = gate(),
      release = gate()
    f.step.mockImplementation(() =>
      nativeOperation(
        async () => {
          entered.release()
          await release.wait
          return undefined
        },
        (error) => error
      )
    )
    await f.runner.wake()
    const original = f.pump()
    await f.runner.onJob(f.context())
    await entered.wait
    try {
      await f.runner.wake()
      await f.runner.onJob(f.context())
      expect(f.step).toHaveBeenCalledTimes(1)
      expect(f.push).toHaveBeenCalledTimes(1)
      expect(f.reschedule).not.toHaveBeenCalled()
      expect(f.pump().payload).toEqual(original.payload)
      expect(f.trackAlarmWork).toHaveBeenCalledTimes(1)
      expect(f.retained).toHaveLength(1)
    } finally {
      release.release()
    }
    await Promise.all(f.retained)
    expect(await f.runner.onJob(f.context())).toEqual({
      rescheduleAt: expect.any(Number),
    })
  })
  it("retries only joined receipt persistence after a failed pass, then permits unrelated ready work", async () => {
    const f = fixture()
    f.step.mockImplementation(() => Effect.fail("provider uncertain"))
    await f.runner.wake()
    await f.runner.onJob(f.context())
    await Promise.all(f.retained)
    const job = f.pump()
    await expect(f.runner.onJob(f.context(job))).rejects.toBeDefined()
    await f.runner.wake()
    f.nextWake.mockImplementation(() => Effect.succeed(5000))
    expect(await f.runner.onJob(f.context(job, 2))).toEqual({
      rescheduleAt: expect.any(Number),
    })
    expect(f.step).toHaveBeenCalledTimes(1)
    expect(f.settle).toHaveBeenCalledTimes(1)
    expect(f.push).toHaveBeenCalledTimes(1)
  })
  it("durably exhausts a failed pass and blocks ordinary wake, status, reconciliation and stale callbacks", async () => {
    const f = fixture(),
      job = await exhaust(f)
    const failure = await f.runner.recovery()
    expect(failure).toMatchObject({
      epoch: expect.any(String),
      failedAt: expect.any(Number),
    })
    await f.runner.wake()
    await f.runner.reconcile()
    await f.runner.onJob(f.context(job, 4))
    expect(f.step).toHaveBeenCalledTimes(1)
    expect(f.push).toHaveBeenCalledTimes(1)
    const cold = fixture(f)
    await cold.runner.restore()
    await cold.runner.wake()
    await cold.runner.onJob(cold.context(job, 4))
    expect(cold.step).not.toHaveBeenCalled()
    expect(await cold.runner.recovery()).toEqual(failure)
  })
  it("blocks a fourth callback while the spent same-token queue row still exists", async () => {
    const f = fixture(),
      job = await failPass(f)
    await f.runner.onJobError(f.context(job, 3), "exhausted")
    await f.runner.onJob(f.context(job, 4))
    await f.runner.wake()
    expect(f.step).toHaveBeenCalledTimes(1)
    expect(f.settle).toHaveBeenCalledTimes(2)
    expect(f.push).toHaveBeenCalledTimes(1)
  })
  it("retains warm exhaustion if the final diagnostic write fails, even when SDK retires the job", async () => {
    const f = fixture(),
      job = await failPass(f)
    f.put.mockRejectedValue(new Error("storage down"))
    await expect(
      f.runner.onJobError(f.context(job, 3), "exhausted")
    ).rejects.toThrow("storage down")
    f.jobs.delete(job.id)
    await f.runner.wake()
    await f.runner.reconcile()
    expect(await f.runner.recovery()).toBeDefined()
    expect(f.push).toHaveBeenCalledTimes(1)
    // If storage never acknowledged this marker and the process is lost, its
    // scheduler diagnostic cannot be recovered; durable Summary claims still fence native work.
  })
  it("records preclaim scan failure without mutating unrelated domain rows", async () => {
    const f = fixture()
    await f.runner.armDiscovery()
    f.nextWake.mockImplementation(() => Effect.fail("scan unavailable"))
    const job = f.discovery()
    for (let attempt = 1; attempt <= 3; attempt++)
      await expect(
        f.runner.onJob(f.context(job, attempt))
      ).rejects.toBeDefined()
    await f.runner.onJobError(f.context(job, 3), "scan unavailable")
    expect(f.step).not.toHaveBeenCalled()
    expect(f.settle).not.toHaveBeenCalled()
    expect(await f.runner.recovery()).toBeDefined()
  })
  it("requires the exact exhausted epoch and actual tagged unexpired lease for explicit recovery", async () => {
    const f = fixture(),
      old = await exhaust(f),
      failure = (await f.runner.recovery())!
    await expect(f.runner.armRecovery("wrong")).rejects.toThrow("changed")
    await expect(f.runner.armDiscovery()).rejects.toThrow(
      "Retry compaction recovery"
    )
    const ordinaryDeadline = Date.now() + 60_000
    await f.push({
      id: discoveryId,
      fn: "discover",
      time: Date.now(),
      payload: armSummaryDiscovery(undefined, ordinaryDeadline, "ordinary"),
    })
    expect(await f.runner.retryRecovery(failure.epoch, ordinaryDeadline)).toBe(
      false
    )
    const deadline = await f.runner.armRecovery(failure.epoch)
    // An early alarm while exhausted still retains the explicit recovery lease.
    expect(await f.runner.onJob(f.context(f.discovery()))).toEqual({
      rescheduleAt: deadline,
    })
    expect(await f.runner.retryRecovery(failure.epoch, deadline)).toBe(true)
    const fresh = f.pump(),
      pushes = f.push.mock.calls.length
    expect(fresh.payload).not.toEqual(old.payload)
    expect(await f.runner.recovery()).toBeUndefined()
    expect(await f.runner.retryRecovery(failure.epoch, deadline)).toBe(true)
    expect(f.push).toHaveBeenCalledTimes(pushes)
    await f.runner.onJob(f.context(old, 4))
    expect(f.step).toHaveBeenCalledTimes(1)
    expect(f.pump()).toBe(fresh)
  })
  it("rejects expired recovery and does not let an old recovery epoch clear a later failure", async () => {
    const f = fixture()
    await exhaust(f)
    const first = (await f.runner.recovery())!,
      deadline = await f.runner.armRecovery(first.epoch)
    vi.spyOn(Date, "now").mockReturnValue(deadline)
    expect(await f.runner.retryRecovery(first.epoch, deadline)).toBe(false)
    const currentDeadline = await f.runner.armRecovery(first.epoch)
    expect(await f.runner.retryRecovery(first.epoch, currentDeadline)).toBe(
      true
    )
    const secondJob = f.pump()
    await f.runner.onJobError(f.context(secondJob, 3), "new scan failure")
    const second = (await f.runner.recovery())!
    expect(second.epoch).not.toBe(first.epoch)
    expect(await f.runner.retryRecovery(first.epoch, currentDeadline)).toBe(
      false
    )
    expect(await f.runner.recovery()).toEqual(second)
  })
  it("uses the retained lease if recovery commits but its immediate pump push fails", async () => {
    const f = fixture()
    const old = await exhaust(f)
    // Model an SDK old-row outcome that has not yet deleted the spent queue row.
    f.jobs.set(old.id, old)
    const failure = (await f.runner.recovery())!,
      deadline = await f.runner.armRecovery(failure.epoch)
    f.push.mockRejectedValueOnce(new Error("doorbell lost"))
    await expect(
      f.runner.retryRecovery(failure.epoch, deadline)
    ).rejects.toThrow("doorbell lost")
    f.nextWake.mockImplementation(() => Effect.succeed(Date.now()))
    await f.runner.onJob(f.context(f.discovery()))
    expect(f.pump().payload).not.toEqual(old.payload)
  })
  it("joins cancellation cleanup and preserves every late Cause before disposal returns", async () => {
    const f = fixture(),
      entered = gate(),
      cleanup = gate()
    const failure = Cause.fromReasons([
      Cause.makeFailReason("late storage failure"),
      Cause.makeDieReason("native cleanup defect"),
    ])
    f.step.mockImplementation(() =>
      Effect.never.pipe(
        Effect.onExit(() =>
          Effect.promise(async () => {
            entered.release()
            await cleanup.wait
          }).pipe(Effect.andThen(Effect.failCause(failure)), orDieAll)
        )
      )
    )
    await f.runner.wake()
    await f.runner.onJob(f.context())
    // Let the owned Effect enter before aborting it.
    await new Promise((resolve) => setTimeout(resolve, 0))
    let done = false
    const stopped = f.runner.dispose().finally(() => {
      done = true
    })
    await entered.wait
    expect(done).toBe(false)
    await f.runner.wake()
    expect(f.step).toHaveBeenCalledTimes(1)
    cleanup.release()
    const result: unknown = await stopped.catch((error) => error)
    expect(Cause.isCause(result)).toBe(true)
    expect(String(result)).toContain("native cleanup defect")
    expect(String(result)).toContain("late storage failure")
  })
  it("rejects future controller versions rather than resetting persisted exhaustion", async () => {
    const f = fixture()
    f.storage.set("memory-compactor:failure", {
      schemaVersion: 1,
      workflowVersion: 1,
      phase: "exhausted",
      retiredToken: null,
      recovery: null,
    })
    await expect(f.runner.recovery()).rejects.toBeDefined()
    f.storage.set("memory-compactor:failure", { schemaVersion: 2 })
    await expect(f.runner.wake()).rejects.toBeDefined()
    expect(f.push).not.toHaveBeenCalled()
  })
})

it("discovery exhaustion recovery preserves the original live producer and its concurrency bound", async () => {
  const f = fixture(),
    entered = gate(),
    release = gate()
  f.step.mockImplementation(() =>
    nativeOperation(
      async () => {
        entered.release()
        await release.wait
        return undefined
      },
      (error) => error
    )
  )
  await f.runner.wake()
  await f.runner.onJob(f.context())
  await entered.wait
  try {
    const original = f.pump()
    await f.runner.armDiscovery()
    f.nextWake.mockImplementation(() =>
      Effect.fail("discovery scan unavailable")
    )
    const discovery = f.discovery()
    for (let attempt = 1; attempt <= 3; attempt++)
      await expect(
        f.runner.onJob(f.context(discovery, attempt))
      ).rejects.toBeDefined()
    await f.runner.onJobError(f.context(discovery, 3), "scan exhausted")
    expect(await f.runner.onJob(f.context(original))).toMatchObject({
      rescheduleAt: expect.any(Number),
    })
    const failure = (await f.runner.recovery())!,
      deadline = await f.runner.armRecovery(failure.epoch)
    expect(await f.runner.retryRecovery(failure.epoch, deadline)).toBe(true)
    await f.runner.onJob(f.context())
    expect(f.pump().payload).toEqual(original.payload)
    expect(f.step).toHaveBeenCalledTimes(1)
  } finally {
    release.release()
  }
  await Promise.all(f.retained)
})
it("checks the actual retained admission lease when the publication transaction acquires SQL", async () => {
  const f = fixture(),
    deadline = await f.runner.armDiscovery()
  expect(f.runner.discoveryCurrent(deadline)).toBe(true)
  f.jobs.delete(discoveryId)
  expect(f.runner.discoveryCurrent(deadline)).toBe(false)
  await f.runner.armDiscovery()
  await f.runner.onJobError(f.context(f.discovery(), 3), "scan failed")
  expect(f.runner.discoveryCurrent(deadline)).toBe(false)
  await expect(f.runner.armDiscovery()).rejects.toThrow(
    "Retry compaction recovery"
  )
})
it("does not invent a controller when its current authority cannot be read", async () => {
  const f = fixture()
  await f.runner.wake()
  const job = f.pump()
  f.get.mockRejectedValue(new Error("read unavailable"))
  await expect(f.runner.onJob(f.context(job))).rejects.toThrow(
    "read unavailable"
  )
  await expect(
    f.runner.onJobError(f.context(job, 3), "read unavailable")
  ).rejects.toThrow("read unavailable")
  f.jobs.delete(job.id)
  await expect(f.runner.wake()).rejects.toThrow("read unavailable")
  expect(f.put).not.toHaveBeenCalled()
  expect(f.step).not.toHaveBeenCalled()
  expect(f.push).toHaveBeenCalledTimes(1)
})

it("preserves a cold exact recovery epoch and retired token when reads fail but writes are available", async () => {
  const previous = fixture()
  await exhaust(previous)
  const failure = (await previous.runner.recovery())!
  await previous.runner.armRecovery(failure.epoch)
  const saved = structuredClone(
    previous.storage.get("memory-compactor:failure")
  )
  const cold = fixture({ jobs: previous.jobs, storage: previous.storage })
  cold.get.mockRejectedValue(new Error("cold controller unavailable"))
  await expect(
    cold.runner.onJobError(
      cold.context(cold.discovery(), 3),
      "scan unavailable"
    )
  ).rejects.toThrow("cold controller unavailable")
  expect(cold.storage.get("memory-compactor:failure")).toEqual(saved)
  expect(cold.put).not.toHaveBeenCalled()
  expect(cold.step).not.toHaveBeenCalled()
  cold.get.mockImplementation(async (key) => cold.storage.get(key))
  expect(await cold.runner.recovery()).toEqual(failure)
})

it("joins cleanup-only settlement, excludes duplicate callbacks, and skips post-stop discovery", async () => {
  const f = fixture(),
    entered = gate(),
    release = gate()
  f.step.mockImplementation(() => Effect.fail("joined producer failure"))
  await f.runner.wake()
  await f.runner.onJob(f.context())
  await Promise.all(f.retained)
  await expect(f.runner.onJob(f.context())).rejects.toBeDefined()
  f.settle.mockImplementation(() =>
    Effect.promise(async () => {
      entered.release()
      await release.wait
    })
  )
  const settling = f.runner.onJob(f.context())
  await entered.wait
  await f.runner.onJob(f.context())
  expect(f.settle).toHaveBeenCalledTimes(1)
  expect(f.retained).toHaveLength(2)
  let done = false
  const stopped = f.runner
    .dispose()
    .catch((error: unknown) => error)
    .finally(() => {
      done = true
    })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(done).toBe(false)
  release.release()
  await Promise.all([settling, stopped])
  expect(f.nextWake).not.toHaveBeenCalled()
  expect(f.step).toHaveBeenCalledTimes(1)
})

it("preserves the producer and complete late cleanup settlement Cause during shutdown", async () => {
  const f = fixture(),
    entered = gate(),
    release = gate()
  const failure = Cause.fromReasons([
    Cause.makeFailReason("late receipt failure"),
    Cause.makeDieReason("late settlement defect"),
  ])
  f.step.mockImplementation(() => Effect.fail("original producer failure"))
  await f.runner.wake()
  await f.runner.onJob(f.context())
  await Promise.all(f.retained)
  await expect(f.runner.onJob(f.context())).rejects.toBeDefined()
  f.settle.mockImplementation(() =>
    Effect.promise(async () => {
      entered.release()
      await release.wait
    }).pipe(Effect.andThen(Effect.failCause(failure)))
  )
  const settling = f.runner.onJob(f.context()).catch((error: unknown) => error)
  await entered.wait
  const stopped = f.runner.dispose().catch((error: unknown) => error)
  release.release()
  const [callback, disposal] = await Promise.all([settling, stopped])
  for (const result of [callback, disposal]) {
    expect(Cause.isCause(result)).toBe(true)
    expect(String(result)).toContain("late receipt failure")
    expect(String(result)).toContain("late settlement defect")
  }
  expect(String(disposal)).toContain("original producer failure")
  expect(f.nextWake).not.toHaveBeenCalled()
})

it("does not admit native work when disposal wins a pending controller read", async () => {
  const f = fixture(),
    entered = gate(),
    release = gate()
  await f.runner.wake()
  f.get.mockImplementation(async (key) => {
    entered.release()
    await release.wait
    return f.storage.get(key)
  })
  const callback = f.runner.onJob(f.context())
  await entered.wait
  await f.runner.dispose()
  release.release()
  await callback
  expect(f.step).not.toHaveBeenCalled()
})
