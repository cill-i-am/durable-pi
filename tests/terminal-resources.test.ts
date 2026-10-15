import { expect, it, vi } from "vitest"
import { it as effectIt } from "@effect/vitest"
import { Cause, Context, Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { nativeOperation } from "../src/shared/interop"
import {
  effectInteractiveRuntime,
  effectTerminalRuntime,
} from "../src/terminal/adapters/interop"
import { readCommand, sandboxRuntime } from "../src/terminal/adapters/sandbox"
import { readBounded } from "../src/terminal/adapters/stream"
import {
  extractVideoRequest,
  sandboxVideo,
  type VideoSandbox,
} from "../src/terminal/adapters/video"
import { TerminalRuntimeError } from "../src/terminal/runtime"
import { TerminalFailure } from "../src/terminal/contracts"
import { MAX_FILE_BYTES } from "../src/workspace/files"
import type { Sandbox } from "@cloudflare/sandbox"

function gate<T = void>() {
  let release!: (value: T) => void
  const waiting = new Promise<T>((resolve) => {
    release = resolve
  })
  return { waiting, release }
}
function reasons(exit: Exit.Exit<unknown, unknown>) {
  return Exit.isFailure(exit) ? exit.cause.reasons : []
}
function hasDefect(exit: Exit.Exit<unknown, unknown>, defect: unknown) {
  return reasons(exit).some(
    (reason) => reason._tag === "Die" && reason.defect === defect
  )
}
const failed = (cause: unknown) =>
  new TerminalRuntimeError({ operation: "synthetic", cause })
const request = () =>
  new Request("https://video.internal/video", {
    method: "POST",
    body: new Uint8Array([1]),
  })
const complete = (code = 0) =>
  new Response(
    `data: ${JSON.stringify({ type: "complete", exitCode: code })}\n\n`
  ).body!
function video(overrides: Partial<VideoSandbox> = {}) {
  const host = {
    destroy: vi.fn(async () => {}),
    startAndWaitForPorts: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    execStream: vi.fn(async () => complete()),
    readFile: vi.fn(async (path: string) => ({
      content: path.endsWith("json")
        ? new Response(
            JSON.stringify({
              duration: 2,
              frames: [{ at: 1 }],
              captions: "safe",
              captionsTruncated: false,
            })
          ).body!
        : new Blob([Uint8Array.of(255, 216, 255, 224, 0, 16)]).stream(),
    })),
    ...overrides,
  }
  return { host, extract: sandboxVideo(host) }
}

it("preserves native Cause defects, interruption and annotations while translating only Fail reasons", async () => {
  class RequestId extends Context.Service<RequestId, string>()(
    "test/NativeRequestId"
  ) {}
  const defect = new Error("private invariant"),
    ordinary = new Error("private transport")
  const fail = Cause.makeFailReason(ordinary).annotate(
      Context.make(RequestId, "request")
    ),
    die = Cause.makeDieReason(defect),
    interrupt = Cause.makeInterruptReason(31)
  const exit = await Effect.runPromiseExit(
    nativeOperation(
      () => Promise.reject(Cause.fromReasons([fail, die, interrupt])),
      failed
    )
  )
  expect(reasons(exit)).toHaveLength(3)
  expect(hasDefect(exit, defect)).toBe(true)
  expect(reasons(exit)).toContain(interrupt)
  expect(reasons(exit)).toContainEqual(
    expect.objectContaining({
      _tag: "Fail",
      error: expect.objectContaining({
        _tag: "TerminalRuntimeError",
        cause: ordinary,
      }),
      annotations: fail.annotations,
    })
  )
})

it("retains a native defect arriving after interruption while joining actual settlement", async () => {
  const entered = gate(),
    result = gate<void>(),
    controller = new AbortController(),
    defect = new Error("late invariant")
  let ended = false
  const pending = Effect.runPromiseExit(
    nativeOperation(() => {
      entered.release()
      return result.waiting.then(() => {
        throw Cause.die(defect)
      })
    }, failed),
    { signal: controller.signal }
  ).then((exit) => {
    ended = true
    return exit
  })
  await entered.waiting
  controller.abort()
  expect(ended).toBe(false)
  result.release()
  const exit = await pending
  expect(hasDefect(exit, defect)).toBe(true)
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
})

for (const mode of ["file", "command"] as const) {
  it(`joins ${mode} reader cancellation and retains its failed cleanup after Stop`, async () => {
    const entered = gate(),
      cleaning = gate(),
      release = gate(),
      controller = new AbortController(),
      defect = new Error("reader cleanup")
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          entered.release()
        },
        async cancel() {
          cleaning.release()
          await release.waiting
          throw defect
        },
      },
      { highWaterMark: 0 }
    )
    let ended = false
    const reading = (
      mode === "file"
        ? readBounded(body, 10, controller.signal)
        : readCommand(body, () => {}, controller.signal)
    ).then(
      () => undefined,
      (cause: unknown) => {
        ended = true
        return cause
      }
    )
    await entered.waiting
    controller.abort()
    await cleaning.waiting
    expect(ended).toBe(false)
    release.release()
    const cause = await reading
    expect(
      Cause.isCause(cause) &&
        cause.reasons.some(
          (reason) => reason._tag === "Die" && reason.defect === defect
        )
    ).toBe(true)
    expect(Cause.isCause(cause) && Cause.hasFails(cause)).toBe(true)
    expect(body.locked).toBe(false)
  })
}

it("retains both protocol rejection and failed cancellation instead of reporting a normal output limit", async () => {
  const defect = new Error("private cancellation")
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(11))
    },
    cancel() {
      throw defect
    },
  })
  const exit = await Effect.runPromiseExit(
    nativeOperation((signal) => readBounded(body, 10, signal), failed)
  )
  expect(hasDefect(exit, defect)).toBe(true)
  expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
  expect(body.locked).toBe(false)
})

it("keeps a native source error expected without treating an already errored body as a second cleanup failure", async () => {
  const error = new Error("source unavailable")
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(error)
    },
  })
  const exit = await Effect.runPromiseExit(
    nativeOperation((signal) => readBounded(body, 10, signal), failed)
  )
  expect(reasons(exit)).toEqual([
    expect.objectContaining({
      _tag: "Fail",
      error: expect.objectContaining({ cause: error }),
    }),
  ])
  expect(body.locked).toBe(false)
})

it("uses schema-decoded command events and keeps an unexpected output callback error a defect", async () => {
  for (const data of [
    "null",
    "{",
    '{"type":"complete","exitCode":"0"}',
    '{"type":"complete","exitCode":0.5}',
  ]) {
    const body = new Response(`data: ${data}\n\n`).body!
    const exit = await Effect.runPromiseExit(
      nativeOperation((signal) => readCommand(body, () => {}, signal), failed)
    )
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
    expect(body.locked).toBe(false)
  }
  const defect = new Error("callback invariant")
  const exit = await Effect.runPromiseExit(
    nativeOperation(
      (signal) =>
        readCommand(
          new Response('data: {"type":"stdout","data":"hi"}\n\n').body!,
          () => {
            throw defect
          },
          signal
        ),
      failed
    )
  )
  expect(hasDefect(exit, defect)).toBe(true)
})

it("claims and closes a checkpoint body acquired after Sandbox snapshot cancellation", async () => {
  const entered = gate(),
    file = gate<{ content: ReadableStream<Uint8Array> }>(),
    cancel = vi.fn(async () => {}),
    controller = new AbortController()
  const host = {
    execStream: async () => complete(),
    readFile: () => {
      entered.release()
      return file.waiting
    },
  }
  const runtime = sandboxRuntime(host as unknown as Sandbox)
  const pending = runtime.snapshot(controller.signal)
  await entered.waiting
  controller.abort()
  file.release({ content: new ReadableStream<Uint8Array>({ cancel }) })
  await expect(pending).rejects.toThrow("Stopped")
  expect(cancel).toHaveBeenCalledOnce()
})

it("Terminal settlement retains a late SDK cleanup defect after the waiting fiber ends", async () => {
  const entered = gate(),
    result = gate<void>(),
    defect = new Error("late reader release")
  const runtime = effectTerminalRuntime({
    restore: async () => {},
    close: async () => {},
    snapshot: async () => new Uint8Array(),
    execute: async () => {
      entered.release()
      await result.waiting
      throw Cause.die(defect)
    },
  })
  const controller = new AbortController()
  const pending = Effect.runPromiseExit(
    runtime.execute("command", () => {}, controller.signal),
    { signal: controller.signal }
  )
  await entered.waiting
  controller.abort()
  expect(Exit.isFailure(await pending)).toBe(true)
  let settled = false
  const settling = Effect.runPromiseExit(runtime.settle()).then((exit) => {
    settled = true
    return exit
  })
  expect(settled).toBe(false)
  result.release()
  expect(hasDefect(await settling, defect)).toBe(true)
  expect(Exit.isSuccess(await Effect.runPromiseExit(runtime.settle()))).toBe(
    true
  )
})

it("releases non-WebSocket interactive responses and retains their cleanup failure", async () => {
  const defect = new Error("private failed upgrade cleanup")
  const response = new Response(
    new ReadableStream({
      cancel() {
        throw defect
      },
    }),
    { status: 503 }
  )
  const runtime = effectInteractiveRuntime({
    connect: async () => response,
    close: async () => {},
  })
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      runtime.connect(new Request("https://terminal.internal/socket"))
    )
  )
  expect(hasDefect(exit, defect)).toBe(true)
})

it("extracts bounded video metadata and JPEG frames and closes the container before publishing a response", async () => {
  const f = video()
  const response = await Effect.runPromise(
    extractVideoRequest(f.extract, request())
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    duration: 2,
    frames: [{ at: 1, jpeg: "/9j/4AAQ" }],
    captions: "safe",
    captionsTruncated: false,
  })
  expect(f.host.destroy).toHaveBeenCalledTimes(2)
  expect(f.host.readFile).toHaveBeenCalledTimes(2)
})

it("preserves unreadable video and unavailable extraction as distinct finite HTTP failures", async () => {
  const unreadable = video({ execStream: async () => complete(1) })
  const rejected = await Effect.runPromise(
    extractVideoRequest(unreadable.extract, request())
  )
  expect(rejected.status).toBe(422)
  expect(await rejected.json()).toEqual({ error: "unreadable" })
  for (const f of [
    video({
      readFile: async () => ({
        content: new Response("private malformed metadata").body!,
      }),
    }),
    video({
      startAndWaitForPorts: async () => {
        throw new Error("private SDK error")
      },
    }),
  ]) {
    const response = await Effect.runPromise(
      extractVideoRequest(f.extract, request())
    )
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain("private")
  }
})

it("validates video input and pre-cancellation before any native container admission", async () => {
  const f = video(),
    controller = new AbortController()
  const oversized = new Request("https://video.internal/video", {
    method: "POST",
    body: new Uint8Array(MAX_FILE_BYTES + 1),
  })
  expect(
    (await Effect.runPromise(extractVideoRequest(f.extract, oversized))).status
  ).toBe(503)
  controller.abort()
  const exit = await Effect.runPromiseExit(
    extractVideoRequest(f.extract, request()),
    { signal: controller.signal }
  )
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(f.host.destroy).not.toHaveBeenCalled()
})

it("video abort joins late startup and held final destruction before releasing its owner", async () => {
  const entered = gate(),
    started = gate(),
    cleaning = gate(),
    release = gate(),
    controller = new AbortController()
  let closes = 0,
    ended = false
  const f = video({
    startAndWaitForPorts: async () => {
      entered.release()
      await started.waiting
    },
    destroy: async () => {
      if (++closes === 2) {
        cleaning.release()
        await release.waiting
      }
    },
  })
  const pending = Effect.runPromiseExit(
    extractVideoRequest(f.extract, request()),
    { signal: controller.signal }
  ).then((exit) => {
    ended = true
    return exit
  })
  await entered.waiting
  controller.abort()
  expect(ended).toBe(false)
  started.release()
  await cleaning.waiting
  expect(ended).toBe(false)
  expect(f.host.mkdir).not.toHaveBeenCalled()
  release.release()
  const exit = await pending
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
})

it("video abort closes a late metadata body and preserves its cleanup defect through HTTP recovery", async () => {
  const entered = gate(),
    file = gate<{ content: ReadableStream<Uint8Array> }>(),
    defect = new Error("private late body cleanup"),
    controller = new AbortController()
  const f = video({
    readFile: () => {
      entered.release()
      return file.waiting
    },
  })
  const pending = Effect.runPromiseExit(
    extractVideoRequest(f.extract, request()),
    { signal: controller.signal }
  )
  await entered.waiting
  controller.abort()
  file.release({
    content: new ReadableStream({
      cancel() {
        throw defect
      },
    }),
  })
  const exit = await pending
  expect(hasDefect(exit, defect)).toBe(true)
  expect(f.host.destroy).toHaveBeenCalledTimes(2)
})

it("never turns failed video destruction or a tagged defect into an unavailable response", async () => {
  const defect = new Error("container cleanup failed")
  let calls = 0
  const f = video({
    destroy: async () => {
      if (++calls === 2) throw defect
    },
  })
  const exit = await Effect.runPromiseExit(
    extractVideoRequest(f.extract, request())
  )
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  const tagged = new TerminalFailure({ message: "private invariant" })
  const taggedExit = await Effect.runPromiseExit(
    extractVideoRequest(() => Effect.die(tagged), request())
  )
  expect(hasDefect(taggedExit, tagged)).toBe(true)
})

effectIt.effect(
  "video deadline uses invocation Clock and joins cleanup before returning its safe timeout",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        cleaning = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      const program = extractVideoRequest(
        () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Deferred.succeed(cleaning, undefined).pipe(
                Effect.andThen(Deferred.await(release))
              )
            )
          ),
        request()
      )
      const fiber = yield* Effect.forkChild(program)
      yield* Deferred.await(entered)
      yield* TestClock.adjust("60 seconds")
      yield* Deferred.await(cleaning)
      yield* Effect.sync(() => expect(fiber.pollUnsafe()).toBeUndefined()).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined))
      )
      const response = yield* Fiber.join(fiber)
      expect(response.status).toBe(503)
    })
)
