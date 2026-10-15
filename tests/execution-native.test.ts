import { expect, it } from "@effect/vitest"
import { it as test, vi } from "vitest"
import { Cause, Effect, Exit, Fiber, ManagedRuntime } from "effect"
import { TestClock } from "effect/testing"
import {
  executeCode,
  type ExecutionLoader,
} from "../src/execution/adapters/dynamic-worker"
import { readOutput } from "../src/execution/adapters/output"
import { codeService } from "../src/execution/adapters/service"
import { executionJson } from "../src/execution/adapters/input"
import { executionRequest } from "../src/execution/adapters/http"
import { executionWorkerRequest } from "../src/execution/worker"
import { executionApplication, Executions } from "../src/execution/service"
import { ExecutionStore } from "../src/execution/adapters/sqlite"
import { RunInput, type CodeOutput } from "../src/execution/contracts"
import { AppStore } from "../src/apps/adapters/sqlite"
import { makeApps } from "../src/apps/service"
import { WebApps } from "../src/apps/web"
import { webExecutor } from "../src/apps/adapters/code"
import { database } from "./database"

const input = { id: "owned-native", code: "return 3", data: "null" }
const output: CodeOutput = { result: "3", logs: "", error: null }
const run = Effect.runPromise
const gate = <T = void>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
const dies = <T, TError>(exit: Exit.Exit<T, TError>, defect: unknown) =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some(
    (reason) => reason._tag === "Die" && reason.defect === defect
  )
const request = (
  body: string | ReadableStream<Uint8Array>,
  signal?: AbortSignal
) =>
  new Request("https://execution.internal/run", {
    method: "POST",
    body,
    signal,
    ...(typeof body === "string" ? {} : { duplex: "half" }),
  })
const loader = (
  fetch: (request: Request) => Promise<Response>
): ExecutionLoader => ({
  load: () => ({ getEntrypoint: () => ({ fetch }) }),
})

test("successful body consumption unlocks without cancelling an exhausted body", async () => {
  const cancel = vi.fn()
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(output)))
        controller.close()
      },
      cancel,
    })
  )
  expect(await run(readOutput(response))).toEqual(output)
  expect(response.body!.locked).toBe(false)
  expect(cancel).not.toHaveBeenCalled()
})

test("non-OK responses join cancellation and preserve failed body teardown", async () => {
  const entered = gate(),
    close = gate()
  const defect = new Error("unread body cleanup")
  const response = new Response(
    new ReadableStream({
      async cancel() {
        entered.resolve()
        await close.promise
        throw defect
      },
    }),
    { status: 422 }
  )
  let settled = false
  const work = Effect.runPromiseExit(readOutput(response)).then((exit) => {
    settled = true
    return exit
  })
  await entered.promise
  expect(settled).toBe(false)
  close.resolve()
  expect(dies(await work, defect)).toBe(true)
  expect(response.body!.locked).toBe(false)
})

test("reader interruption waits for native cancellation before unlocking and retains cancellation defects", async () => {
  const reading = gate(),
    cancelling = gate(),
    close = gate()
  const defect = new Error("reader cancellation failed")
  const response = new Response(
    new ReadableStream({
      pull() {
        reading.resolve()
      },
      async cancel() {
        cancelling.resolve()
        await close.promise
        throw defect
      },
    })
  )
  const controller = new AbortController()
  let settled = false
  const work = Effect.runPromiseExit(readOutput(response), {
    signal: controller.signal,
  }).then((exit) => {
    settled = true
    return exit
  })
  await reading.promise
  controller.abort()
  await cancelling.promise
  expect(response.body!.locked).toBe(true)
  expect(settled).toBe(false)
  close.resolve()
  const exit = await work
  expect(dies(exit, defect)).toBe(true)
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(response.body!.locked).toBe(false)
})

for (const failed of [false, true])
  test(`late service response is cancelled and joined after abort (cleanup fails: ${failed})`, async () => {
    const started = gate(),
      received = gate<Response>(),
      cleaning = gate(),
      close = gate()
    const defect = new Error("late response cancellation failed")
    let signal!: AbortSignal
    const executor = codeService({
      fetch: async (value) => {
        signal = value.signal
        started.resolve()
        return received.promise
      },
    })
    const controller = new AbortController()
    let settled = false
    const pending = Effect.runPromiseExit(executor.run(input), {
      signal: controller.signal,
    }).then((exit) => {
      settled = true
      return exit
    })
    await started.promise
    controller.abort()
    expect(signal.aborted).toBe(true)
    expect(settled).toBe(false)
    const body = new ReadableStream({
      async cancel() {
        cleaning.resolve()
        await close.promise
        if (failed) throw defect
      },
    })
    received.resolve(new Response(body))
    await cleaning.promise
    expect(settled).toBe(false)
    close.resolve()
    const exit = await pending
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(dies(exit, defect)).toBe(failed)
    expect(body.locked).toBe(false)
  })

for (const failed of [false, true])
  it.effect(
    `native deadline signals once and joins late response cleanup (cleanup fails: ${failed})`,
    () =>
      Effect.gen(function* () {
        const started = gate()
        const received = gate<Response>(),
          cleaning = gate(),
          close = gate()
        const defect = new Error("deadline response cleanup")
        let signal!: AbortSignal,
          calls = 0
        const synced = loader(async (value) => {
          signal = value.signal
          calls++
          started.resolve()
          return received.promise
        })
        let settled = false
        const fiber = yield* Effect.forkChild(
          executeCode(synced, input).pipe(
            Effect.onExit(() =>
              Effect.sync(() => {
                settled = true
              })
            )
          )
        )
        yield* Effect.promise(() => started.promise)
        yield* TestClock.adjust("10 seconds")
        expect(signal.aborted).toBe(true)
        expect(settled).toBe(false)
        received.resolve(
          new Response(
            new ReadableStream({
              async cancel() {
                cleaning.resolve()
                await close.promise
                if (failed) throw defect
              },
            })
          )
        )
        yield* Effect.promise(() => cleaning.promise)
        expect(settled).toBe(false)
        close.resolve()
        const exit = yield* Fiber.await(fiber)
        expect(calls).toBe(1)
        expect(dies(exit, defect)).toBe(failed)
        if (!failed)
          expect(
            Exit.isFailure(exit) &&
              Cause.hasFails(exit.cause) &&
              !Cause.hasInterrupts(exit.cause)
          ).toBe(true)
      })
  )

test("Execution HTTP never admits an oversized input whose stream cleanup fails", async () => {
  const db = database(),
    ledger = new ExecutionStore(db)
  const invoke = vi.fn(() => Effect.succeed(output))
  const runtime = ManagedRuntime.make(
    executionApplication(ledger, { run: invoke }, () => true)
  )
  const execution = runtime.runSync(Executions)
  const defect = new Error("upload cancellation failed")
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(256001))
    },
    cancel() {
      throw defect
    },
  })
  try {
    const exit = await Effect.runPromiseExit(
      executionRequest(execution, request(body), "execution/run", () => {
        throw new Error("No admission should be kept alive")
      })
    )
    expect(dies(exit, defect)).toBe(true)
    expect(body.locked).toBe(false)
    expect(ledger.counts().total).toBe(0)
    expect(invoke).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
  }
})

test("native request cancellation joins the reader without admitting code", async () => {
  const reading = gate(),
    closing = gate(),
    finish = gate()
  const controller = new AbortController()
  const body = new ReadableStream<Uint8Array>({
    pull() {
      reading.resolve()
    },
    async cancel() {
      closing.resolve()
      await finish.promise
    },
  })
  let settled = false
  const work = Effect.runPromiseExit(
    executionJson(request(body, controller.signal), RunInput)
  ).then((exit) => {
    settled = true
    return exit
  })
  await reading.promise
  controller.abort()
  await closing.promise
  expect(body.locked).toBe(true)
  expect(settled).toBe(false)
  finish.resolve()
  const exit = await work
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(body.locked).toBe(false)
})

test("already-aborted JSON and worker requests never read or load code", async () => {
  const load = vi.fn(() => {
    throw new Error("Must not load")
  })
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        throw new Error("Must not read")
      },
    },
    { highWaterMark: 0 }
  )
  const aborted = request(body, AbortSignal.abort())
  const exit = await Effect.runPromiseExit(executionJson(aborted, RunInput))
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  await expect(
    executionWorkerRequest(
      request(JSON.stringify(input), AbortSignal.abort()),
      { load }
    )
  ).rejects.toThrow()
  expect(load).not.toHaveBeenCalled()
  expect(body.locked).toBe(false)
})

test("worker maps malformed requests to 422 and preserves failed input cleanup", async () => {
  const load = vi.fn(() => {
    throw new Error("Must not load")
  })
  expect(
    (await executionWorkerRequest(request("invalid"), { load })).status
  ).toBe(422)
  const defect = new Error("worker input cleanup failed")
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(256001))
    },
    cancel() {
      throw defect
    },
  })
  await expect(
    executionWorkerRequest(request(body), { load })
  ).rejects.toThrow()
  expect(body.locked).toBe(false)
  expect(load).not.toHaveBeenCalled()
})

test("Apps cancellation shares the joined execution transport and retains failed late body cleanup", async () => {
  const started = gate(),
    received = gate<Response>(),
    cleaning = gate(),
    close = gate()
  const defect = new Error("app response cleanup failed")
  const executor = webExecutor({
    fetch: async () => {
      started.resolve()
      return received.promise
    },
  })
  const controller = new AbortController()
  const pending = Effect.runPromiseExit(executor(input, controller.signal))
  await started.promise
  controller.abort()
  received.resolve(
    new Response(
      new ReadableStream({
        async cancel() {
          cleaning.resolve()
          await close.promise
          throw defect
        },
      })
    )
  )
  await cleaning.promise
  close.resolve()
  expect(dies(await pending, defect)).toBe(true)
})

it.effect(
  "deadline cancellation of an acquired reader joins failed teardown and keeps its defect",
  () =>
    Effect.gen(function* () {
      const reading = gate(),
        cleaning = gate(),
        close = gate()
      const defect = new Error("deadline reader cleanup")
      let settled = false
      const body = new ReadableStream<Uint8Array>(
        {
          pull() {
            reading.resolve()
          },
          async cancel() {
            cleaning.resolve()
            await close.promise
            throw defect
          },
        },
        { highWaterMark: 0 }
      )
      const native = loader(async () => new Response(body))
      const fiber = yield* Effect.forkChild(
        executeCode(native, input).pipe(
          Effect.onExit(() =>
            Effect.sync(() => {
              settled = true
            })
          )
        )
      )
      yield* Effect.promise(() => reading.promise)
      expect(body.locked).toBe(true)
      yield* TestClock.adjust("10 seconds")
      yield* Effect.promise(() => cleaning.promise)
      expect(settled).toBe(false)
      expect(body.locked).toBe(true)
      close.resolve()
      expect(dies(yield* Fiber.await(fiber), defect)).toBe(true)
      expect(body.locked).toBe(false)
    })
)

test("failed native response cleanup leaves the actual Execution intent uncertain", async () => {
  const defect = new Error("native rejected response cleanup")
  const executor = codeService({
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            throw defect
          },
        }),
        { status: 422 }
      ),
  })
  const ledger = new ExecutionStore(database())
  const runtime = ManagedRuntime.make(
    executionApplication(ledger, executor, () => true)
  )
  const execution = runtime.runSync(Executions)
  try {
    const task = await runtime.runPromise(execution.start(input))
    expect(dies(await Effect.runPromiseExit(task.completion), defect)).toBe(
      true
    )
    expect(ledger.get(input.id)?.status).toBe("running")
    expect(ledger.get(input.id)?.output).toBeNull()
  } finally {
    expect(
      dies(await Effect.runPromiseExit(runtime.disposeEffect), defect)
    ).toBe(true)
  }
})

test("worker preserves safe success/error responses through its real HTTP handler", async () => {
  const calls: Request[] = []
  const native = loader(async (value) => {
    calls.push(value)
    expect(await value.json()).toBeNull()
    return Response.json(output)
  })
  const response = await executionWorkerRequest(
    request(JSON.stringify(input)),
    native
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(output)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.redirect).toBe("manual")
  expect(
    (
      await executionWorkerRequest(request(JSON.stringify(input)), {
        load: () => {
          throw new Error("private loader failure")
        },
      })
    ).status
  ).toBe(422)
})

test("Apps keeps its execution permit until failed native teardown and commits no interaction", async () => {
  const store = new AppStore(database(), () => true),
    id = crypto.randomUUID()
  const saved = store.save({
    id,
    operationId: crypto.randomUUID(),
    expectedRevision: 0,
    definition: {
      title: "Native",
      description: "Synthetic",
      blocks: [
        { id: "counter", type: "web", initialState: "null", code: "return {}" },
      ],
    },
  })
  const app = store.publish({
    id,
    operationId: crypto.randomUUID(),
    expectedRevision: saved.revision,
    version: 1,
  })
  const started = gate(),
    response = gate<Response>(),
    cleaning = gate(),
    close = gate()
  const defect = new Error("native app release")
  const native = webExecutor({
    fetch: async () => {
      started.resolve()
      return response.promise
    },
  })
  const web = new WebApps(makeApps(store), native)
  const action = {
    id,
    version: 1,
    expectedRevision: app.revision,
    operationId: crypto.randomUUID(),
    action: {
      type: "web" as const,
      blockId: "counter",
      name: "add",
      values: {},
    },
  }
  const pending = Effect.runPromiseExit(
    web.interact(action, new AbortController().signal)
  )
  await started.promise
  web.invalidate()
  response.resolve(
    new Response(
      new ReadableStream({
        async cancel() {
          cleaning.resolve()
          await close.promise
          throw defect
        },
      })
    )
  )
  await cleaning.promise
  const busy = await run(
    web
      .render({ id, version: 1 }, new AbortController().signal)
      .pipe(Effect.result)
  )
  expect(busy).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "AppConflict",
      message: expect.stringContaining("another app"),
    },
  })
  close.resolve()
  expect(dies(await pending, defect)).toBe(true)
  expect(store.detail(id).app.revision).toBe(app.revision)
  expect(store.interactionReceipt(action)).toBeUndefined()
})
