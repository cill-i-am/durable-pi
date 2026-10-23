import { Clock, Effect } from "effect"
import { expect, it, vi } from "vitest"

import { CoordinationRunner } from "../src/coordination/adapters/lifecycle"
import { admitCoordination } from "../src/coordination/admission"
import {
  armCoordinationDiscovery,
  observeCoordinationDiscovery,
  readCoordinationDiscovery,
} from "../src/coordination/discovery.machine"
import { advanceSession } from "../src/coordination/session.machine"

vi.mock("agents/lifecycle", () => ({ LifecycleCapability: class {} }))
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
it("retains an empty discovery scan, preserves the longest lease, and rejects a future format", () => {
  const armed = armCoordinationDiscovery(undefined, 1000, 61000, "first")
  expect(
    observeCoordinationDiscovery(armed, 1000, { now: 1001, next: null })
  ).toEqual([{ type: "reschedule", at: 61000 }])
  const newer = armCoordinationDiscovery(armed, 1000, 2000, "newer")
  expect(newer).toMatchObject({ token: "newer", armedUntil: 61000 })
  expect(
    observeCoordinationDiscovery(newer, 1000, { now: 61000, next: null })
  ).toEqual([])
  expect(() =>
    readCoordinationDiscovery({ ...armed, workflowVersion: 2 }, 1000)
  ).toThrow()
  expect(() => armCoordinationDiscovery(armed, 1000, 2000, "")).toThrow()
  expect(() =>
    observeCoordinationDiscovery(armed, 1000, { now: -1, next: null })
  ).toThrow()
})
it("prearms before acceptance and does not accept when durable discovery fails", async () => {
  const order: string[] = []
  expect(
    await Effect.runPromise(
      admitCoordination({
        arm: Effect.sync(() => {
          order.push("arm")
          return 61000
        }),
        accept: (deadline) =>
          Effect.sync(() => {
            expect(deadline).toBe(61000)
            order.push("accept")
            return "receipt"
          }),
        wake: Effect.sync(() => {
          order.push("wake")
        }),
      })
    )
  ).toBe("receipt")
  expect(order).toEqual(["arm", "accept", "wake"])
  const refused = await Effect.runPromise(
    admitCoordination({
      arm: Effect.fail("unavailable"),
      accept: () => Effect.die("Must not accept without discovery"),
      wake: Effect.die("Must not wake after refusal"),
    }).pipe(Effect.result)
  )
  expect(refused).toMatchObject({ _tag: "Failure", failure: "unavailable" })
})
it("closes the request-owned admission scope only after invoked cleanup joins", async () => {
  const entered = deferred(),
    cleaning = deferred(),
    release = deferred()
  const abort = new AbortController()
  let finished = false
  const result = Effect.runPromiseExit(
    admitCoordination({
      arm: Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            cleaning.resolve()
            await release.promise
          })
        )
        entered.resolve()
        return yield* Effect.never
      }).pipe(Effect.scoped),
      accept: () => Effect.die("Cancelled arming must not accept"),
      wake: Effect.void,
    }),
    { signal: abort.signal }
  ).then((exit) => {
    finished = true
    return exit
  })
  await entered.promise
  abort.abort()
  await cleaning.promise
  expect(finished).toBe(false)
  release.resolve()
  await result
  expect(finished).toBe(true)
})
it("keeps session closure and the twelve-request continuation budget authoritative", () => {
  let value = { closed: false, requests: 0 }
  for (let n = 0; n < 12; n++)
    value = advanceSession(value, { type: "REQUEST" })!
  expect(advanceSession(value, { type: "REQUEST" })).toBeUndefined()
  value = advanceSession(value, { type: "CLOSE" })!
  expect(value).toEqual({ closed: true, requests: 12 })
  expect(advanceSession(value, { type: "REQUEST" })).toBeUndefined()
})
it("does not let a replaced job steal a warm dispatch or delete newer discovery", async () => {
  const entered = deferred(),
    release = deferred()
  let steps = 0,
    restores = 0,
    exhausted = 0
  const jobs = new Map<string, unknown>()
  const runner = new CoordinationRunner({
    run: Effect.runPromise,
    step: async () => {
      steps++
      entered.resolve()
      await release.promise
      return undefined
    },
    restore: () =>
      Effect.sync(() => {
        restores++
      }),
    exhaust: () =>
      Effect.sync(() => {
        exhausted++
      }),
    nextWake: () => Effect.succeed(undefined),
  })
  Object.assign(runner, {
    lifecycle: {
      jobs: {
        get: (id: string) => jobs.get(id),
        push: async (job: { id: string }) => {
          jobs.set(job.id, job)
        },
        rearm: async () => {},
      },
    },
  })
  await runner.armDiscovery()
  const original = jobs.get("agent-coordination:pump") as never
  const first = runner.onJob({ job: original } as never)
  await entered.promise
  const hungReplacement = { ...(original as object) }
  await runner.onJob({ job: hungReplacement } as never)
  const retained = await runner.onJobError(
    { job: hungReplacement } as never,
    new Error("Replacement exhausted")
  )
  expect(retained).toMatchObject({ rescheduleAt: expect.any(Number) })
  expect(exhausted).toBe(0)
  expect(steps).toBe(1)
  await runner.armDiscovery()
  const replacement = jobs.get("agent-coordination:pump") as { time: number }
  await runner.onJob({ job: replacement } as never)
  expect(steps).toBe(1)
  release.resolve()
  expect(await first).toEqual({ rescheduleAt: replacement.time })
  expect(restores).toBe(1)
})

it.each(["restore", "clock", "step"] as const)(
  "retains discovery and records exhausted recovery after %s failure",
  async (stage) => {
    let steps = 0,
      exhausted = 0,
      clocks = 0
    const jobs = new Map<string, unknown>()
    const runner = new CoordinationRunner({
      run: <A>(work: Effect.Effect<A, string>) => {
        if (
          Object.is(work, Clock.currentTimeMillis) &&
          stage === "clock" &&
          clocks++ < 3
        )
          return Promise.reject(new Error("Clock read unavailable"))
        return Effect.runPromise(work)
      },
      restore: () =>
        stage === "restore" ? Effect.fail("Restore unavailable") : Effect.void,
      step: async () => {
        steps++
        throw new Error("Failed after dispatch claim")
      },
      exhaust: (current) =>
        Effect.sync(() => {
          expect(current()).toBe(true)
          exhausted++
        }),
      nextWake: () => Effect.succeed(undefined),
    })
    Object.assign(runner, {
      lifecycle: {
        jobs: {
          get: (id: string) => jobs.get(id),
          push: async (job: { id: string }) => {
            jobs.set(job.id, job)
          },
          rearm: async () => {},
        },
      },
    })
    const deadline = await runner.armDiscovery()
    const job = jobs.get("agent-coordination:pump") as never
    for (let n = 0; n < 3; n++)
      await expect(runner.onJob({ job } as never)).rejects.toBeDefined()
    const result = await runner.onJobError(
      { job } as never,
      new Error("SDK retry exhausted")
    )
    expect(exhausted).toBe(1)
    expect(steps).toBe(stage === "step" ? 3 : 0)
    expect(result).toEqual({ rescheduleAt: deadline })
  }
)
