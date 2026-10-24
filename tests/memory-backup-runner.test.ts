import type { LifecycleJob, LifecycleJobPushOptions } from "agents/lifecycle"
import { Cause, Effect } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import { BackupRunner } from "../src/memory/adapters/backup-lifecycle"
import type { BackupClaim } from "../src/memory/backup.machine"
import type { MemoryStorageError } from "../src/memory/domain"
import { nativeOperation } from "../src/shared/interop"

vi.mock("agents/lifecycle", () => ({ LifecycleCapability: class {} }))
afterEach(() => vi.restoreAllMocks())
const id = "memory-backups:pump"
const claim: BackupClaim = {
  attemptId: "original",
  target: "watermark",
  attempts: 1,
}
const gate = () => {
  let release!: () => void
  const wait = new Promise<void>((done) => {
    release = done
  })
  return { release, wait }
}
function fixture(durable?: {
  jobs: Map<string, LifecycleJob>
  storage: Map<string, unknown>
}) {
  const jobs = durable?.jobs ?? new Map<string, LifecycleJob>(),
    storage = durable?.storage ?? new Map<string, unknown>(),
    retained: Promise<void>[] = []
  let work: Effect.Effect<number | undefined, unknown> =
    Effect.succeed(undefined)
  let cleanup: Effect.Effect<void, unknown> = Effect.void
  const committed: BackupClaim[] = []
  const step = vi.fn(
    (
      onClaim: (claim: BackupClaim) => Effect.Effect<void, MemoryStorageError>
    ) =>
      Effect.andThen(
        onClaim(claim),
        Effect.suspend(() => work)
      )
  )
  let restoration: Effect.Effect<void, unknown> = Effect.void
  const restore = vi.fn(() => restoration)
  const exhaust = vi.fn(
    (receipt: BackupClaim | undefined, current: () => boolean) =>
      cleanup.pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (receipt && current()) committed.push(receipt)
          })
        )
      )
  )
  const runner = new BackupRunner<unknown>({
    run: Effect.runPromise,
    step,
    restore,
    exhaust,
    retain: (pending) => {
      retained.push(pending)
    },
  })
  const push = vi.fn(async (options: LifecycleJobPushOptions) => {
    const job: LifecycleJob = {
      id: options.id!,
      capability: "memory-backups",
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
  const reschedule = vi.fn(async (jobId: string, time: number) => {
    const current = jobs.get(jobId)
    if (!current) return false
    jobs.set(jobId, { ...current, time })
    return true
  })
  const rearm = vi.fn(async () => {})
  const trackAlarmWork = vi.fn()
  const get = vi.fn(async (key: string) => storage.get(key))
  Object.defineProperty(runner, "lifecycle", {
    value: {
      storage: {
        get,
        put: async (key: string, value: unknown) => {
          storage.set(key, value)
        },
      },
      jobs: {
        get: (jobId: string) => jobs.get(jobId),
        push,
        reschedule,
        rearm,
      },
      trackAlarmWork,
    },
  })
  return {
    runner,
    jobs,
    storage,
    retained,
    step,
    restore,
    exhaust,
    committed,
    push,
    reschedule,
    rearm,
    trackAlarmWork,
    get,
    setWork: (value: typeof work) => {
      work = value
    },
    setCleanup: (value: typeof cleanup) => {
      cleanup = value
    },
    setRestore: (value: typeof restoration) => {
      restoration = value
    },
    job: () => jobs.get(id)!,
    context: () => ({ job: jobs.get(id)!, attempt: 1 }),
    seed: () => push({ id, fn: "pump", time: 1, payload: null }),
  }
}
it("consumes the exact historical payloadless queue row and restores only once", async () => {
  const f = fixture()
  await f.seed()
  await f.runner.wake()
  const first = f.job()
  expect(first.id).toBe("memory-backups:pump")
  expect(first.payload).toBeNull()
  expect(f.push).toHaveBeenCalledTimes(1)
  expect(await f.runner.onJob(f.context())).toMatchObject({
    rescheduleAt: expect.any(Number),
  })
  await Promise.all(f.retained)
  expect(f.step).toHaveBeenCalledTimes(1)
  expect(await f.runner.onJob(f.context())).toBeUndefined()
  expect(f.restore).toHaveBeenCalledTimes(1)
  expect(f.push).toHaveBeenCalledTimes(1)
})
it("holds one native producer outside alarm dispatch; ordinary wakes retain queue identity and retry budget", async () => {
  const f = fixture(),
    entered = gate(),
    release = gate()
  f.setWork(
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
  const queued = f.job()
  await f.runner.onJob(f.context())
  await entered.wait
  try {
    await f.runner.wake()
    await f.runner.onJob(f.context())
    expect(f.step).toHaveBeenCalledTimes(1)
    expect(f.job().payload).toEqual(queued.payload)
    expect(f.job().retry).toEqual({
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
    })
    expect(f.push).toHaveBeenCalledTimes(1)
    expect(f.trackAlarmWork).toHaveBeenCalledTimes(1)
  } finally {
    release.release()
  }
  await Promise.all(f.retained)
  // The wake received while work was live gets one follow-up observation.
  expect(await f.runner.onJob(f.context())).toMatchObject({
    rescheduleAt: expect.any(Number),
  })
  f.setWork(Effect.succeed(undefined))
  await f.runner.onJob(f.context())
  await Promise.all(f.retained)
  expect(await f.runner.onJob(f.context())).toBeUndefined()
  expect(f.step).toHaveBeenCalledTimes(2)
})
it("preserves the full native Cause and scheduling defect before exact-claim exhaustion", async () => {
  const f = fixture(),
    defect = new SyntaxError("native cleanup defect"),
    scheduling = new Error("queue write defect")
  const cause = Cause.fromReasons([
    Cause.makeFailReason("checked"),
    Cause.makeDieReason(defect),
  ])
  f.setWork(Effect.failCause(cause))
  await f.runner.wake()
  f.reschedule.mockRejectedValueOnce(scheduling)
  await f.runner.onJob(f.context())
  await Promise.all(f.retained)
  let caught: unknown
  try {
    await f.runner.onJob(f.context())
  } catch (error) {
    caught = error
  }
  expect(Cause.isCause(caught)).toBe(true)
  if (Cause.isCause(caught)) {
    expect(caught.reasons).toEqual(expect.arrayContaining([...cause.reasons]))
    expect(caught.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ _tag: "Die", defect: scheduling }),
      ])
    )
  }
  // SDK retries see the same retained failure, never a successful heartbeat
  // that would reset its finite transport attempt counter.
  await expect(f.runner.onJob(f.context())).rejects.toBe(caught)
  const schedulingCalls = f.reschedule.mock.calls.length
  await f.runner.wake()
  expect(f.reschedule).toHaveBeenCalledTimes(schedulingCalls)
  await expect(f.runner.onJob(f.context())).rejects.toBe(caught)
  expect(f.step).toHaveBeenCalledTimes(1)
  await f.runner.onJobError(f.context(), caught)
  expect(f.committed).toEqual([claim])
})
it("terminal storage failure creates one bounded cleanup-only receipt and never reruns provider work", async () => {
  const f = fixture()
  f.setWork(Effect.die("native failure"))
  await f.runner.wake()
  await f.runner.onJob(f.context())
  await Promise.all(f.retained)
  f.setCleanup(Effect.die("storage unavailable"))
  const failed = f.context()
  await f.runner.onJobError(failed, "exhausted")
  expect(f.job().payload).toMatchObject({ phase: "cleanup", claim })
  expect(f.job().retry?.maxAttempts).toBe(3)
  const pushes = f.push.mock.calls.length
  await expect(f.runner.onJob(f.context())).rejects.toBeDefined()
  expect(f.step).toHaveBeenCalledTimes(1)
  await f.runner.onJobError(f.context(), "cleanup exhausted")
  expect(f.push).toHaveBeenCalledTimes(pushes)
  expect(f.committed).toEqual([])
})
it("a successful cleanup-only receipt uses the exact owner without admitting a second backup", async () => {
  const f = fixture()
  f.setWork(Effect.die("native failure"))
  await f.runner.wake()
  await f.runner.onJob(f.context())
  await Promise.all(f.retained)
  f.setCleanup(Effect.die("storage unavailable"))
  await f.runner.onJobError(f.context(), "exhausted")
  f.setCleanup(Effect.void)
  expect(await f.runner.onJob(f.context())).toBeUndefined()
  expect(f.committed).toEqual([claim])
  expect(f.step).toHaveBeenCalledTimes(1)
})
it("replacement during failed terminal publication cannot be overwritten by stale cleanup", async () => {
  const f = fixture(),
    entered = gate(),
    release = gate()
  f.setWork(Effect.die("native failure"))
  await f.runner.wake()
  await f.runner.onJob(f.context())
  await Promise.all(f.retained)
  f.setCleanup(
    nativeOperation(
      async () => {
        entered.release()
        await release.wait
        throw "storage unavailable"
      },
      (error) => error
    )
  )
  const pending = f.runner.onJobError(f.context(), "exhausted")
  await entered.wait
  const replacement = {
    ...f.job(),
    payload: {
      schemaVersion: 1,
      workflowVersion: 1,
      token: "new-owner",
      phase: "work",
      claim: null,
      discoveryDeadline: 0,
    },
  }
  f.jobs.set(id, replacement)
  release.release()
  expect(await pending).toEqual({ rescheduleAt: replacement.time })
  expect(f.job()).toBe(replacement)
  expect(f.push).toHaveBeenCalledTimes(1)
  expect(f.committed).toEqual([])
})
it("rejects future queue versions before restoration or provider admission", async () => {
  const f = fixture()
  await f.runner.wake()
  f.jobs.set(id, {
    ...f.job(),
    payload: {
      schemaVersion: 99,
      workflowVersion: 1,
      token: "future",
      phase: "work",
      claim: null,
      discoveryDeadline: 0,
    },
  })
  await expect(f.runner.onJob(f.context())).rejects.toBeDefined()
  expect(f.restore).not.toHaveBeenCalled()
  expect(f.step).not.toHaveBeenCalled()
})
it("disposal signals cancellation and joins the actual held native producer", async () => {
  const f = fixture(),
    entered = gate(),
    release = gate(),
    cancelled = gate()
  f.setWork(
    nativeOperation(
      async (signal) => {
        signal.addEventListener("abort", () => cancelled.release(), {
          once: true,
        })
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
  let disposed = false
  const pending = f.runner.dispose().then(() => {
    disposed = true
  })
  await cancelled.wait
  try {
    expect(disposed).toBe(false)
    expect(f.step).toHaveBeenCalledTimes(1)
  } finally {
    release.release()
  }
  await pending
  expect(disposed).toBe(true)
})

it("disposal preserves a late native cleanup defect after cancellation", async () => {
  const f = fixture(),
    entered = gate(),
    release = gate(),
    cancelled = gate()
  const defect = new SyntaxError("late native disposal defect")
  f.setWork(
    nativeOperation(
      async (signal) => {
        signal.addEventListener("abort", () => cancelled.release(), {
          once: true,
        })
        entered.release()
        await release.wait
        throw defect
      },
      () => {
        throw defect
      }
    )
  )
  await f.runner.wake()
  await f.runner.onJob(f.context())
  await entered.wait
  const pending = f.runner.dispose().then(
    () => undefined,
    (error: unknown) => error
  )
  await cancelled.wait
  release.release()
  const failed = await pending
  expect(Cause.isCause(failed)).toBe(true)
  if (Cause.isCause(failed)) {
    expect(Cause.hasInterrupts(failed)).toBe(true)
    expect(failed.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ _tag: "Die", defect })])
    )
  }
})

it("ordinary prearm retains an empty scan until its real lease without replacing the pump budget", async () => {
  let now = 1000
  vi.spyOn(Date, "now").mockImplementation(() => now)
  const f = fixture()
  await f.runner.wake()
  const original = f.job()
  const lease = await f.runner.armDiscovery()
  expect(f.job()).toBe(original)
  expect(lease.deadline).toBe(61000)
  const discovery = f.jobs.get("memory-backups:discovery")!
  expect(await f.runner.onJob({ job: discovery, attempt: 1 })).toEqual({
    rescheduleAt: 61000,
  })
  await f.runner.onJob(f.context())
  await Promise.all(f.retained)
  expect(await f.runner.onJob(f.context())).toBeUndefined()
  f.jobs.delete(id)
  expect(lease.current()).toBe(true)
  now = 61000
  expect(await f.runner.onJob({ job: discovery, attempt: 1 })).toBeUndefined()
  expect(f.job().id).toBe(id)
  await f.runner.onJob(f.context())
  await Promise.all(f.retained)
  expect(f.step).toHaveBeenCalledTimes(2)
})
it("explicit recovery prearm retains its empty pump and replaced leases become ineligible", async () => {
  let now = 1000
  vi.spyOn(Date, "now").mockImplementation(() => now)
  const f = fixture()
  const lease = await f.runner.armRecovery()
  await f.runner.onJob(f.context())
  await Promise.all(f.retained)
  expect(await f.runner.onJob(f.context())).toEqual({ rescheduleAt: 61000 })
  expect(lease.current()).toBe(true)
  now = 2000
  const replacement = await f.runner.armRecovery()
  expect(lease.current()).toBe(false)
  expect(replacement.current()).toBe(true)
  expect(replacement.deadline).toBe(62000)
})

it("final preclaim discovery failure is actionable and ordinary wakes cannot erase its finite exhaustion", async () => {
  let now = 1000
  vi.spyOn(Date, "now").mockImplementation(() => now)
  const f = fixture()
  await f.runner.armDiscovery()
  const discovery = f.jobs.get("memory-backups:discovery")!,
    context = { job: discovery, attempt: 3 }
  f.push.mockRejectedValue(new Error("synthetic queue storage unavailable"))
  for (let attempt = 1; attempt <= 3; attempt++)
    await expect(f.runner.onJob({ ...context, attempt })).rejects.toThrow(
      "synthetic queue"
    )
  await f.runner.onJobError(context, "transport budget exhausted")
  const recovery = await f.runner.recovery()
  expect(recovery).toMatchObject({ epoch: expect.any(String), failedAt: 1000 })
  expect(f.step).not.toHaveBeenCalled()
  expect(f.committed).toEqual([])
  const pushes = f.push.mock.calls.length
  await f.runner.wake()
  await expect(f.runner.armDiscovery()).rejects.toThrow(
    "Retry backup scheduling"
  )
  await expect(f.runner.armSchedulerRecovery("stale")).rejects.toThrow(
    "changed"
  )
  expect(f.push).toHaveBeenCalledTimes(pushes)
  f.push.mockReset()
  // Restore the real synthetic queue adapter, without altering its retained rows.
  f.push.mockImplementation(async (options) => {
    const job: LifecycleJob = {
      id: options.id!,
      capability: "memory-backups",
      fn: options.fn,
      time: options.time,
      payload: options.payload,
      retry: options.retry,
      singleflight: options.singleflight ?? false,
      exclusive: false,
      recoveryLoop: true,
      createdAt: now,
    }
    f.jobs.set(job.id, job)
    return job
  })
  const expired = await f.runner.armSchedulerRecovery(recovery!.epoch)
  now = expired.deadline
  expect(await f.runner.retrySchedulerRecovery(recovery!.epoch, expired)).toBe(
    false
  )
  expect(await f.runner.recovery()).toEqual(recovery)
  const fresh = await f.runner.armSchedulerRecovery(recovery!.epoch)
  expect(await f.runner.retrySchedulerRecovery(recovery!.epoch, fresh)).toBe(
    true
  )
  expect(await f.runner.recovery()).toBeUndefined()
  expect(f.job().id).toBe(id)
  expect(f.step).not.toHaveBeenCalled()
})
it("discovery exhaustion and explicit recovery cannot replace a still-live backup producer", async () => {
  const f = fixture(),
    entered = gate(),
    release = gate()
  f.setWork(
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
  const original = f.job()
  await f.runner.onJob(f.context())
  await entered.wait
  try {
    await f.runner.armDiscovery()
    const discovery = f.jobs.get("memory-backups:discovery")!
    await f.runner.onJobError(
      { job: discovery, attempt: 3 },
      "discovery failed"
    )
    const recovery = (await f.runner.recovery())!
    await expect(f.runner.armSchedulerRecovery(recovery.epoch)).rejects.toThrow(
      "still running"
    )
    await expect(f.runner.armRecovery()).rejects.toThrow("still running")
    expect(await f.runner.onJob({ job: original, attempt: 1 })).toMatchObject({
      rescheduleAt: expect.any(Number),
    })
    expect(f.job().payload).toEqual(original.payload)
    expect(f.step).toHaveBeenCalledTimes(1)
  } finally {
    release.release()
  }
  await Promise.all(f.retained)
  const recovery = (await f.runner.recovery())!
  const lease = await f.runner.armSchedulerRecovery(recovery.epoch)
  expect(await f.runner.retrySchedulerRecovery(recovery.epoch, lease)).toBe(
    true
  )
  expect(f.step).toHaveBeenCalledTimes(1)
})
it("explicit domain retry prearm rejects a live owner even before any scheduler failure", async () => {
  const f = fixture(),
    entered = gate(),
    release = gate()
  f.setWork(
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
  const job = f.job()
  await f.runner.onJob(f.context())
  await entered.wait
  try {
    await expect(f.runner.armRecovery()).rejects.toThrow("still running")
    expect(f.job()).toBe(job)
    expect(f.step).toHaveBeenCalledTimes(1)
  } finally {
    release.release()
  }
  await Promise.all(f.retained)
})
it("final cleanup storage exhaustion exposes scheduler recovery without inventing another native attempt", async () => {
  const f = fixture()
  f.setWork(Effect.die("native defect"))
  await f.runner.wake()
  await f.runner.onJob(f.context())
  await Promise.all(f.retained)
  f.setCleanup(Effect.die("storage unavailable"))
  await f.runner.onJobError(f.context(), "work exhausted")
  const cleanup = f.context()
  await f.runner.onJobError(cleanup, "cleanup exhausted")
  expect(await f.runner.recovery()).toMatchObject({ epoch: expect.any(String) })
  const pushes = f.push.mock.calls.length
  await f.runner.wake()
  expect(f.push).toHaveBeenCalledTimes(pushes)
  expect(f.step).toHaveBeenCalledTimes(1)
  expect(f.committed).toEqual([])
})

it("retains a joined failed claim after discovery exhaustion deletes the native pump", async () => {
  const f = fixture(),
    entered = gate(),
    release = gate()
  f.setWork(
    nativeOperation(
      async () => {
        entered.release()
        await release.wait
        throw new Error("held publisher failed")
      },
      (error) => error
    )
  )
  await f.runner.wake()
  await f.runner.onJob(f.context())
  await entered.wait
  await f.runner.armDiscovery()
  const discovery = f.jobs.get("memory-backups:discovery")!
  await f.runner.onJobError(
    { job: discovery, attempt: 3 },
    "discovery exhausted"
  )
  release.release()
  await Promise.all(f.retained)
  expect(await f.runner.onJob(f.context())).toBeUndefined()
  // Installed Lifecycle deletes a job whose outcome is undefined.
  f.jobs.delete(id)
  expect(f.storage.get("memory-backups:failure")).toMatchObject({ claim })
  const recovery = (await f.runner.recovery())!
  const lease = await f.runner.armSchedulerRecovery(recovery.epoch)
  expect(await f.runner.retrySchedulerRecovery(recovery.epoch, lease)).toBe(
    true
  )
  expect(f.job().payload).toMatchObject({ phase: "cleanup", claim })
  await f.runner.onJob(f.context())
  expect(f.committed).toEqual([claim])
  expect(f.step).toHaveBeenCalledTimes(1)
})

it("cold explicit recovery replays the exact claim after the finite cleanup queue is deleted", async () => {
  const f = fixture()
  f.setWork(Effect.die("publication failed"))
  f.setCleanup(Effect.die("status unavailable"))
  await f.runner.wake()
  await f.runner.onJob(f.context())
  await Promise.all(f.retained)
  await f.runner.onJobError(f.context(), "work exhausted")
  await f.runner.onJobError(f.context(), "cleanup exhausted")
  f.jobs.delete(id)
  const recovery = (await f.runner.recovery())!
  expect(f.storage.get("memory-backups:failure")).toMatchObject({ claim })
  const cold = fixture(f)
  await cold.runner.reconcile()
  await cold.runner.wake()
  expect(cold.jobs.has(id)).toBe(false)
  const lease = await cold.runner.armSchedulerRecovery(recovery.epoch)
  expect(await cold.runner.retrySchedulerRecovery(recovery.epoch, lease)).toBe(
    true
  )
  expect(cold.job().payload).toMatchObject({ phase: "cleanup", claim })
  await expect(cold.runner.armRecovery()).rejects.toThrow("still running")
  await cold.runner.onJob(cold.context())
  expect(cold.committed).toEqual([claim])
  expect(cold.step).not.toHaveBeenCalled()
  expect(f.step).toHaveBeenCalledTimes(1)
  expect(cold.storage.get("memory-backups:failure")).toMatchObject({
    claim: null,
  })
})

it("dispose joins a held restore and forbids provider admission after shutdown", async () => {
  const f = fixture(),
    entered = gate(),
    release = gate()
  f.setRestore(
    Effect.promise(async () => {
      entered.release()
      await release.wait
    })
  )
  await f.runner.wake()
  const dispatch = f.runner.onJob(f.context())
  await entered.wait
  let disposed = false
  const disposing = f.runner.dispose().then(() => {
    disposed = true
  })
  await Promise.resolve()
  expect(disposed).toBe(false)
  release.release()
  await Promise.all([disposing, dispatch])
  expect(disposed).toBe(true)
  expect(f.step).not.toHaveBeenCalled()
  const closed = { job: f.job(), attempt: 1 }
  // New callbacks after disposal cannot even query closed queue storage.
  f.jobs.clear()
  f.jobs.get = () => {
    throw new Error("storage already closed")
  }
  expect(await f.runner.onJob(closed)).toBeUndefined()
  expect(await f.runner.onJobError(closed, "late callback")).toBeUndefined()
})

it("dispose joins held terminal cleanup before its resources may close", async () => {
  const f = fixture(),
    entered = gate(),
    release = gate()
  f.setWork(Effect.die("publication failed"))
  await f.runner.wake()
  await f.runner.onJob(f.context())
  await Promise.all(f.retained)
  f.setCleanup(Effect.die("status unavailable"))
  await f.runner.onJobError(f.context(), "work exhausted")
  f.setCleanup(
    Effect.promise(async () => {
      entered.release()
      await release.wait
    })
  )
  const dispatch = f.runner.onJob(f.context())
  await entered.wait
  let disposed = false
  const disposing = f.runner.dispose().then(() => {
    disposed = true
  })
  await Promise.resolve()
  expect(disposed).toBe(false)
  release.release()
  await Promise.all([disposing, dispatch])
  expect(disposed).toBe(true)
  expect(f.committed).toEqual([claim])
  expect(f.step).toHaveBeenCalledTimes(1)
})

it("domain retry cannot replace a joined failed owner or its queued exact cleanup", async () => {
  const f = fixture()
  f.setWork(Effect.die("claimed publication failed"))
  await f.runner.wake()
  await f.runner.onJob(f.context())
  await Promise.all(f.retained)
  const original = f.job()
  await expect(f.runner.armRecovery()).rejects.toThrow("still running")
  expect(f.job()).toBe(original)
  expect(f.step).toHaveBeenCalledTimes(1)
  f.setCleanup(Effect.die("cleanup storage unavailable"))
  await f.runner.onJobError(f.context(), "work exhausted")
  const cleanup = f.job()
  await expect(f.runner.armRecovery()).rejects.toThrow("still running")
  expect(f.job()).toBe(cleanup)
  expect(f.step).toHaveBeenCalledTimes(1)
  f.setCleanup(Effect.void)
  await f.runner.onJob(f.context())
  f.jobs.delete(id)
  expect(f.committed).toEqual([claim])
  await expect(f.runner.armRecovery()).resolves.toMatchObject({
    deadline: expect.any(Number),
  })
})

it("a successfully joined domain failure may explicitly retry without waiting for its ready queue acknowledgement", async () => {
  const f = fixture()
  // Domain BackupFailure is handled inside runMemoryBackup, which returns normally
  // after storing actionable business exhaustion. No failed native Cause remains.
  f.setWork(Effect.succeed(undefined))
  await f.runner.wake()
  await f.runner.onJob(f.context())
  await Promise.all(f.retained)
  await expect(f.runner.armRecovery()).resolves.toMatchObject({
    deadline: expect.any(Number),
  })
  expect(f.step).toHaveBeenCalledTimes(1)
})

it("domain retry cannot replace the original owner while terminal cleanup is held", async () => {
  const f = fixture(),
    entered = gate(),
    release = gate()
  f.setWork(Effect.die("publication failed"))
  await f.runner.wake()
  await f.runner.onJob(f.context())
  await Promise.all(f.retained)
  f.setCleanup(
    Effect.promise(async () => {
      entered.release()
      await release.wait
    })
  )
  const original = f.job(),
    terminal = f.runner.onJobError(f.context(), "work exhausted")
  await entered.wait
  try {
    await expect(f.runner.armRecovery()).rejects.toThrow("still running")
    expect(f.job()).toBe(original)
    expect(f.step).toHaveBeenCalledTimes(1)
  } finally {
    release.release()
  }
  await terminal
  expect(f.committed).toEqual([claim])
})

it("cold controller read failure preserves the existing exhausted exact cleanup receipt", async () => {
  const f = fixture()
  f.setWork(Effect.die("publisher failure"))
  f.setCleanup(Effect.die("cleanup outage"))
  await f.runner.wake()
  await f.runner.onJob(f.context())
  await Promise.all(f.retained)
  await f.runner.onJobError(f.context(), "work exhausted")
  await f.runner.onJobError(f.context(), "cleanup exhausted")
  f.jobs.delete(id)
  const recovery = (await f.runner.recovery())!
  await f.runner.armSchedulerRecovery(recovery.epoch)
  const before = f.storage.get("memory-backups:failure")
  expect(before).toMatchObject({ phase: "exhausted", claim })
  const cold = fixture(f)
  cold.get.mockRejectedValue(new Error("controller read unavailable"))
  const discovery = cold.jobs.get("memory-backups:discovery")!
  for (let attempt = 1; attempt <= 3; attempt++)
    await expect(
      cold.runner.onJob({ job: discovery, attempt })
    ).rejects.toThrow("read unavailable")
  await expect(
    cold.runner.onJobError(
      { job: discovery, attempt: 3 },
      "discovery exhausted"
    )
  ).rejects.toThrow("read unavailable")
  expect(cold.storage.get("memory-backups:failure")).toEqual(before)
  cold.get.mockImplementation(async (key) => cold.storage.get(key))
  const lease = await cold.runner.armSchedulerRecovery(recovery.epoch)
  expect(await cold.runner.retrySchedulerRecovery(recovery.epoch, lease)).toBe(
    true
  )
  expect(cold.job().payload).toMatchObject({ phase: "cleanup", claim })
  await cold.runner.onJob(cold.context())
  expect(cold.committed).toEqual([claim])
  expect(cold.step).not.toHaveBeenCalled()
})

it("revokes retained Backup leases and rejects post-close recovery before storage access", async () => {
  const f = fixture()
  const lease = await f.runner.armDiscovery()
  await f.runner.dispose()
  f.jobs.get = () => {
    throw new Error("closed native job store")
  }
  f.storage.get = () => {
    throw new Error("closed native controller store")
  }
  expect(lease.current()).toBe(false)
  await f.runner.wake()
  await f.runner.reconcile()
  await expect(f.runner.recovery()).rejects.toThrow("stopped")
  await expect(f.runner.armDiscovery()).rejects.toThrow("stopped")
  await expect(f.runner.armRecovery()).rejects.toThrow("stopped")
  await expect(f.runner.armSchedulerRecovery("epoch")).rejects.toThrow(
    "stopped"
  )
  expect(await f.runner.retrySchedulerRecovery("epoch", lease)).toBe(false)
})

it.each([false, true])(
  "retains compound storage settlement failure when closing (defect %s)",
  async (defect) => {
    const f = fixture(),
      entered = gate(),
      held = gate()
    const failure = Cause.fromReasons([
      Cause.makeFailReason("checked storage settlement"),
      ...(defect ? [Cause.makeDieReason("native storage cleanup")] : []),
      Cause.makeInterruptReason(77104),
    ])
    f.get.mockImplementationOnce(async () => {
      entered.release()
      await held.wait
      throw failure
    })
    const admission = f.runner.armDiscovery().catch((error: unknown) => error)
    await entered.wait
    let disposed = false
    const closing = f.runner
      .dispose()
      .catch((error: unknown) => error)
      .finally(() => {
        disposed = true
      })
    await new Promise((resolve) => setImmediate(resolve))
    expect(disposed).toBe(false)
    held.release()
    for (const result of await Promise.all([admission, closing])) {
      expect(Cause.isCause(result)).toBe(true)
      if (!Cause.isCause(result)) throw new Error("Expected full native Cause")
      expect(result.reasons).toEqual(failure.reasons)
    }
  }
)
