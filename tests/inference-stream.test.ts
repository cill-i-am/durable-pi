import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream"
import { it as effectIt } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, ManagedRuntime } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, expect, it, vi } from "vitest"

import { accountCredentials } from "../src/inference/adapters/credentials-pi"
import { createAgentModels } from "../src/inference/adapters/models-pi"
import {
  PiModelRequest,
  PiModelStreams,
  piModelStreamsLayer,
  modelCallback,
  MAX_PENDING_MODEL_EVENTS,
  MAX_PROVIDER_BYTES,
  MAX_MODEL_STREAM_MILLIS,
} from "../src/inference/adapters/streams-pi"
import { resolveRoute } from "../src/inference/policy"
import { piModelSummaryProvider } from "../src/memory/adapters/pi-model"
import { credential, response } from "./inference-fixture"

const gate = () => {
  let resolve!: () => void
  let done = false
  const promise = new Promise<void>((complete) => {
    resolve = () => {
      done = true
      complete()
    }
  })
  return {
    promise,
    resolve,
    get done() {
      return done
    },
  }
}
const roots = new Set<ReturnType<typeof fixture>>()
function fixture(
  options: Partial<Parameters<typeof createAgentModels>[1]> = {},
  credentials = accountCredentials(async () => credential)
) {
  const runtime = ManagedRuntime.make(piModelStreamsLayer)
  const streams = runtime.runSync(PiModelStreams)
  const models = createAgentModels(credentials, {
    ...options,
    start: (request) => runtime.runSync(streams.start(request)),
  })
  const model = models.getModel("openai", "gpt-6.1-sol")!
  const owner = {
    runtime,
    streams,
    models,
    model,
    expectedDefect: undefined as unknown,
  }
  roots.add(owner)
  return owner
}
const hasDefect = (cause: unknown, defect: unknown) =>
  Cause.isCause(cause) &&
  cause.reasons.some((r) => r._tag === "Die" && r.defect === defect)
afterEach(async () => {
  for (const owner of roots) {
    roots.delete(owner)
    const exit = await Effect.runPromiseExit(owner.runtime.disposeEffect)
    if (owner.expectedDefect)
      expect(
        Exit.isFailure(exit) && hasDefect(exit.cause, owner.expectedDefect)
      ).toBe(true)
    else expect(Exit.isSuccess(exit)).toBe(true)
  }
})
const context = {
  messages: [{ role: "user" as const, content: "hello", timestamp: 0 }],
}

it("result-only consumption drains the native event stream and emits one completed reply", async () => {
  const owner = fixture()
  const result = await owner.models.completeSimple(owner.model, context, {
    reasoning: "medium",
    fetch: async () => response(owner.model.id),
  })
  expect(result.stopReason).toBe("stop")
  expect(result.content).toMatchObject([
    { type: "text", text: "Saved and verified." },
  ])
})

it("a failed Effect callback survives the SDK's ordinary error-message normalization", async () => {
  const defect = new Error("Private catalog invariant")
  const owner = fixture({
    catalog: () => modelCallback(Effect.runPromiseExit(Effect.die(defect))),
  })
  owner.expectedDefect = defect
  const fetcher = vi.fn(async () => response(owner.model.id))
  const rejected = await owner.models
    .completeSimple(owner.model, context, {
      reasoning: "medium",
      fetch: fetcher,
    })
    .then(
      () => undefined,
      (cause) => cause
    )
  expect(hasDefect(rejected, defect)).toBe(true)
  const next = await owner.models.completeSimple(owner.model, context, {
    reasoning: "medium",
    fetch: fetcher,
  })
  expect(next.errorMessage).toContain("currently unavailable")
  expect(fetcher).not.toHaveBeenCalled()
})

it("owner shutdown aborts credentials and joins a late rejected callback without dropping its defect", async () => {
  const entered = gate(),
    release = gate(),
    defect = new Error("Late credential cleanup")
  let signal: AbortSignal | undefined
  const owner = fixture(
    {},
    accountCredentials(async (_provider, current) => {
      signal = current
      entered.resolve()
      await release.promise
      throw Cause.die(defect)
    })
  )
  owner.expectedDefect = defect
  const result = owner.models
    .completeSimple(owner.model, context, { reasoning: "medium" })
    .then(
      () => undefined,
      (cause) => cause
    )
  let stopped = false
  try {
    await vi.waitFor(() => expect(entered.done).toBe(true))
    const shutdown = owner.runtime
      .runPromiseExit(owner.streams.shutdown())
      .then((exit) => {
        stopped = true
        return exit
      })
    await vi.waitFor(() => expect(signal?.aborted).toBe(true))
    expect(stopped).toBe(false)
    release.resolve()
    const exit = await shutdown
    expect(Exit.isFailure(exit) && hasDefect(exit.cause, defect)).toBe(true)
    expect(hasDefect(await result, defect)).toBe(true)
  } finally {
    release.resolve()
    await result
  }
})

it("early iterator return aborts the actual Responses request and waits for body cancellation", async () => {
  const owner = fixture(),
    closing = gate(),
    release = gate()
  const bytes = new TextEncoder().encode(await response(owner.model.id).text())
  let cancellations = 0,
    ended = false,
    signal: AbortSignal | null | undefined
  const stream = owner.models.streamSimple(owner.model, context, {
    reasoning: "medium",
    fetch: async (_input, options) => {
      signal = options?.signal
      return new Response(
        new ReadableStream<Uint8Array>({
          start(target) {
            target.enqueue(bytes)
          },
          async cancel() {
            cancellations++
            closing.resolve()
            await release.promise
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      )
    },
  })
  const consuming = (async () => {
    for await (const _event of stream) break
    ended = true
  })()
  try {
    await vi.waitFor(() => expect(closing.done).toBe(true))
    expect(signal?.aborted).toBe(true)
    expect(ended).toBe(false)
    expect(cancellations).toBe(1)
    release.resolve()
    await consuming
    expect(ended).toBe(true)
    expect((await stream.result()).stopReason).toBe("aborted")
  } finally {
    release.resolve()
    await consuming
  }
})

it("the SDK cannot swallow a rejected native reader cancellation", async () => {
  const owner = fixture(),
    defect = new Error("Private native body cancellation")
  owner.expectedDefect = defect
  const bytes = new TextEncoder().encode(await response(owner.model.id).text())
  const result = owner.models
    .completeSimple(owner.model, context, {
      reasoning: "medium",
      onProviderStreamEvent: async () => {
        throw new Error("Stop parsing")
      },
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(target) {
              target.enqueue(bytes)
            },
            cancel() {
              throw defect
            },
          }),
          { headers: { "content-type": "text/event-stream" } }
        ),
    })
    .then(
      () => undefined,
      (cause) => cause
    )
  expect(hasDefect(await result, defect)).toBe(true)
})

it("a late response after cancellation is still acquired and released before owner shutdown", async () => {
  const owner = fixture(),
    entered = gate(),
    deliver = gate(),
    closing = gate(),
    release = gate()
  let closed = false,
    stopped = false
  const result = owner.models
    .completeSimple(owner.model, context, {
      reasoning: "medium",
      fetch: async () => {
        entered.resolve()
        await deliver.promise
        return new Response(
          new ReadableStream<Uint8Array>({
            async cancel() {
              closing.resolve()
              await release.promise
              closed = true
            },
          }),
          { headers: { "content-type": "text/event-stream" } }
        )
      },
    })
    .then(
      () => undefined,
      (cause) => cause
    )
  try {
    await vi.waitFor(() => expect(entered.done).toBe(true))
    const stopping = owner.runtime
      .runPromise(owner.streams.shutdown())
      .then(() => {
        stopped = true
      })
    deliver.resolve()
    await vi.waitFor(() => expect(closing.done).toBe(true))
    expect(stopped).toBe(false)
    expect(closed).toBe(false)
    release.resolve()
    await stopping
    await result
    expect(closed).toBe(true)
  } finally {
    deliver.resolve()
    release.resolve()
    await result
  }
})

it("unconsumed model events are bounded and overflow cancels upstream", async () => {
  const owner = fixture()
  const message = fauxAssistantMessage("test")
  const request = new PiModelRequest(
    owner.model,
    () => {
      const source = new AssistantMessageEventStream()
      source.push({ type: "start", partial: message })
      for (let i = 0; i < MAX_PENDING_MODEL_EVENTS * 2; i++)
        source.push({
          type: "text_delta",
          contentIndex: 0,
          delta: "x",
          partial: message,
        })
      source.push({ type: "done", reason: "stop", message })
      source.end()
      return source
    },
    () => {}
  )
  owner.runtime.runSync(owner.streams.start(request))
  await request.settled
  let count = 0
  for await (const _event of request.stream) count++
  expect(count).toBe(MAX_PENDING_MODEL_EVENTS + 1)
  expect(request.signal.aborted).toBe(true)
  expect((await request.stream.result()).stopReason).toBe("error")
})

it("a provider body exceeding the byte bound fails and releases its reader", async () => {
  const owner = fixture(),
    cancel = vi.fn()
  const result = await owner.models.completeSimple(owner.model, context, {
    reasoning: "medium",
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(target) {
            target.enqueue(new Uint8Array(MAX_PROVIDER_BYTES + 1))
          },
          cancel,
        }),
        { headers: { "content-type": "text/event-stream" } }
      ),
  })
  expect(result.stopReason).toBe("error")
  expect(result.errorMessage).toContain("supported buffer or response size")
  expect(cancel).toHaveBeenCalledOnce()
})

it("a source ending without a terminal event resolves as failure rather than hanging result()", async () => {
  const owner = fixture()
  const request = new PiModelRequest(
    owner.model,
    () => {
      const source = new AssistantMessageEventStream()
      source.end()
      return source
    },
    () => {}
  )
  owner.runtime.runSync(owner.streams.start(request))
  expect((await request.stream.result()).stopReason).toBe("error")
})

it("unexpected native iterator failures retain their original defect", async () => {
  const owner = fixture(),
    defect = new Error("Broken native iterator")
  owner.expectedDefect = defect
  class BrokenStream extends AssistantMessageEventStream {
    override [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<never>> => {
          throw defect
        },
      }
    }
  }
  const request = new PiModelRequest(
    owner.model,
    () => new BrokenStream(),
    () => {}
  )
  owner.runtime.runSync(owner.streams.start(request))
  const rejected = await request.stream.result().then(
    () => undefined,
    (cause) => cause
  )
  expect(hasDefect(rejected, defect)).toBe(true)
})

it("pre-cancelled requests and a stopped owner dispatch no credentials or provider work", async () => {
  const credentials = vi.fn(async () => credential),
    fetcher = vi.fn(async () => response("gpt-6.1-sol"))
  const owner = fixture({}, accountCredentials(credentials)),
    controller = new AbortController()
  controller.abort()
  expect(
    (
      await owner.models.completeSimple(owner.model, context, {
        reasoning: "medium",
        signal: controller.signal,
        fetch: fetcher,
      })
    ).stopReason
  ).toBe("aborted")
  await owner.runtime.runPromise(owner.streams.shutdown())
  expect(
    (
      await owner.models.completeSimple(owner.model, context, {
        reasoning: "medium",
        fetch: fetcher,
      })
    ).stopReason
  ).toBe("error")
  expect(credentials).not.toHaveBeenCalled()
  expect(fetcher).not.toHaveBeenCalled()
})

it("Memory restores a credential callback defect after the actual SDK reports an error", async () => {
  const defect = new Error("Private account invariant"),
    owner = fixture()
  owner.expectedDefect = defect
  const job = { start: 0, count: 1, source: "Original", context: "" }
  const provider = piModelSummaryProvider(
    {
      credentials: () =>
        accountCredentials(async () => {
          throw Cause.die(defect)
        }),
      options: () => ({
        start: (request) => owner.runtime.runSync(owner.streams.start(request)),
      }),
      systemPrompt: "Synthetic",
    },
    () => Effect.die("Catalog must not be reached")
  )
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const prepared = yield* provider.prepare(resolveRoute("memory"), job)
      return yield* prepared.complete(
        [{ role: "user", text: "Summarize" }],
        job
      )
    })
  )
  expect(Exit.isFailure(exit) && hasDefect(exit.cause, defect)).toBe(true)
})

it("Memory cancellation joins a late credential defect and retains it alongside interruption", async () => {
  const defect = new Error("Late summary credential failure"),
    owner = fixture(),
    entered = gate(),
    release = gate()
  owner.expectedDefect = defect
  const job = { start: 0, count: 1, source: "Original", context: "" }
  let signal: AbortSignal | undefined
  const provider = piModelSummaryProvider(
    {
      credentials: () =>
        accountCredentials(async (_provider, current) => {
          signal = current
          entered.resolve()
          await release.promise
          throw Cause.die(defect)
        }),
      options: () => ({
        start: (request) => owner.runtime.runSync(owner.streams.start(request)),
      }),
      systemPrompt: "Synthetic",
    },
    () => Effect.die("Catalog must not be reached")
  )
  const fiber = Effect.runFork(
    Effect.gen(function* () {
      const prepared = yield* provider.prepare(resolveRoute("memory"), job)
      return yield* prepared.complete(
        [{ role: "user", text: "Summarize" }],
        job
      )
    })
  )
  try {
    await vi.waitFor(() => expect(entered.done).toBe(true))
    let joined = false
    const stopping = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      joined = true
    })
    await vi.waitFor(() => expect(signal?.aborted).toBe(true))
    expect(joined).toBe(false)
    release.resolve()
    await stopping
    const exit = await Effect.runPromise(Fiber.await(fiber))
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(Exit.isFailure(exit) && hasDefect(exit.cause, defect)).toBe(true)
  } finally {
    release.resolve()
    await Effect.runPromise(Fiber.interrupt(fiber))
  }
})

it("the retained owner bounds active requests and refuses additional native dispatch", async () => {
  const owner = fixture()
  let dispatched = 0
  const message = fauxAssistantMessage("unfinished", { stopReason: "aborted" })
  const requests = Array.from(
    { length: 17 },
    () =>
      new PiModelRequest(
        owner.model,
        (current) => {
          dispatched++
          const source = new AssistantMessageEventStream()
          current.signal.addEventListener(
            "abort",
            () => {
              source.push({ type: "error", reason: "aborted", error: message })
              source.end()
            },
            { once: true }
          )
          return source
        },
        () => {}
      )
  )
  for (const request of requests)
    owner.runtime.runSync(owner.streams.start(request))
  expect((await requests[16]!.stream.result()).errorMessage).toContain(
    "Wait for some work to finish"
  )
  expect(dispatched).toBe(16)
  await owner.runtime.runPromise(owner.streams.shutdown())
  expect(
    requests.every(
      (request) => request.signal.aborted || request === requests[16]
    )
  ).toBe(true)
})

effectIt.effect(
  "the overall provider deadline uses Clock, aborts and joins before reporting timeout",
  () =>
    Effect.gen(function* () {
      const streams = yield* PiModelStreams
      const model = openaiProvider()
        .getModels()
        .find((value) => value.id === "gpt-6.1-sol")!
      const message = fauxAssistantMessage("unfinished", {
        stopReason: "aborted",
      })
      let aborted = false
      const request = new PiModelRequest(
        model,
        (current) => {
          const source = new AssistantMessageEventStream()
          current.signal.addEventListener(
            "abort",
            () => {
              aborted = true
              source.push({ type: "error", reason: "aborted", error: message })
              source.end()
            },
            { once: true }
          )
          return source
        },
        () => {}
      )
      yield* streams.start(request)
      yield* TestClock.adjust(MAX_MODEL_STREAM_MILLIS - 1)
      expect(aborted).toBe(false)
      yield* TestClock.adjust(1)
      const result = yield* Effect.promise(() => request.stream.result())
      expect(aborted).toBe(true)
      expect(result.stopReason).toBe("error")
      expect(result.errorMessage).toContain("timed out")
    }).pipe(Effect.provide(piModelStreamsLayer))
)

it("awaits durable attempt admission before dispatch and observer settlement before result or shutdown", async () => {
  const admitting = gate(),
    admitted = gate(),
    finishing = gate(),
    finished = gate()
  const owner = fixture({
    onAttempt: async () => {
      admitting.resolve()
      await admitted.promise
      return {
        id: "durable-attempt",
        turnId: "turn",
        usage: async () => {},
        end: async () => {
          finishing.resolve()
          await finished.promise
        },
      }
    },
  })
  const fetcher = vi.fn(async () => response(owner.model.id))
  let completed = false,
    disposed = false
  const result = owner.models
    .completeSimple(owner.model, context, {
      reasoning: "medium",
      fetch: fetcher,
    })
    .then((value) => {
      completed = true
      return value
    })
  await admitting.promise
  expect(fetcher).not.toHaveBeenCalled()
  admitted.resolve()
  await finishing.promise
  const shutdown = owner.runtime
    .runPromise(owner.streams.shutdown())
    .then(() => {
      disposed = true
    })
  await Promise.resolve()
  expect(completed).toBe(false)
  expect(disposed).toBe(false)
  finished.resolve()
  await result
  await shutdown
  expect(completed).toBe(true)
  expect(disposed).toBe(true)
  expect(fetcher).toHaveBeenCalledOnce()
})

it("retains observer completion defects in both stream settlement and owner disposal", async () => {
  const defect = new Error("Durable usage completion failed")
  const owner = fixture({
    onAttempt: async () => ({
      id: "durable-attempt",
      turnId: null,
      usage: async () => {},
      end: async () => {
        throw defect
      },
    }),
  })
  owner.expectedDefect = defect
  const failure = await owner.models
    .completeSimple(owner.model, context, {
      reasoning: "medium",
      fetch: async () => response(owner.model.id),
    })
    .then(
      () => undefined,
      (cause) => cause
    )
  expect(hasDefect(failure, defect)).toBe(true)
})
