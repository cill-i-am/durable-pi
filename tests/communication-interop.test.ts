import { expect, it } from "vitest"
import { Cause, Context, Effect, Exit } from "effect"
import { communicationNative } from "../src/communication/adapters/interop"
import { boundedFrame } from "../src/communication/adapters/input"
import { failure } from "../src/communication/contracts"

function gate<T = void>() {
  let release!: (value: T) => void
  const waiting = new Promise<T>((resolve) => {
    release = resolve
  })
  return { release, waiting }
}
const reasons = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons : []

function bodyRequest(body: ReadableStream<Uint8Array>) {
  const options: RequestInit & { duplex: "half" } = {
    method: "POST",
    body,
    duplex: "half",
  }
  return new Request("https://mailbox.test", options)
}

it("recognizes a declared communication error without its class prototype", async () => {
  const error = failure("forbidden", "Owner denied this task.")
  Object.setPrototypeOf(error, Error.prototype)
  const exit = await Effect.runPromiseExit(
    communicationNative(() => Promise.reject(error))
  )
  expect(reasons(exit)).toMatchObject([
    { _tag: "Fail", error: { _tag: "CommunicationError", code: "forbidden" } },
  ])
})

it("preserves every native reason when an undeclared failure becomes a defect", async () => {
  class RequestId extends Context.Service<RequestId, string>()(
    "InteropRequest"
  ) {}
  const unknown = new Error("Private unknown failure"),
    defect = new Error("Private defect")
  const cause = Cause.fromReasons([
    Cause.makeFailReason(unknown).annotate(Context.make(RequestId, "original")),
    Cause.makeDieReason(defect),
    Cause.makeInterruptReason(27),
  ])
  const exit = await Effect.runPromiseExit(
    communicationNative(() => Promise.reject(cause))
  )
  expect(reasons(exit).map((reason) => reason._tag)).toEqual([
    "Die",
    "Die",
    "Interrupt",
  ])
  expect(reasons(exit)[0]).toMatchObject({ _tag: "Die", defect: unknown })
  expect(reasons(exit)[0]?.annotations.get(RequestId.key)).toBe("original")
  expect(reasons(exit)[1]).toMatchObject({ _tag: "Die", defect })
})

it("does not accept a forged error tag with invalid contract fields", async () => {
  const invalid = {
    _tag: "CommunicationError",
    code: "undocumented",
    message: "private",
  }
  const exit = await Effect.runPromiseExit(
    communicationNative(() => Promise.reject(Cause.fail(invalid)))
  )
  expect(reasons(exit)).toMatchObject([{ _tag: "Die", defect: invalid }])
})

it("joins a native operation and retains a late defect after interruption", async () => {
  const entered = gate(),
    release = gate(),
    controller = new AbortController()
  const defect = new Error("Late native failure")
  let settled = false
  const running = Effect.runPromiseExit(
    communicationNative(async () => {
      entered.release()
      await release.waiting
      throw Cause.die(defect)
    }),
    { signal: controller.signal }
  ).then((exit) => {
    settled = true
    return exit
  })
  try {
    await entered.waiting
    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    release.release()
    const exit = await running
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(reasons(exit)).toContainEqual(
      expect.objectContaining({ _tag: "Die", defect })
    )
  } finally {
    release.release()
    await running
  }
})

it("bounds frame bytes and preserves failed reader cleanup alongside the invalid input", async () => {
  const defect = new Error("Private cancellation failure")
  const stream = new ReadableStream<Uint8Array>({
    start: (target) => target.enqueue(Uint8Array.of(1, 2)),
    cancel: () => Promise.reject(defect),
  })
  const request = bodyRequest(stream)
  const exit = await Effect.runPromiseExit(boundedFrame(request, 1))
  expect(reasons(exit)).toContainEqual(
    expect.objectContaining({
      _tag: "Fail",
      error: expect.objectContaining({ code: "invalid" }),
    })
  )
  expect(reasons(exit)).toContainEqual(
    expect.objectContaining({ _tag: "Die", defect })
  )
  expect(stream.locked).toBe(false)
})

it("joins held frame cancellation before releasing its reader", async () => {
  const reading = gate(),
    cleaning = gate(),
    release = gate(),
    controller = new AbortController()
  const stream = new ReadableStream<Uint8Array>(
    {
      pull: () => {
        reading.release()
      },
      cancel: async () => {
        cleaning.release()
        await release.waiting
      },
    },
    { highWaterMark: 0 }
  )
  const request = bodyRequest(stream)
  let settled = false
  const running = Effect.runPromiseExit(boundedFrame(request), {
    signal: controller.signal,
  }).then((exit) => {
    settled = true
    return exit
  })
  try {
    await reading.waiting
    controller.abort()
    await cleaning.waiting
    expect(settled).toBe(false)
    expect(stream.locked).toBe(true)
    release.release()
    const exit = await running
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(stream.locked).toBe(false)
  } finally {
    release.release()
    await running
  }
})
