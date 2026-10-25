import { EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, ManagedRuntime, Scheduler, Schema } from "effect"
import { describe, expect, it, vi } from "vitest"

import { executionNativeOperation } from "../src/execution/adapters/interop"
import { ExecutionStore } from "../src/execution/adapters/sqlite"
import { CodeRun } from "../src/execution/contracts"
import {
  ExecutorUnavailable,
  type CodeExecutor,
} from "../src/execution/executor"
import { executionHostMachine } from "../src/execution/host.machine"
import {
  advanceExecutionRecord,
  newExecutionRecord,
  restoreExecutionRecord,
} from "../src/execution/run.machine"
import {
  Executions,
  executionApplication,
  makeExecutions,
} from "../src/execution/service"
import { database } from "./database"

function barrier<A = void>() {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const input = { id: "first", code: "return 3", data: "null" }
const output = { result: "3", logs: "", error: null }
const run = Effect.runPromise

it("rejects an admission queued behind SQLite when its host closes before the transaction begins", async () => {
  const db = database(),
    store = new ExecutionStore(db)
  const locked = barrier(),
    release = barrier(),
    admitting = barrier()
  const atomic = store.atomic.bind(store)
  store.atomic = (body) => {
    admitting.resolve()
    return atomic(body)
  }
  const invoke = vi.fn(() => Effect.succeed(output))
  const runtime = ManagedRuntime.make(
    executionApplication(store, { run: invoke }, () => Effect.succeed(true))
  )
  const service = runtime.runSync(Executions)
  const holding = run(
    db.transaction(() =>
      Effect.sync(() => locked.resolve()).pipe(
        Effect.andThen(Effect.promise(() => release.promise))
      )
    )
  )
  await locked.promise
  const pending = run(service.start(input)).then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )
  await admitting.promise
  const closing = runtime.dispose()
  await new Promise<void>((resolve) => setImmediate(resolve))
  release.resolve()
  await holding
  await closing
  expect(await pending).toMatchObject({
    error: expect.objectContaining({
      message: expect.stringContaining("stopped"),
    }),
  })
  expect(Effect.runSync(store.get(input.id))).toBeUndefined()
  expect(invoke).not.toHaveBeenCalled()
})

function host(store: ExecutionStore, executor: CodeExecutor) {
  const runtime = ManagedRuntime.make(
    executionApplication(store, executor, () => Effect.succeed(true))
  )
  return { runtime, service: runtime.runSync(Executions) }
}

describe.each([128, 32])(
  "execution atomic claimant at scheduler budget %i",
  (budget) => {
    it.each([false, true])(
      "dispatches only the fresh database claimant across two hosts (held=%s)",
      async (held) => {
        const db = database(),
          store = new ExecutionStore(db)
        const entered = barrier(),
          finish = barrier<typeof output>(),
          locked = barrier(),
          release = barrier()
        const invoke = vi.fn(() =>
          executionNativeOperation(() => {
            entered.resolve()
            return finish.promise
          })
        )
        const a = host(store, { run: invoke }),
          b = host(store, { run: invoke })
        const execute = <A, E>(effect: Effect.Effect<A, E>) =>
          run(
            effect.pipe(
              Effect.provideService(Scheduler.MaxOpsBeforeYield, budget)
            )
          )
        const holding = held
          ? execute(
              db.transaction(() =>
                Effect.sync(() => locked.resolve()).pipe(
                  Effect.andThen(Effect.promise(() => release.promise))
                )
              )
            )
          : Promise.resolve()
        if (held) await locked.promise
        const first = execute(a.service.start(input)),
          second = execute(b.service.start(input))
        release.resolve()
        await holding
        const tasks = await Promise.all([first, second])
        await entered.promise
        expect(invoke).toHaveBeenCalledOnce()
        expect(tasks[0]!.run).toEqual(tasks[1]!.run)
        expect(tasks[0]!.run).toEqual(
          Schema.decodeUnknownSync(CodeRun)(tasks[0]!.run)
        )
        expect(Effect.runSync(store.counts())).toEqual({ total: 1, running: 1 })
        finish.resolve(output)
        await Promise.all(tasks.map((task) => execute(task.completion)))
        expect(Effect.runSync(store.get(input.id))).toMatchObject({
          status: "succeeded",
          revision: 2,
          occupancy: { state: "free", ownerId: null },
        })
        await Promise.all([a.runtime.dispose(), b.runtime.dispose()])
      }
    )
  }
)

it("retains cancelled occupancy across hosts until the owning driver's finalizer has joined", async () => {
  const store = new ExecutionStore(database()),
    entered = barrier(),
    cleaning = barrier(),
    release = barrier()
  const a = host(store, {
    run: () =>
      Effect.sync(() => entered.resolve()).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.promise(() => {
            cleaning.resolve()
            return release.promise
          })
        )
      ),
  })
  const invoke = vi.fn(() => Effect.succeed(output))
  const b = host(store, { run: invoke })
  const task = await run(a.service.start(input))
  await entered.promise
  let settled = false
  const cancellation = run(a.service.cancel(input.id)).then((value) => {
    settled = true
    return value
  })
  await cleaning.promise
  expect(settled).toBe(false)
  expect(Effect.runSync(store.get(input.id))).toMatchObject({
    status: "cancelled",
    output: null,
    occupancy: { state: "held" },
  })
  expect(Effect.runSync(store.counts()).running).toBe(1)
  await expect(
    run(b.service.start({ ...input, id: "second" }))
  ).rejects.toThrow("current run")
  expect(invoke).not.toHaveBeenCalled()
  release.resolve()
  expect((await cancellation).status).toBe("cancelled")
  expect((await run(task.completion)).status).toBe("cancelled")
  expect(Effect.runSync(store.counts()).running).toBe(0)
  expect((await run(b.service.run({ ...input, id: "second" }))).status).toBe(
    "succeeded"
  )
  await Promise.all([a.runtime.dispose(), b.runtime.dispose()])
})

it("closes admission before joining held cleanup and preserves both late failure reasons", async () => {
  const store = new ExecutionStore(database()),
    entered = barrier(),
    cleaning = barrier(),
    release = barrier()
  const unavailable = new ExecutorUnavailable(),
    defect = new Error("late execution invariant")
  const compound = Cause.fromReasons([
    Cause.makeFailReason(unavailable),
    Cause.makeDieReason(defect),
  ])
  const a = host(store, {
    run: () =>
      executionNativeOperation((signal) => {
        entered.resolve()
        signal.addEventListener("abort", () => cleaning.resolve(), {
          once: true,
        })
        return release.promise.then(() => {
          throw compound
        })
      }),
  })
  const task = await run(a.service.start(input))
  await entered.promise
  let disposed = false
  const closing = Effect.runPromiseExit(a.runtime.disposeEffect).then(
    (exit) => {
      disposed = true
      return exit
    }
  )
  await cleaning.promise
  expect(disposed).toBe(false)
  await expect(run(a.service.start(input))).rejects.toThrow("stopped")
  expect(Effect.runSync(store.get(input.id))?.occupancy.state).toBe("held")
  release.resolve()
  const [exit, disposal] = await Promise.all([
    Effect.runPromiseExit(task.completion),
    closing,
  ])
  const outcomes: ReadonlyArray<Exit.Exit<unknown, unknown>> = [exit, disposal]
  for (const result of outcomes) {
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(result.cause.reasons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ _tag: "Die", defect }),
          expect.objectContaining({
            _tag: "Die",
            defect: expect.objectContaining({
              _tag: "Fail",
              error: unavailable,
            }),
          }),
        ])
      )
    }
  }
  expect(Effect.runSync(store.get(input.id))).toMatchObject({
    status: "interrupted",
    output: null,
    occupancy: { state: "blocked" },
  })
})

it("fences stale results, revisions and releases and restores JSON without replaying entry work", () => {
  const current = newExecutionRecord(input, true, false, 0, 10, "attempt-1")
  expect(restoreExecutionRecord(JSON.parse(JSON.stringify(current)))).toEqual(
    current
  )
  for (const event of [
    { type: "FINISH", attemptId: "old", revision: 0, output, now: 20 },
    { type: "FINISH", attemptId: "attempt-1", revision: 3, output, now: 20 },
    { type: "RELEASE", attemptId: "old", confirmed: true },
  ] as const)
    expect(advanceExecutionRecord(current, event)).toEqual(current)
  const stopped = advanceExecutionRecord(current, {
    type: "CANCEL",
    attemptId: "attempt-1",
    revision: 0,
    now: 20,
  })
  expect(
    advanceExecutionRecord(stopped, {
      type: "FINISH",
      attemptId: "attempt-1",
      revision: 0,
      output,
      now: 21,
    })
  ).toEqual(stopped)
  const recovered = advanceExecutionRecord(stopped, {
    type: "RECOVER",
    now: 30,
  })
  expect(
    advanceExecutionRecord(recovered, {
      type: "RELEASE",
      attemptId: "attempt-1",
      confirmed: false,
    })
  ).toEqual(recovered)
  for (const invalid of [
    { ...current, schemaVersion: 2 },
    { ...current, workflowVersion: 2 },
    { ...current, status: "unknown" },
    { ...Schema.decodeUnknownSync(CodeRun)(current), schemaVersion: 1 },
  ])
    expect(() => restoreExecutionRecord(invalid)).toThrow()
  expect(() =>
    advanceExecutionRecord(current, {
      type: "FINISH",
      attemptId: 2,
      revision: 0,
      output,
      now: 20,
    } as never)
  ).toThrow("Unsupported execution run effect")
})

it("seals legacy and cancelled occupied records after restart without executing unknown code", async () => {
  const db = database(),
    store = new ExecutionStore(db)
  const legacy = {
    ...Schema.decodeUnknownSync(CodeRun)(
      newExecutionRecord(input, true, false, 0, 10, "discarded")
    ),
    output: { ...output, logs: "old diagnostic" },
  }
  db.run(
    "INSERT INTO code_runs VALUES (?,?,?)",
    input.id,
    10,
    JSON.stringify(legacy)
  )
  const cancelled = advanceExecutionRecord(
    newExecutionRecord(
      { ...input, id: "cancelled" },
      true,
      false,
      0,
      11,
      "cancelled-owner"
    ),
    { type: "CANCEL", attemptId: "cancelled-owner", revision: 0, now: 12 }
  )
  Effect.runSync(store.put(cancelled))
  const invoke = vi.fn(() => Effect.succeed(output)),
    a = host(store, { run: invoke })
  expect(Effect.runSync(store.get(input.id))).toMatchObject({
    id: input.id,
    createdAt: 10,
    attemptId: `legacy:${input.id}`,
    occupancy: { state: "held" },
  })
  await run(a.service.recover())
  expect((await run(a.service.run(input))).status).toBe("interrupted")
  expect(Effect.runSync(store.get("cancelled"))).toMatchObject({
    status: "cancelled",
    finishedAt: 12,
    occupancy: { state: "free" },
  })
  const stored = JSON.parse(
    db.all<{ record: string }>(
      "SELECT record FROM code_runs WHERE id=?",
      input.id
    )[0]!.record
  )
  expect(stored).toMatchObject({
    schemaVersion: 1,
    workflowVersion: 1,
    attemptId: `legacy:${input.id}`,
    status: "interrupted",
    createdAt: 10,
    occupancy: { state: "free" },
  })
  expect(invoke).not.toHaveBeenCalled()
  await a.runtime.dispose()
})

it.each(["archive", "cancel", "recover"] as const)(
  "rechecks %s after the authorizing actor settles and before native dispatch",
  async (change) => {
    const store = new ExecutionStore(database())
    let allowed = true,
      checks = 0,
      changed = false
    const invoke = vi.fn(() => Effect.succeed(output))
    const runtime = ManagedRuntime.make(
      executionApplication(store, { run: invoke }, () =>
        Effect.sync(() => {
          checks++
          if (checks === 2)
            queueMicrotask(() => {
              changed = true
              if (change === "archive") allowed = false
              else
                Effect.runSync(
                  store.atomic(() =>
                    Effect.gen(function* () {
                      const current = (yield* store.get(input.id))!
                      yield* store.put(
                        advanceExecutionRecord(
                          current,
                          change === "cancel"
                            ? {
                                type: "CANCEL",
                                attemptId: current.attemptId,
                                revision: current.revision,
                                now: 21,
                              }
                            : { type: "RECOVER", now: 21 }
                        )
                      )
                    })
                  )
                )
            })
          return allowed
        })
      )
    )
    const execution = runtime.runSync(Executions)
    const result = await run(execution.run(input))
    expect(changed).toBe(true)
    expect(invoke).not.toHaveBeenCalled()
    expect(result.status).toBe(
      change === "recover" ? "interrupted" : "cancelled"
    )
    expect(Effect.runSync(store.get(input.id))).toMatchObject({
      output: null,
      occupancy: { state: "free", ownerId: null },
    })
    await runtime.dispose()
  }
)

it("joins the host actor when direct factory initialization is interrupted before returning", async () => {
  const controller = new AbortController()
  const original =
    executionHostMachine.initialTransition.bind(executionHostMachine)
  let created = 0
  const initial = vi
    .spyOn(executionHostMachine, "initialTransition")
    .mockImplementation((...args) => {
      const snapshot = original(...args)
      created++
      queueMicrotask(() => controller.abort())
      return snapshot
    })
  const stopped = vi.spyOn(EffectActor.prototype, "stop")
  try {
    const exit = await Effect.runPromiseExit(
      makeExecutions(
        new ExecutionStore(database()),
        { run: () => Effect.never },
        () => Effect.succeed(true)
      ).pipe(
        Effect.scoped,
        Effect.provideService(Scheduler.MaxOpsBeforeYield, 32)
      ),
      { signal: controller.signal }
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(created).toBe(1)
    expect(stopped).toHaveBeenCalledOnce()
  } finally {
    initial.mockRestore()
    stopped.mockRestore()
  }
})
