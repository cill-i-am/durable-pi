import type { LifecycleJob, LifecycleJobPushOptions } from "agents/lifecycle"
import { Cause, Context, Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { initialTransition, transition } from "xstate"

import { AppEventRunner } from "../src/apps/adapters/lifecycle"
import { readAppDiscovery } from "../src/apps/discovery.machine"
import { appRunnerMachine } from "../src/apps/runner.machine"

vi.mock("agents/lifecycle", () => ({ LifecycleCapability: class {} }))
const runners: AppEventRunner<never>[] = []
afterEach(async () => {
  await Promise.allSettled(runners.splice(0).map((runner) => runner.dispose()))
  vi.useRealTimers()
})
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
  runners.push(runner)
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
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
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
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
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

it("does not admit the same SDK callback again while its native pump is held", async () => {
  const f = fixture()
  await f.runner.armDiscovery()
  const job = f.job()
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  f.pump.mockImplementationOnce(async () => {
    enter()
    await held
    return undefined
  })
  const first = f.runner.onJob({ job, attempt: 1 })
  await entered
  try {
    expect(await f.runner.onJob({ job, attempt: 1 })).toHaveProperty(
      "rescheduleAt"
    )
    expect(f.pump).toHaveBeenCalledTimes(1)
  } finally {
    release()
    await first
  }
})

it("does not spend a lease through a failure callback while its native pump is held", async () => {
  const f = fixture()
  await f.runner.armDiscovery()
  const job = f.job()
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  f.pump.mockImplementationOnce(async () => {
    enter()
    await held
    return undefined
  })
  const first = f.runner.onJob({ job, attempt: 1 })
  await entered
  try {
    await f.runner.onJobError({ job, attempt: 3 }, "overlapping callback")
    expect(readAppDiscovery(f.job().payload).state).toBe("armed")
    expect(f.push).toHaveBeenCalledTimes(1)
  } finally {
    release()
    await first
  }
})

function gate<A>() {
  let resolve!: (value: A) => void, reject!: (error: unknown) => void
  const promise = new Promise<A>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
it("closes admission and joins a held pump before disposal settles", async () => {
  const f = fixture(),
    entered = gate<void>(),
    held = gate<void>()
  await f.runner.armDiscovery()
  const job = f.job()
  f.pump.mockImplementationOnce(async () => {
    entered.resolve()
    await held.promise
    return undefined
  })
  const callback = f.runner.onJob({ job, attempt: 1 })
  await entered.promise
  let disposed = false
  const closing = f.runner.dispose().then(() => {
    disposed = true
  })
  await f.runner.wake()
  expect(disposed).toBe(false)
  await expect(f.runner.armDiscovery()).rejects.toThrow("disposed")
  await f.runner.onJob({ job, attempt: 1 })
  await f.runner.onJobError({ job, attempt: 3 }, "late")
  expect(f.pump).toHaveBeenCalledTimes(1)
  held.resolve()
  await Promise.all([closing, callback])
  await f.runner.dispose()
  expect(disposed).toBe(true)
})
it("joins accepted scheduling, rejects queued admission on close, and cannot return a late lease", async () => {
  const f = fixture(),
    entered = gate<void>(),
    held = gate<void>()
  const push = f.push.getMockImplementation()!
  f.push.mockImplementationOnce(async (options) => {
    entered.resolve()
    await held.promise
    return push(options)
  })
  const first = f.runner.armDiscovery().catch((error: unknown) => error)
  await entered.promise
  const second = f.runner.armDiscovery().catch((error: unknown) => error)
  let disposed = false
  const closing = f.runner.dispose().then(() => {
    disposed = true
  })
  expect(await second).toMatchObject({
    message: "App runner has been disposed",
  })
  expect(disposed).toBe(false)
  held.resolve()
  expect(await first).toMatchObject({ message: "App runner has been disposed" })
  await closing
  expect(f.push).toHaveBeenCalledTimes(1)
  expect(f.pump).not.toHaveBeenCalled()
})
it("does not overlap scheduling or dispatch while the native queue update is held", async () => {
  const f = fixture(),
    entered = gate<void>(),
    held = gate<void>()
  await f.runner.armDiscovery()
  const job = f.job(),
    push = f.push.getMockImplementation()!
  f.push.mockImplementationOnce(async (options) => {
    entered.resolve()
    await held.promise
    return push(options)
  })
  const first = f.runner.armDiscovery()
  await entered.promise
  const second = f.runner.armDiscovery()
  expect(await f.runner.onJob({ job, attempt: 1 })).toHaveProperty(
    "rescheduleAt"
  )
  expect(f.push).toHaveBeenCalledTimes(2)
  expect(f.pump).not.toHaveBeenCalled()
  held.resolve()
  await Promise.all([first, second])
  expect(f.push).toHaveBeenCalledTimes(3)
  expect(readAppDiscovery(f.job().payload).state).toBe("armed")
})
class NativeTrace extends Context.Service<NativeTrace, string>()(
  "app-runner/NativeTrace"
) {}
it.each([false, true])(
  "retains full native cleanup Cause at callback and disposal (defect %s)",
  async (defect) => {
    const f = fixture(),
      entered = gate<void>(),
      held = gate<void>()
    const checked = new Error("checked cleanup"),
      died = new Error("defect cleanup")
    const annotation = Context.make(NativeTrace, "original")
    const cause = Cause.fromReasons([
      Cause.makeFailReason(checked).annotate(annotation),
      ...(defect ? [Cause.makeDieReason(died).annotate(annotation)] : []),
      Cause.makeInterruptReason(44206).annotate(annotation),
    ])
    await f.runner.armDiscovery()
    f.pump.mockImplementationOnce(async () => {
      entered.resolve()
      await held.promise
      return undefined
    })
    const callback = f.runner
      .onJob({ job: f.job(), attempt: 1 })
      .catch((error: unknown) => error)
    await entered.promise
    const closing = f.runner.dispose().catch((error: unknown) => error)
    await f.runner.wake()
    held.reject(cause)
    for (const failure of await Promise.all([callback, closing])) {
      expect(Cause.isCause(failure)).toBe(true)
      if (!Cause.isCause(failure)) throw new Error("Expected full native Cause")
      expect(failure.reasons).toHaveLength(defect ? 3 : 2)
      for (const reason of failure.reasons)
        expect(reason.annotations.get(NativeTrace.key)).toBe("original")
      expect(
        failure.reasons.some(
          (reason) => reason._tag === "Fail" && reason.error === checked
        )
      ).toBe(true)
      expect(
        failure.reasons.some(
          (reason) => reason._tag === "Interrupt" && reason.fiberId === 44206
        )
      ).toBe(true)
      expect(
        failure.reasons.some(
          (reason) => reason._tag === "Die" && reason.defect === died
        )
      ).toBe(defect)
    }
  }
)
it("rejects malformed callback events through official runtime validation", () => {
  const [state] = initialTransition(appRunnerMachine)
  const [next, effects] = transition(appRunnerMachine, state, {
    type: "ADMIT",
    job: null,
    token: "",
    until: -1,
    current: "yes",
    spent: false,
    reply: null,
  } as never)
  expect(next.value).toEqual(state.value)
  expect(
    effects.some(
      (effect) =>
        effect.kind === "builtin" &&
        effect.type === "@xstate.deadLetter" &&
        effect.reason === "invalidEvent"
    )
  ).toBe(true)
})
