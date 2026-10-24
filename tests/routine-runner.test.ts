import type { LifecycleJob, LifecycleJobPushOptions } from "agents/lifecycle"
import { Cause, Context, Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { initialTransition, transition } from "xstate"

import {
  RoutineRunner,
  type RoutineControlAttempt,
} from "../src/routines/adapters/lifecycle"
import {
  armRoutineDiscovery,
  observeRoutineDiscovery,
} from "../src/routines/discovery.machine"
import { routineRunnerMachine } from "../src/routines/runner.machine"

vi.mock("agents/lifecycle", () => ({ LifecycleCapability: class {} }))
const owners = new Set<RoutineRunner<unknown>>()
afterEach(async () => {
  await Promise.allSettled([...owners].map((owner) => owner.dispose()))
  owners.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
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
  const get = vi.fn((id: string) => jobs.get(id))
  const make = () => {
    const runner = new RoutineRunner<unknown>({
      owner,
      run: Effect.runPromise,
      step,
      nextWake: () => Effect.succeed(pending ? Date.now() : undefined),
      exhaust,
    })
    Object.defineProperty(runner, "lifecycle", {
      value: {
        jobs: { get, push, reschedule, rearm },
      },
    })
    owners.add(runner)
    return runner
  }
  return {
    runner: make(),
    get,
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

it.each([false, true])(
  "admits exhaustion once across concurrent callbacks (warm facade %s)",
  async (warm) => {
    const f = fixture(),
      entered = deferred(),
      held = deferred()
    f.step.mockImplementationOnce(async (attempt) => {
      attempt({ id: "run", controlRevision: 3 })
      throw new Error("native failure")
    })
    await f.runner.wake()
    const job = f.pump()
    await expect(f.runner.onJob({ job, attempt: 3 })).rejects.toThrow(
      "native failure"
    )
    f.exhaust.mockImplementationOnce((_attempt, eligible) =>
      Effect.promise(async () => {
        entered.resolve()
        await held.promise
        return eligible()
      })
    )
    const first = f.runner.onJobError({ job, attempt: 3 }, "native failure")
    await entered.promise
    try {
      await (warm ? f.make() : f.runner).onJobError(
        { job, attempt: 3 },
        "duplicate failure"
      )
      expect(f.exhaust).toHaveBeenCalledTimes(1)
    } finally {
      held.resolve()
      await first
    }
  }
)

class NativeReason extends Context.Service<NativeReason, string>()(
  "routine-runner/native-reason"
) {}
for (const mode of ["step", "storage", "exhaust"] as const)
  it.each([false, true])(
    `closing a second facade joins held ${mode} with original Causes (defect %s)`,
    async (defect) => {
      const f = fixture(),
        entered = deferred(),
        held = deferred(),
        warm = f.make()
      const annotation = Context.make(NativeReason, "original")
      const failure = Cause.fromReasons([
        Cause.makeFailReason(new Error("native checked failure")).annotate(
          annotation
        ),
        ...(defect
          ? [
              Cause.makeDieReason(new Error("cleanup defect")).annotate(
                annotation
              ),
            ]
          : []),
        Cause.makeInterruptReason(927).annotate(annotation),
      ])
      const effect = Effect.gen(function* () {
        entered.resolve()
        yield* Effect.promise(() => held.promise)
        return yield* Effect.failCause(failure)
      })
      let accepted: Promise<unknown>
      if (mode === "storage") {
        f.runner.host.nextWake = () => effect
        accepted = f.runner.reconcile()
      } else {
        await f.runner.wake()
        const job = f.pump()
        if (mode === "step") {
          f.step.mockImplementationOnce(async () => {
            entered.resolve()
            await held.promise
            throw failure
          })
          accepted = f.runner.onJob({ job, attempt: 1 })
        } else {
          f.step.mockImplementationOnce(async (receipt) => {
            receipt({ id: "run", controlRevision: 1 })
            throw new Error("step failed")
          })
          await expect(f.runner.onJob({ job, attempt: 3 })).rejects.toThrow(
            "step failed"
          )
          f.runner.host.exhaust = () => effect
          accepted = f.runner.onJobError({ job, attempt: 3 }, "failed")
        }
      }
      const observed = accepted.catch((error: unknown) => error)
      await entered.promise
      let closed = false
      const closing = warm
        .dispose()
        .catch((error: unknown) => error)
        .finally(() => {
          closed = true
        })
      await expect(f.runner.armDiscovery()).rejects.toThrow("stopped")
      expect(closed).toBe(false)
      const afterClose = f.make(),
        reads = f.get.mock.calls.length
      await afterClose.wake()
      await afterClose.reconcile()
      await afterClose.onJob({ job: {} as LifecycleJob, attempt: 1 })
      await afterClose.onJobError(
        { job: {} as LifecycleJob, attempt: 3 },
        "late"
      )
      expect(f.get).toHaveBeenCalledTimes(reads)
      held.resolve()
      for (const result of await Promise.all([observed, closing])) {
        expect(Cause.isCause(result)).toBe(true)
        if (!Cause.isCause(result))
          throw new Error("Expected original native Cause")
        for (const reason of failure.reasons)
          expect(result.reasons).toContain(reason)
      }
      expect(f.runner.dispose()).toBe(warm.dispose())
      expect(afterClose.dispose()).toBe(warm.dispose())
    }
  )

it("a second facade cannot exhaust a still-running callback", async () => {
  const f = fixture(),
    entered = deferred(),
    held = deferred()
  await f.runner.wake()
  const job = f.pump()
  f.step.mockImplementationOnce(async (receipt) => {
    receipt({ id: "run", controlRevision: 1 })
    entered.resolve()
    await held.promise
    return undefined
  })
  const work = f.runner.onJob({ job, attempt: 1 })
  await entered.promise
  try {
    await f.make().onJobError({ job, attempt: 3 }, "premature")
    expect(f.exhaust).not.toHaveBeenCalled()
  } finally {
    held.resolve()
    await work
  }
})

it("a shared schedule owner coalesces wakes while the native write is held", async () => {
  const f = fixture(),
    entered = deferred(),
    held = deferred(),
    warm = f.make()
  const push = f.push.getMockImplementation()!
  f.push.mockImplementationOnce(async (options) => {
    entered.resolve()
    await held.promise
    return push(options)
  })
  const first = f.runner.wake()
  await entered.promise
  const second = warm.wake()
  expect(f.push).toHaveBeenCalledTimes(1)
  held.resolve()
  await Promise.all([first, second])
  expect(f.push).toHaveBeenCalledTimes(1)
  expect(f.reschedule).toHaveBeenCalledTimes(1)
})

it("closing a shared owner releases queued calls but joins a held queue write", async () => {
  const f = fixture(),
    entered = deferred(),
    held = deferred(),
    warm = f.make()
  const push = f.push.getMockImplementation()!
  f.push.mockImplementationOnce(async (options) => {
    entered.resolve()
    await held.promise
    return push(options)
  })
  const armed = f.runner.armDiscovery().catch((error: unknown) => error)
  await entered.promise
  const queued = warm.wake()
  let closed = false
  const closing = warm.dispose().finally(() => {
    closed = true
  })
  await queued
  expect(closed).toBe(false)
  held.resolve()
  expect(await armed).toBeInstanceOf(Error)
  await closing
  expect(f.push).toHaveBeenCalledTimes(1)
})

it("preserves a newer native job when an old held callback completes", async () => {
  const f = fixture(),
    entered = deferred(),
    held = deferred()
  await f.runner.wake()
  const job = f.pump()
  f.step.mockImplementationOnce(async () => {
    entered.resolve()
    await held.promise
    return undefined
  })
  const work = f.runner.onJob({ job, attempt: 1 })
  await entered.promise
  f.jobs.delete(job.id)
  await f.make().wake()
  const newer = f.pump()
  held.resolve()
  expect(await work).toEqual({ rescheduleAt: newer.time })
  expect(f.pump()).toBe(newer)
})

it("validates malformed callback events through the official integration", () => {
  const [initial] = initialTransition(routineRunnerMachine)
  const [state, effects] = transition(routineRunnerMachine, initial, {
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
