import type { LifecycleJob, LifecycleJobPushOptions } from "agents/lifecycle"
import { Deferred, Effect } from "effect"
import { describe, expect, it, vi } from "vitest"

import { ReplyRunner } from "../src/replies/adapters/lifecycle"

vi.mock("agents/lifecycle", () => ({ LifecycleCapability: class {} }))

function fixture(channel: "email" | "whatsapp") {
  const jobs = new Map<string, LifecycleJob>()
  const committed: string[] = []
  const modes: boolean[] = []
  let readFailure = false
  let beforeTransaction: Effect.Effect<void> = Effect.void
  const runner = new ReplyRunner<never>(channel, {
    run: Effect.runPromise,
    pump: async () => undefined,
    recover: () => Effect.void,
    pending: () => Effect.succeed([]),
    nextRecovery: () => Effect.succeed(undefined),
    exhaust: (eligible, expiredOnly) =>
      Effect.gen(function* () {
        yield* beforeTransaction
        // The real stores perform this predicate and all row transitions in one
        // native transaction. Hold only before that transaction to model a busy DB.
        if (eligible()) {
          committed.push("exhausted")
          modes.push(expiredOnly)
        }
      }),
  })
  Object.defineProperty(runner, "lifecycle", {
    value: {
      jobs: {
        get: (id: string) => {
          if (readFailure) throw new Error("queue storage unavailable")
          return jobs.get(id)
        },
        rearm: vi.fn(async () => {}),
        push: async (options: LifecycleJobPushOptions) => {
          const job: LifecycleJob = {
            id: options.id!,
            capability: channel,
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
        },
      },
    },
  })
  return {
    runner,
    jobs,
    committed,
    modes,
    job: (fn: "pump" | "recover") =>
      jobs.get(`${channel}:${fn === "pump" ? "pump" : "reply-recovery"}`)!,
    faultReads: () => {
      readFailure = true
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

describe.each(["email", "whatsapp"] as const)(
  "%s reply job ownership",
  (channel) => {
    it("allows the current failed pump to terminalize its pending rows", async () => {
      const f = fixture(channel)
      await f.runner.armReply(Date.now() + 60_000)
      await f.runner.wake()
      await f.runner.onJobError({ job: f.job("pump"), attempt: 3 }, "failed")
      expect(f.committed).toEqual(["exhausted"])
      expect(f.modes).toEqual([false])
    })

    it("allows current discovery exhaustion after its old pump completes", async () => {
      const f = fixture(channel)
      await f.runner.wake()
      await f.runner.armReply(Date.now() + 60_000)
      const recovery = f.job("recover")
      f.jobs.delete(f.job("pump").id)
      await f.runner.onJobError({ job: recovery, attempt: 3 }, "failed")
      expect(f.committed).toEqual(["exhausted"])
    })

    it.each(["pump", "recover"] as const)(
      "rejects replacing an unsupported %s ownership format",
      async (fn) => {
        const f = fixture(channel)
        await f.runner.wake()
        await f.runner.armReply(Date.now() + 60_000)
        const current = f.job(fn)
        f.jobs.set(current.id, {
          ...current,
          payload: {
            ...(current.payload as object),
            owner: { version: 2, token: "future", peer: null },
          },
        })
        await expect(
          fn === "pump"
            ? f.runner.wake()
            : f.runner.armReply(Date.now() + 60_000)
        ).rejects.toThrow()
        expect(f.job(fn).payload).toMatchObject({ owner: { version: 2 } })
      }
    )

    it.each(["pump", "recover"] as const)(
      "rejects dispatch of an unsupported %s ownership format before work",
      async (fn) => {
        const f = fixture(channel)
        const pump = vi.spyOn(f.runner.host, "pump")
        const recover = vi.spyOn(f.runner.host, "recover")
        await f.runner.wake()
        await f.runner.armReply(Date.now() + 60_000)
        const current = f.job(fn)
        await expect(
          f.runner.onJob({
            attempt: 1,
            job: {
              ...current,
              payload: {
                ...(current.payload as object),
                owner: { version: 2, token: "future", peer: null },
              },
            },
          })
        ).rejects.toThrow()
        expect(pump).not.toHaveBeenCalled()
        expect(recover).not.toHaveBeenCalled()
        expect(f.committed).toEqual([])
      }
    )

    it.each(["pump", "recover"] as const)(
      "supports dispatch of a legacy ownerless %s job",
      async (fn) => {
        const f = fixture(channel)
        const pump = vi.spyOn(f.runner.host, "pump")
        const recover = vi.spyOn(f.runner.host, "recover")
        await f.runner.wake()
        await f.runner.armReply(Date.now() + 60_000)
        const current = f.job(fn)
        const payload = { ...(current.payload as Record<string, unknown>) }
        delete payload.owner
        await f.runner.onJob({ attempt: 1, job: { ...current, payload } })
        expect(pump).toHaveBeenCalledTimes(fn === "pump" ? 1 : 0)
        expect(recover).toHaveBeenCalledTimes(fn === "recover" ? 1 : 0)
      }
    )

    it.each(["pump", "recover"] as const)(
      "rejects an old %s callback after a same-ID push",
      async (fn) => {
        const f = fixture(channel)
        await f.runner.armReply(Date.now() + 60_000)
        await f.runner.wake()
        if (fn === "recover") await f.runner.armReply(Date.now() + 60_000)
        const old = f.job(fn)
        const held = f.holdTransaction()
        const failing = f.runner.onJobError({ job: old, attempt: 3 }, "failed")
        await held.entered()
        if (fn === "pump") await f.runner.wake()
        else await f.runner.armReply(Date.now() + 60_000)
        await held.release()
        await failing
        expect(f.committed).toEqual([])
        expect(f.job(fn).payload).not.toEqual(old.payload)
      }
    )

    it("preserves an admission prearmed while the old pump failure waits for storage", async () => {
      const f = fixture(channel)
      await f.runner.armReply(Date.now() + 60_000)
      await f.runner.wake()
      const old = f.job("pump")
      const held = f.holdTransaction()
      const failing = f.runner.onJobError({ job: old, attempt: 3 }, "failed")
      await held.entered()
      await f.runner.armReply(Date.now() + 60_000)
      // No new pump yet: receipt commit lies between prearm and immediate wake.
      expect(f.job("pump")).toBe(old)
      await held.release()
      await failing
      expect(f.committed).toEqual([])
    })

    it("preserves a new pump while an older discovery failure waits for storage", async () => {
      const f = fixture(channel)
      await f.runner.wake()
      await f.runner.armReply(Date.now() + 60_000)
      const held = f.holdTransaction()
      const failing = f.runner.onJobError(
        { job: f.job("recover"), attempt: 3 },
        "failed"
      )
      await held.entered()
      await f.runner.wake()
      await held.release()
      await failing
      expect(f.committed).toEqual([])
    })

    it("materializes orphan state only when both channel jobs are absent", async () => {
      const f = fixture(channel)
      await f.runner.armReply(Date.now() + 60_000)
      await f.runner.reconcile()
      expect(f.committed).toEqual([])
      f.jobs.delete(f.job("recover").id)
      await f.runner.wake()
      await f.runner.reconcile()
      expect(f.committed).toEqual([])
      f.jobs.clear()
      await f.runner.reconcile()
      expect(f.committed).toEqual(["exhausted"])
      expect(f.modes).toEqual([true])
    })

    it("re-reads job absence after acquiring the domain transaction", async () => {
      const f = fixture(channel)
      const held = f.holdTransaction()
      const reconciling = f.runner.reconcile()
      await held.entered()
      await f.runner.armReply(Date.now() + 60_000)
      await held.release()
      await reconciling
      expect(f.committed).toEqual([])
    })

    it("does not infer absence from a queue storage failure", async () => {
      const f = fixture(channel)
      f.faultReads()
      await expect(f.runner.reconcile()).rejects.toThrow(
        "queue storage unavailable"
      )
      expect(f.committed).toEqual([])
    })

    it("defers legacy untokened callback exhaustion to orphan reconciliation", async () => {
      const f = fixture(channel)
      await f.runner.wake()
      const legacy = { ...f.job("pump"), payload: undefined }
      f.jobs.set(legacy.id, legacy)
      await f.runner.onJobError({ job: legacy, attempt: 3 }, "failed")
      expect(f.committed).toEqual([])
      f.jobs.delete(legacy.id)
      await f.runner.reconcile()
      expect(f.committed).toEqual(["exhausted"])
    })
  }
)
