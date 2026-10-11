import { Effect, Schema } from "effect"
import { describe, expect, it, vi } from "vitest"
import { database } from "./database"
import { Executions, type CodeExecutor } from "../src/execution/execution"
import { ExecutionStore } from "../src/execution/adapters/sqlite"
import { CodeInput } from "../src/execution/contracts"
import { executionRequest } from "../src/execution/http"
import {
  executeCode,
  readOutput,
} from "../src/execution/adapters/dynamic-worker"

const input = { id: "synthetic-run", code: "return input + 1", data: "2" }
const output = { result: "3", logs: "", error: null }
const run = Effect.runPromise
function fixture(executor: CodeExecutor = { run: async () => output }) {
  const repository = new ExecutionStore(database())
  let writable = true
  const execution = new Executions(repository, executor, () => writable)
  return {
    repository,
    execution,
    archive: () => {
      writable = false
    },
  }
}
describe("Code execution", () => {
  it("persists admission before dispatch and reuses the same operation across retries", async () => {
    const invoke = vi.fn(async () => {
      expect(f.repository.get(input.id)?.status).toBe("running")
      return output
    })
    const f = fixture({ run: invoke })
    const first = await run(f.execution.start(input))
    await first.completion
    const replay = await run(f.execution.start(input))
    expect((await replay.completion).status).toBe("succeeded")
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(f.repository.list()).toEqual([
      expect.objectContaining({ id: input.id, status: "succeeded" }),
    ])
    expect(f.repository.list()[0]).not.toHaveProperty("input")
    await expect(
      run(f.execution.start({ ...input, data: "3" }))
    ).rejects.toThrow("different code")
  })
  it("durably cancels, aborts the driver and rejects its late result", async () => {
    let finish!: (value: typeof output) => void
    let signal!: AbortSignal
    const f = fixture({
      run: async (_input, current) => {
        signal = current
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    })
    const started = await run(f.execution.start(input))
    await expect(
      run(f.execution.start({ ...input, id: "second" }))
    ).rejects.toThrow("current run")
    await run(f.execution.cancel(input.id))
    expect(signal.aborted).toBe(true)
    finish(output)
    expect((await started.completion).status).toBe("cancelled")
    expect(f.repository.get(input.id)?.output).toBeNull()
  })
  it("honors an immediate stop before dispatch", async () => {
    const invoke = vi.fn(async () => output)
    const f = fixture({ run: invoke })
    const controller = new AbortController()
    const pending = f.execution.run(input, controller.signal)
    controller.abort()
    expect((await pending).status).toBe("cancelled")
    expect(invoke).not.toHaveBeenCalled()
  })
  it("rejects already stopped requests and archive before dispatch", async () => {
    const invoke = vi.fn(async () => output)
    const f = fixture({ run: invoke })
    await expect(f.execution.run(input, AbortSignal.abort())).rejects.toThrow(
      "stopped"
    )
    expect(f.repository.get(input.id)).toBeUndefined()
    const pending = f.execution.run(input)
    f.archive()
    expect((await pending).status).toBe("cancelled")
    expect(invoke).not.toHaveBeenCalled()
  })
  it("marks interrupted intents after restart without re-executing them", async () => {
    const f = fixture()
    f.repository.admit(input)
    const invoke = vi.fn(async () => output)
    const restored = new Executions(f.repository, { run: invoke }, () => true)
    restored.recover()
    expect((await (await run(restored.start(input))).completion).status).toBe(
      "interrupted"
    )
    expect(invoke).not.toHaveBeenCalled()
  })
  it("rejects archived admission but preserves read/replay of completed runs", async () => {
    const f = fixture()
    await (
      await run(f.execution.start(input))
    ).completion
    f.archive()
    await expect(
      run(f.execution.start({ ...input, id: "second" }))
    ).rejects.toThrow("Restore")
    expect((await run(f.execution.start(input))).run.status).toBe("succeeded")
  })
  it("bounds and redacts malformed or oversized executor results", async () => {
    const f = fixture({
      run: async () => ({ ...output, result: "x".repeat(32769) }),
    })
    const saved = await (await run(f.execution.start(input))).completion
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
    const result = await run(
      executionRequest(
        a.execution,
        new Request("https://app.test/execution/run", {
          method: "POST",
          body: JSON.stringify(input),
        }),
        "execution/run",
        (task) => tasks.push(task)
      )
    )
    expect(result.status).toBe(202)
    await Promise.all(tasks)
    expect(b.repository.get(input.id)).toBeUndefined()
    const oversized = await run(
      executionRequest(
        a.execution,
        new Request("https://app.test/execution/run", {
          method: "POST",
          body: "x".repeat(256001),
        }),
        "execution/run",
        (task) => tasks.push(task)
      )
    )
    expect(oversized.status).toBe(409)
  })
  it("provides no bindings/network and sets CPU/subrequest bounds at the isolation boundary", async () => {
    const load = vi.fn(() => ({
      getEntrypoint: () => ({ fetch: async () => Response.json(output) }),
    }))
    expect(
      await executeCode(
        { load } as unknown as WorkerLoader,
        input,
        new AbortController().signal
      )
    ).toEqual(output)
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
      readOutput(Response.redirect("https://execution.internal/again", 307))
    ).rejects.toThrow()
    await expect(readOutput(new Response("x".repeat(200001)))).rejects.toThrow(
      "output"
    )
    await expect(
      readOutput(Response.json({ ...output, logs: "x".repeat(16001) }))
    ).rejects.toThrow()
  })
  it("never follows generated redirects into a second invocation", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.redirect).toBe("manual")
      return Response.redirect("https://execution.internal/again", 307)
    })
    const loader = { load: () => ({ getEntrypoint: () => ({ fetch }) }) }
    await expect(
      executeCode(
        loader as unknown as WorkerLoader,
        input,
        new AbortController().signal
      )
    ).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it("aborts body consumption when cancellation arrives after response headers", async () => {
    const cancelled = vi.fn()
    const controller = new AbortController()
    const response = new Response(new ReadableStream({ cancel: cancelled }))
    const pending = readOutput(response, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(cancelled).toHaveBeenCalledTimes(1)
  })
})
