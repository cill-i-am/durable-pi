import type { LifecycleJob, LifecycleJobPushOptions } from "agents/lifecycle"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AppEventRunner } from "../src/apps/adapters/lifecycle"
import { readAppDiscovery } from "../src/apps/discovery.machine"

vi.mock("agents/lifecycle", () => ({ LifecycleCapability: class {} }))
afterEach(() => vi.useRealTimers())
function fixture() {
  const jobs = new Map<string, LifecycleJob>()
  let pending = false,
    exhausted = 0,
    persistenceFails = false
  const pump = vi.fn(async () => {
    pending = false
    return undefined as number | undefined
  })
  const runner = new AppEventRunner<never>({
    run: Effect.runPromise,
    pump,
    next: () => Effect.succeed(pending ? Date.now() : undefined),
    exhaust: (eligible, expiredOnly) =>
      Effect.sync(() => {
        if (persistenceFails) throw new Error("storage offline")
        if (eligible() && !expiredOnly && pending) {
          pending = false
          exhausted++
        }
      }),
  })
  const push = vi.fn(async (options: LifecycleJobPushOptions) => {
    const job: LifecycleJob = {
      id: options.id!,
      capability: "app-events",
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
  const rearm = vi.fn(async () => {})
  const reschedule = vi.fn(async (id: string, time: number) => {
    const job = jobs.get(id)
    if (!job) return false
    jobs.set(id, { ...job, time })
    return true
  })
  Object.defineProperty(runner, "lifecycle", {
    value: {
      jobs: { get: (id: string) => jobs.get(id), push, rearm, reschedule },
    },
  })
  return {
    runner,
    jobs,
    pump,
    push,
    rearm,
    reschedule,
    job: () => jobs.get("app-events:pump")!,
    pending: (value: boolean) => {
      pending = value
    },
    exhausted: () => exhausted,
    persistenceFails: (value: boolean) => {
      persistenceFails = value
    },
  }
}
describe("Apps retained discovery", () => {
  it("retains actual persisted prearm after a held empty scan, late commit and lost immediate wake", async () => {
    const f = fixture()
    const deadline = await f.runner.armDiscovery()
    const job = f.job()
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.pump.mockImplementationOnce(async () => {
      entered()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return undefined
    })
    const scan = f.runner.onJob({ job, attempt: 1 })
    await waiting
    expect(await f.runner.armDiscovery()).toBe(deadline)
    expect(f.push).toHaveBeenCalledTimes(1)
    release()
    expect(await scan).toEqual({ rescheduleAt: deadline })
    f.pending(true) // accepted after the empty scan; the post-commit wake is lost
    await f.runner.onJob({ job, attempt: 1 })
    expect(f.pump).toHaveBeenCalledTimes(2)
  })
  it("rejects new admission near an active lease expiry without inventing a new deadline or retry budget", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const f = fixture()
    await f.runner.armDiscovery()
    f.pump.mockRejectedValue(new Error("retry"))
    await expect(f.runner.onJob({ job: f.job(), attempt: 1 })).rejects.toThrow(
      "retry"
    )
    vi.setSystemTime(140_000)
    await expect(f.runner.armDiscovery()).rejects.toThrow("finishing")
    await f.runner.wake()
    expect(f.push).toHaveBeenCalledTimes(1)
    expect(f.reschedule).not.toHaveBeenCalled()
    expect(f.job().retry).toEqual({
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
    })
  })
  it("spent execution authority only terminalizes a late accepted render after exhaustion and restart", async () => {
    const f = fixture()
    const deadline = await f.runner.armDiscovery()
    const job = f.job()
    f.pump.mockRejectedValue(new Error("unavailable"))
    for (let attempt = 1; attempt <= 3; attempt++)
      await expect(f.runner.onJob({ job, attempt })).rejects.toThrow()
    await f.runner.onJobError({ job, attempt: 3 }, new Error("exhausted"))
    expect(readAppDiscovery(f.job().payload)).toMatchObject({
      state: "exhausted",
      armedUntil: deadline,
    })
    f.pending(true) // a render admitted by the earlier lease finally commits
    await f.runner.reconcile()
    await f.runner.onJob({ job: f.job(), attempt: 1 })
    expect(f.exhausted()).toBe(1)
    expect(f.pump).toHaveBeenCalledTimes(3)
    await expect(f.runner.armDiscovery()).rejects.toThrow("exhausted")
  })
  it("retains the spent lease when terminal writes fail, then terminalizes after storage returns", async () => {
    const f = fixture()
    await f.runner.armDiscovery()
    const job = f.job()
    f.pending(true)
    f.pump.mockRejectedValue(new Error("unavailable"))
    await expect(f.runner.onJob({ job, attempt: 3 })).rejects.toThrow()
    f.persistenceFails(true)
    await f.runner.onJobError({ job, attempt: 3 }, "exhausted")
    expect(readAppDiscovery(f.job().payload).state).toBe("exhausted")
    f.persistenceFails(false)
    await f.runner.reconcile()
    expect(f.exhausted()).toBe(1)
  })
  it("fences old completion and failure from deleting or exhausting a newer lease", async () => {
    const f = fixture()
    await f.runner.armDiscovery()
    const old = f.job()
    await f.runner.armDiscovery()
    const newer = f.job()
    f.pending(true)
    expect(await f.runner.onJob({ job: old, attempt: 1 })).toEqual({
      rescheduleAt: newer.time,
    })
    expect(await f.runner.onJobError({ job: old, attempt: 3 }, "old")).toEqual({
      rescheduleAt: newer.time,
    })
    expect(f.job()).toBe(newer)
    expect(f.exhausted()).toBe(0)
    expect(f.pump).not.toHaveBeenCalled()
  })
  it("refuses future persisted formats before effects and retains legacy job identity", async () => {
    const f = fixture()
    await f.runner.armDiscovery()
    const job = f.job()
    f.jobs.set(job.id, {
      ...job,
      payload: { ...readAppDiscovery(job.payload), schemaVersion: 99 },
    })
    await expect(f.runner.reconcile()).rejects.toThrow()
    expect(f.pump).not.toHaveBeenCalled()
    f.jobs.set(job.id, { ...job, payload: null })
    await f.runner.reconcile()
    expect(f.job().id).toBe("app-events:pump")
  })
  it("does not grant orphan rows a fresh dispatch budget when the retained job is absent", async () => {
    const f = fixture()
    f.pending(true)
    await f.runner.reconcile()
    await f.runner.wake()
    expect(f.exhausted()).toBe(1)
    expect(f.push).not.toHaveBeenCalled()
    expect(f.pump).not.toHaveBeenCalled()
  })
})

it("does not let a hung replacement failure consume the still-owned dispatch budget", async () => {
  const f = fixture()
  await f.runner.armDiscovery()
  const original = f.job()
  f.pump.mockRejectedValue(new Error("retry"))
  await expect(f.runner.onJob({ job: original, attempt: 1 })).rejects.toThrow(
    "retry"
  )
  const replacement = { ...original }
  expect(await f.runner.onJob({ job: replacement, attempt: 1 })).toHaveProperty(
    "rescheduleAt"
  )
  f.pending(true)
  await f.runner.onJobError({ job: replacement, attempt: 3 }, "replacement")
  expect(readAppDiscovery(f.job().payload).state).toBe("armed")
  expect(f.exhausted()).toBe(0)
  expect(f.push).toHaveBeenCalledTimes(1)
})

it("stale armed callbacks cannot execute or delete a same-token spent lease", async () => {
  const f = fixture()
  const deadline = await f.runner.armDiscovery()
  const armed = f.job()
  f.pump.mockRejectedValue(new Error("retry"))
  for (let attempt = 1; attempt <= 3; attempt++)
    await expect(f.runner.onJob({ job: armed, attempt })).rejects.toThrow(
      "retry"
    )
  await f.runner.onJobError({ job: armed, attempt: 3 }, "exhausted")
  const spent = f.job()
  expect(readAppDiscovery(spent.payload).token).toBe(
    readAppDiscovery(armed.payload).token
  )
  f.pending(true)
  expect(await f.runner.onJob({ job: { ...armed }, attempt: 1 })).toEqual({
    rescheduleAt: deadline,
  })
  expect(f.pump).toHaveBeenCalledTimes(3)
  expect(f.exhausted()).toBe(1)
  expect(
    await f.runner.onJobError({ job: { ...armed }, attempt: 3 }, "stale")
  ).toEqual({ rescheduleAt: deadline })
  expect(f.job()).toBe(spent)
})

it("a failed spent-marker write cannot renew orphan execution or cross a still-live old render lease", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  const f = fixture()
  const deadline = await f.runner.armDiscovery()
  const armed = f.job()
  f.pump.mockRejectedValue(new Error("retry"))
  for (let attempt = 1; attempt <= 3; attempt++)
    await expect(f.runner.onJob({ job: armed, attempt })).rejects.toThrow(
      "retry"
    )
  f.push.mockRejectedValueOnce(new Error("spent marker unavailable"))
  await expect(
    f.runner.onJobError({ job: armed, attempt: 3 }, "exhausted")
  ).rejects.toThrow("spent marker unavailable")
  f.jobs.delete(armed.id) // Installed Lifecycle applies undefined after the hook fails.
  f.pending(true) // An old, already armed render commits before its deadline.
  await expect(f.runner.armDiscovery()).rejects.toThrow("still settling")
  expect(f.exhausted()).toBe(1)
  expect(f.pump).toHaveBeenCalledTimes(3)
  expect(f.jobs.size).toBe(0)
  f.pending(true) // Another late old-lease commit remains terminal-only.
  await expect(f.runner.armDiscovery()).rejects.toThrow("still settling")
  expect(f.exhausted()).toBe(2)
  vi.setSystemTime(deadline + 1)
  // A late old render now fails the ledger's discoveryDeadline check; new
  // authority can be granted only after every old accepted row was terminalized.
  await f.runner.armDiscovery()
  expect(readAppDiscovery(f.job().payload).state).toBe("armed")
  expect(f.pump).toHaveBeenCalledTimes(3)
})
it("fresh absent-job admission fails if orphan terminal persistence is unavailable", async () => {
  const f = fixture()
  f.pending(true)
  f.persistenceFails(true)
  await expect(f.runner.armDiscovery()).rejects.toThrow("storage offline")
  expect(f.push).not.toHaveBeenCalled()
  f.persistenceFails(false)
  await f.runner.armDiscovery()
  expect(f.exhausted()).toBe(1)
})
