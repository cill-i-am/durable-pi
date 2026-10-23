import { Cause, Effect, Exit } from "effect"
import { expect, it, vi } from "vitest"

import { readTaskResponse } from "../src/tasks/adapters/response"

function gate<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

it("reads the existing unknown JSON result and releases its reader", async () => {
  const result = { title: "Task · café", terminal: false }
  const bytes = new TextEncoder().encode(JSON.stringify(result))
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
      controller.close()
    },
  })
  expect(await Effect.runPromise(readTaskResponse(new Response(body)))).toEqual(
    result
  )
  expect(body.locked).toBe(false)
})

it.each([404, 403, 503])(
  "keeps HTTP %s task error semantics and cancels its unread body",
  async (status) => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const exit = await Effect.runPromiseExit(
      readTaskResponse(new Response(body, { status }))
    )
    expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
      {
        _tag: "Fail",
        error: {
          _tag: "TaskControlError",
          code: status === 404 ? "not_found" : "unavailable",
          message:
            "This task's state could not be confirmed. Retry the same handle.",
        },
      },
    ])
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  }
)

it("cancels a successful response body held after its headers arrived", async () => {
  const reading = gate<void>()
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>(
    { pull: () => reading.resolve(), cancel },
    { highWaterMark: 0 }
  )
  const controller = new AbortController()
  const running = Effect.runPromiseExit(readTaskResponse(new Response(body)), {
    signal: controller.signal,
  })
  await reading.promise
  controller.abort()
  const exit = await running
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(cancel).toHaveBeenCalledOnce()
  expect(body.locked).toBe(false)
})

it.each(["complete", "fail"])(
  "joins held reader cancellation until cleanup can %s",
  async (mode) => {
    const reading = gate<void>()
    const cancelling = gate<void>()
    const cleanup = gate<void>()
    const defect = new Error("Task response cleanup failed")
    const cancel = vi.fn(() => {
      cancelling.resolve()
      return cleanup.promise
    })
    const body = new ReadableStream<Uint8Array>(
      { pull: () => reading.resolve(), cancel },
      { highWaterMark: 0 }
    )
    const controller = new AbortController()
    let settled = false
    const running = Effect.runPromiseExit(
      readTaskResponse(new Response(body)),
      {
        signal: controller.signal,
      }
    ).finally(() => {
      settled = true
    })
    await reading.promise
    controller.abort()
    await cancelling.promise
    expect(settled).toBe(false)
    expect(body.locked).toBe(true)
    if (mode === "complete") cleanup.resolve()
    else cleanup.reject(defect)
    const exit = await running
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    if (mode === "fail")
      expect(Exit.isFailure(exit) && exit.cause.reasons).toContainEqual(
        expect.objectContaining({ _tag: "Die", defect })
      )
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  }
)

it("owns an unread response when cancellation arrives before reader creation", async () => {
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({ cancel })
  const getReader = vi.spyOn(body, "getReader")
  const controller = new AbortController()
  controller.abort()
  const exit = await Effect.runPromiseExit(
    readTaskResponse(new Response(body)),
    { signal: controller.signal }
  )
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(getReader).not.toHaveBeenCalled()
  expect(cancel).toHaveBeenCalledOnce()
  expect(body.locked).toBe(false)
})

it("keeps malformed task JSON as a defect", async () => {
  const response = new Response("not json")
  const exit = await Effect.runPromiseExit(readTaskResponse(response))
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(response.body?.locked).toBe(false)
})
