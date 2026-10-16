import { Cause, Context, Effect, Exit, ManagedRuntime, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import { executeCode } from "../src/execution/adapters/dynamic-worker"
import { executionRequest } from "../src/execution/adapters/http"
import { executionNativeOperation } from "../src/execution/adapters/interop"
import { readOutput } from "../src/execution/adapters/output"
import { ExecutionStore } from "../src/execution/adapters/sqlite"
import { CodeInput, ExecutionStorageError } from "../src/execution/contracts"
import { admitExecution } from "../src/execution/domain"
import {
  ExecutorUnavailable,
  type CodeExecutor,
} from "../src/execution/executor"
import { Executions, executionApplication } from "../src/execution/service"
import { database } from "./database"

const input = { id: "synthetic-run", code: "return input + 1", data: "2" }
const output = { result: "3", logs: "", error: null }
const run = Effect.runPromise
const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose()
})
function fixture(
  executor: CodeExecutor = { run: () => Effect.succeed(output) },
  db = database()
) {
  const repository = new ExecutionStore(db)
  let writable = true
  const runtime = ManagedRuntime.make(
    executionApplication(repository, executor, () =>
      Effect.sync(() => writable)
    )
  )
  const execution = runtime.runSync(Executions)
  disposals.push(() => runtime.dispose())
  return {
    repository,
    execution,
    runtime,
    db,
    archive: () => {
      writable = false
    },
  }
}
describe("Code execution", () => {
  it("persists admission before dispatch and reuses the same operation across retries", async () => {
    const invoke = vi.fn(() =>
      Effect.sync(() => {
        expect(Effect.runSync(f.repository.get(input.id))?.status).toBe(
          "running"
        )
        return output
      })
    )
    const f = fixture({ run: invoke })
    const first = await run(f.execution.start(input))
    await run(first.completion)
    const replay = await run(f.execution.start(input))
    expect((await run(replay.completion)).status).toBe("succeeded")
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(await run(f.execution.list())).toEqual([
      expect.objectContaining({ id: input.id, status: "succeeded" }),
    ])
    expect(Effect.runSync(f.repository.list())[0]).not.toHaveProperty("input")
    await expect(
      run(f.execution.start({ ...input, data: "3" }))
    ).rejects.toThrow("different code")
  })
  it("durably cancels, aborts the driver, joins settlement and rejects its late result", async () => {
    let finish!: (value: typeof output) => void
    let signal!: AbortSignal
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    const f = fixture({
      run: () =>
        executionNativeOperation((current) => {
          signal = current
          entered()
          return new Promise((resolve) => {
            finish = resolve
          })
        }),
    })
    const started = await run(f.execution.start(input))
    await enteredPromise
    const replay = await run(f.execution.start(input))
    await expect(
      run(f.execution.start({ ...input, id: "second" }))
    ).rejects.toThrow("current run")
    let settled = false
    const cancelled = run(f.execution.cancel(input.id)).then((value) => {
      settled = true
      return value
    })
    expect(Effect.runSync(f.repository.get(input.id))?.status).toBe("cancelled")
    expect(signal.aborted).toBe(true)
    expect(settled).toBe(false)
    await expect(
      run(f.execution.start({ ...input, id: "second" }))
    ).rejects.toThrow("current run")
    finish(output)
    expect((await cancelled).status).toBe("cancelled")
    expect((await run(started.completion)).status).toBe("cancelled")
    expect((await run(replay.completion)).status).toBe("cancelled")
    expect(Effect.runSync(f.repository.get(input.id))?.output).toBeNull()
  })
  it("honors an immediate stop before dispatch", async () => {
    const invoke = vi.fn(() => Effect.succeed(output))
    const f = fixture({ run: invoke })
    const controller = new AbortController()
    const pending = run(f.execution.run(input), { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(Effect.runSync(f.repository.get(input.id))).toBeUndefined()
    expect(invoke).not.toHaveBeenCalled()
  })
  it("rejects already stopped requests and archive before dispatch", async () => {
    const invoke = vi.fn(() => Effect.succeed(output))
    const f = fixture({ run: invoke })
    await expect(
      run(f.execution.run(input), { signal: AbortSignal.abort() })
    ).rejects.toThrow()
    expect(Effect.runSync(f.repository.get(input.id))).toBeUndefined()
    const pending = run(f.execution.start(input))
    f.archive()
    expect((await run((await pending).completion)).status).toBe("cancelled")
    expect(invoke).not.toHaveBeenCalled()
  })
  it("marks interrupted intents after restart without re-executing them", async () => {
    const f = fixture()
    const admitted = admitExecution(
      input,
      undefined,
      { total: 0, running: 0 },
      true,
      false,
      1
    )
    if (admitted._tag === "Failure") throw admitted.failure
    Effect.runSync(f.repository.put(admitted.success.run))
    // A new application sees a committed intent with no live fiber.
    const invoke = vi.fn(() => Effect.succeed(output))
    const runtime = ManagedRuntime.make(
      executionApplication(f.repository, { run: invoke }, () =>
        Effect.sync(() => true)
      )
    )
    disposals.push(() => runtime.dispose())
    const restored = runtime.runSync(Executions)
    await run(restored.recover())
    expect(
      (await run((await run(restored.start(input))).completion)).status
    ).toBe("interrupted")
    expect(Effect.runSync(f.repository.get(input.id))?.status).toBe(
      "interrupted"
    )
    expect(invoke).not.toHaveBeenCalled()
  })
  it("rejects archived admission but preserves read/replay of completed runs", async () => {
    const f = fixture()
    await run((await run(f.execution.start(input))).completion)
    f.archive()
    await expect(
      run(f.execution.start({ ...input, id: "second" }))
    ).rejects.toThrow("Restore")
    expect((await run(f.execution.start(input))).run.status).toBe("succeeded")
  })
  it("bounds and redacts malformed or oversized executor results", async () => {
    const f = fixture({
      run: () => Effect.succeed({ ...output, result: "x".repeat(32769) }),
    })
    const saved = await run((await run(f.execution.start(input))).completion)
    expect(saved.status).toBe("failed")
    expect(saved.output?.result).toBe("")
    expect(saved.output?.error).toContain("limit")
    expect(() =>
      Schema.decodeUnknownSync(CodeInput)({ ...input, data: "invalid" })
    ).toThrow()
  })
  it("keeps bot run history isolated and rejects oversized HTTP requests", async () => {
    const a = fixture(),
      b = fixture()
    const tasks: Promise<unknown>[] = []
    const submit = (body: string) =>
      run(
        executionRequest(
          a.execution,
          new Request("https://app.test/execution/run", {
            method: "POST",
            body,
          }),
          "execution/run",
          (task) => {
            tasks.push(a.runtime.runPromise(task))
          }
        )
      )
    expect((await submit(JSON.stringify(input))).status).toBe(202)
    await Promise.all(tasks)
    expect(Effect.runSync(b.repository.get(input.id))).toBeUndefined()
    expect((await submit("x".repeat(256001))).status).toBe(409)
  })
  it("inherits the invocation Context rather than the Layer's build Context", async () => {
    const Caller = Context.Reference("execution-test/Caller", {
      defaultValue: () => "default",
    })
    const f = fixture({
      run: () =>
        Caller.pipe(Effect.map((value) => ({ ...output, result: value }))),
    })
    const task = await run(
      f.execution.start(input).pipe(Effect.provideService(Caller, "caller"))
    )
    expect((await run(task.completion)).output?.result).toBe("caller")
  })
  it("seals an owned interrupted run and joins its driver before Layer disposal", async () => {
    let entered!: () => void, finish!: (value: typeof output) => void
    const begun = new Promise<void>((resolve) => {
      entered = resolve
    })
    let signal!: AbortSignal
    const f = fixture({
      run: () =>
        executionNativeOperation((current) => {
          signal = current
          entered()
          return new Promise((resolve) => {
            finish = resolve
          })
        }),
    })
    await run(f.execution.start(input))
    await begun
    let disposed = false
    const closing = f.runtime.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(signal.aborted).toBe(true)
    expect(disposed).toBe(false)
    finish(output)
    await closing
    expect(Effect.runSync(f.repository.get(input.id))?.status).toBe(
      "interrupted"
    )
    expect(Effect.runSync(f.repository.get(input.id))?.output).toBeNull()
  })
  it("keeps executor defects fatal and the persisted intent uncertain", async () => {
    const defect = new Error("executor invariant")
    const f = fixture({ run: () => Effect.die(defect) })
    const task = await run(f.execution.start(input))
    const exit = await Effect.runPromiseExit(task.completion)
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    expect(Effect.runSync(f.repository.get(input.id))?.status).toBe("running")
    await expect(
      run(f.execution.start({ ...input, id: "second" }))
    ).rejects.toThrow("executor invariant")
    await expect(f.runtime.dispose()).rejects.toThrow("executor invariant")
    disposals.pop()
  })
  it("does not turn typed failure plus failed cleanup into a saved ordinary failure", async () => {
    const defect = new Error("failed executor cleanup")
    const f = fixture({
      run: () =>
        Effect.fail(new ExecutorUnavailable()).pipe(
          Effect.ensuring(Effect.die(defect))
        ),
    })
    const task = await run(f.execution.start(input))
    const exit = await Effect.runPromiseExit(task.completion)
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    expect(Effect.runSync(f.repository.get(input.id))?.status).toBe("running")
    const disposal = await Effect.runPromiseExit(f.runtime.disposeEffect)
    expect(
      Exit.isFailure(disposal) &&
        disposal.cause.reasons.some(
          (reason) => reason._tag === "Die" && reason.defect === defect
        )
    ).toBe(true)
    disposals.pop()
  })
  it("reports native storage failures while corrupted persisted records remain defects", async () => {
    const db = database(),
      f = fixture(undefined, db)
    db.run("INSERT INTO code_runs VALUES (?,?,?)", "broken", 1, "{}")
    const corrupt = await Effect.runPromiseExit(f.execution.get("broken"))
    expect(Exit.isFailure(corrupt) && Cause.hasDies(corrupt.cause)).toBe(true)
    db.run("DROP TABLE code_runs")
    const unavailable = await run(
      f.execution.get("missing").pipe(Effect.result)
    )
    expect(unavailable).toEqual(
      expect.objectContaining({ failure: new ExecutionStorageError() })
    )
  })
  it("provides no bindings/network and sets CPU/subrequest bounds at the isolation boundary", async () => {
    const load = vi.fn(() => ({
      getEntrypoint: () => ({ fetch: async () => Response.json(output) }),
    }))
    expect(await run(executeCode({ load }, input))).toEqual(output)
    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {},
        globalOutbound: null,
        limits: { cpuMs: 1000, subRequests: 0 },
      })
    )
  })
  it("bounds untrusted responses independently of generated wrapper code", async () => {
    await expect(
      run(
        readOutput(Response.redirect("https://execution.internal/again", 307))
      )
    ).rejects.toThrow()
    await expect(
      run(readOutput(new Response("x".repeat(200001))))
    ).rejects.toThrow()
    await expect(
      run(readOutput(Response.json({ ...output, logs: "x".repeat(16001) })))
    ).rejects.toThrow()
  })
  it("never follows generated redirects into a second invocation", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.redirect).toBe("manual")
      return Response.redirect("https://execution.internal/again", 307)
    })
    const loader = { load: () => ({ getEntrypoint: () => ({ fetch }) }) }
    await expect(run(executeCode(loader, input))).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it("aborts body consumption when cancellation arrives after response headers", async () => {
    const cancelled = vi.fn()
    const controller = new AbortController()
    const response = new Response(new ReadableStream({ cancel: cancelled }))
    const pending = run(readOutput(response), { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(cancelled).toHaveBeenCalledTimes(1)
  })
})
