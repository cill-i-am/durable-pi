import type { LifecycleJob, LifecycleJobPushOptions } from "agents/lifecycle"
import { Cause, Context, Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AppEventRunner } from "../src/apps/adapters/lifecycle"
import { CoordinationRunner } from "../src/coordination/adapters/lifecycle"
import { BackgroundRunner } from "../src/delegation/adapters/background-lifecycle"
import { ReplyRunner } from "../src/replies/adapters/lifecycle"

vi.mock("agents/lifecycle", () => ({ LifecycleCapability: class {} }))
const owners = new Set<{ dispose?: () => Promise<void> }>()
afterEach(async () => {
  await Promise.allSettled([...owners].map((owner) => owner.dispose?.()))
  owners.clear()
})
class Annotation extends Context.Service<Annotation, string>()(
  "runner-boundary-proof"
) {}
const compound = () =>
  Cause.fromReasons([
    Cause.makeFailReason(new Error("checked failure")).annotate(
      Context.make(Annotation, "checked")
    ),
    Cause.makeDieReason(new Error("cleanup defect")).annotate(
      Context.make(Annotation, "defect")
    ),
    Cause.makeInterruptReason(987).annotate(
      Context.make(Annotation, "interrupted")
    ),
  ])
function assertCause(result: unknown, original: Cause.Cause<unknown>) {
  expect(Cause.isCause(result)).toBe(true)
  if (!Cause.isCause(result)) throw new Error("Expected complete runner Cause")
  for (const reason of original.reasons) {
    const observed = result.reasons.find(
      (candidate) => candidate._tag === reason._tag
    )
    expect(observed?._tag).toBe(reason._tag)
    expect(observed?.annotations.get(Annotation.key)).toBe(
      reason.annotations.get(Annotation.key)
    )
    if (observed?._tag === "Fail" && reason._tag === "Fail")
      expect(observed.error).toBe(reason.error)
    if (observed?._tag === "Die" && reason._tag === "Die")
      expect(observed.defect).toBe(reason.defect)
    if (observed?._tag === "Interrupt" && reason._tag === "Interrupt")
      expect(observed.fiberId).toBe(reason.fiberId)
  }
}
function barrier<A>() {
  let resolve!: (value: A) => void, reject!: (error: unknown) => void
  const promise = new Promise<A>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function nativeJobs(runner: object) {
  const jobs = new Map<string, LifecycleJob>()
  const get = vi.fn((id: string) => jobs.get(id))
  const push = vi.fn(async (options: LifecycleJobPushOptions) => {
    const job = {
      ...options,
      createdAt: Date.now(),
      capability: "fixture",
      exclusive: false,
    } as LifecycleJob
    jobs.set(job.id, job)
    return job
  })
  const rearm = vi.fn(async () => {})
  const reschedule = vi.fn(async (id: string, time: number) => {
    const job = jobs.get(id)
    if (job) jobs.set(id, { ...job, time })
    return !!job
  })
  Object.assign(runner, {
    lifecycle: { jobs: { get, push, rearm, reschedule } },
  })
  return { jobs, get, push, rearm, reschedule }
}
function fixture(
  kind: "coordination" | "apps" | "email" | "whatsapp" | "background"
) {
  const work = { read: () => Effect.void as Effect.Effect<void, unknown> }
  const runner =
    kind === "coordination"
      ? new CoordinationRunner<unknown>({
          run: Effect.runPromise,
          restore: () => Effect.void,
          step: async () => undefined,
          exhaust: () => work.read(),
          nextWake: () => work.read().pipe(Effect.as(undefined)),
        })
      : kind === "apps"
        ? new AppEventRunner<unknown>({
            run: Effect.runPromise,
            pump: async () => undefined,
            exhaust: () => work.read(),
            next: () => Effect.succeed(undefined),
          })
        : kind === "background"
          ? new BackgroundRunner<unknown>({
              run: Effect.runPromise,
              step: async () => undefined,
              exhaust: () => work.read(),
              nextWake: () => Effect.succeed(undefined),
            })
          : new ReplyRunner<unknown>(kind, {
              run: Effect.runPromise,
              pump: async () => undefined,
              recover: () => work.read(),
              pending: () => Effect.succeed([]),
              exhaust: () => work.read(),
              nextRecovery: () => Effect.succeed(undefined),
            })
  owners.add(runner)
  return { runner, work, ...nativeJobs(runner) }
}

describe.each(["coordination", "apps", "email", "whatsapp"] as const)(
  "%s native Effect boundary",
  (kind) => {
    it("preserves a complete checked Effect failure during a queue read", async () => {
      const f = fixture(kind),
        original = compound()
      f.work.read = () => Effect.failCause(original)
      if (!("reconcile" in f.runner)) throw new Error("Expected reconciliation")
      const result = await f.runner.reconcile().catch((cause: unknown) => cause)
      assertCause(result, original)
    })
  }
)

function prearm(runner: ReturnType<typeof fixture>["runner"]) {
  if ("armDiscovery" in runner) return runner.armDiscovery()
  if ("armReply" in runner) return runner.armReply(Date.now() + 60_000)
  return runner.armBackground(Date.now() + 60_000)
}
const kinds = [
  "coordination",
  "apps",
  "email",
  "whatsapp",
  "background",
] as const
for (const kind of kinds) {
  it(`${kind} joins an accepted callback and refuses later work before storage`, async () => {
    const f = fixture(kind),
      entered = barrier<void>(),
      held = barrier<void>(),
      original = compound()
    await prearm(f.runner)
    await f.runner.wake()
    const callback = async () => {
      entered.resolve()
      await held.promise
      return undefined
    }
    if ("step" in f.runner.host) f.runner.host.step = callback
    else f.runner.host.pump = callback
    const job = [...f.jobs.values()].find((job) => job.fn === "pump")!
    const accepted = f.runner
      .onJob({ job, attempt: 1 })
      .catch((cause: unknown) => cause)
    await entered.promise
    let disposed = false
    const closing = f.runner
      .dispose()
      .catch((cause: unknown) => cause)
      .finally(() => {
        disposed = true
      })
    try {
      await expect(prearm(f.runner)).rejects.toThrow(/stopped|disposed/)
      expect(disposed).toBe(false)
      const reads = f.get.mock.calls.length,
        writes = f.push.mock.calls.length
      await f.runner.wake()
      if ("reconcile" in f.runner) await f.runner.reconcile()
      await f.runner.onJob({ job: {} as LifecycleJob, attempt: 1 })
      await f.runner.onJobError({ job: {} as LifecycleJob, attempt: 3 }, "late")
      expect(f.get).toHaveBeenCalledTimes(reads)
      expect(f.push).toHaveBeenCalledTimes(writes)
    } finally {
      held.reject(original)
    }
    for (const result of await Promise.all([accepted, closing]))
      assertCause(result, original)
  })

  it(`${kind} retains all failure reasons when exhaustion settles during close`, async () => {
    const f = fixture(kind),
      entered = barrier<void>(),
      held = barrier<void>(),
      original = compound()
    await prearm(f.runner)
    await f.runner.wake()
    const callback = async () => {
      throw new Error("native callback failed")
    }
    if ("step" in f.runner.host) f.runner.host.step = callback
    else f.runner.host.pump = callback
    const job = [...f.jobs.values()].find((job) => job.fn === "pump")!
    await expect(f.runner.onJob({ job, attempt: 3 })).rejects.toBeDefined()
    f.work.read = () =>
      Effect.gen(function* () {
        entered.resolve()
        yield* Effect.promise(() => held.promise)
        return yield* Effect.failCause(original)
      })
    const accepted = f.runner
      .onJobError({ job, attempt: 3 }, "exhausted")
      .catch((cause: unknown) => cause)
    await entered.promise
    let disposed = false
    const closing = f.runner
      .dispose()
      .catch((cause: unknown) => cause)
      .finally(() => {
        disposed = true
      })
    try {
      await expect(prearm(f.runner)).rejects.toThrow(/stopped|disposed/)
      expect(disposed).toBe(false)
    } finally {
      held.resolve()
    }
    for (const result of await Promise.all([accepted, closing]))
      assertCause(result, original)
  })
}

it.each(["coordination", "email", "whatsapp", "background"] as const)(
  "%s joins an accepted prearm but refuses its late acknowledgement",
  async (kind) => {
    const f = fixture(kind),
      entered = barrier<void>(),
      held = barrier<void>()
    const push = f.push.getMockImplementation()!
    f.push.mockImplementationOnce(async (options) => {
      entered.resolve()
      await held.promise
      return push(options)
    })
    const arm = prearm(f.runner).catch((cause: unknown) => cause)
    await entered.promise
    let disposed = false
    const closing = f.runner.dispose().finally(() => {
      disposed = true
    })
    try {
      await expect(prearm(f.runner)).rejects.toThrow(/stopped|disposed/)
      expect(disposed).toBe(false)
    } finally {
      held.resolve()
    }
    expect(await arm).toBeInstanceOf(Error)
    await closing
    expect(f.push).toHaveBeenCalledTimes(1)
  }
)
