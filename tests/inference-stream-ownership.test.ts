import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream"
import { it as effectIt } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, ManagedRuntime } from "effect"
import { TestClock } from "effect/testing"
import { expect, it, vi } from "vitest"
import { initialTransition, transition } from "xstate"

import { accountCredentials } from "../src/inference/adapters/credentials-pi"
import { createAgentModels } from "../src/inference/adapters/models-pi"
import {
  PiModelRequest,
  PiModelStreams,
  piModelStreamsLayer,
  MAX_MODEL_STREAM_MILLIS,
} from "../src/inference/adapters/streams-pi"
import {
  modelStreamRequestMachine,
  modelStreamsMachine,
} from "../src/inference/model-stream.machine"
import { credential } from "./inference-fixture"

const gate = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const model = openaiProvider()
  .getModels()
  .find((value) => value.id === "gpt-6.1-sol")!
const message = fauxAssistantMessage("done")

it("shutdown joins an admitted refusal's completion callback", async () => {
  const runtime = ManagedRuntime.make(piModelStreamsLayer)
  const streams = runtime.runSync(PiModelStreams)
  const finishing = gate(),
    release = gate()
  const active = Array.from(
    { length: 16 },
    () =>
      new PiModelRequest(
        model,
        (request) => {
          const source = new AssistantMessageEventStream()
          request.signal.addEventListener(
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
  const refused = new PiModelRequest(
    model,
    () => {
      throw new Error("must not dispatch")
    },
    async () => {
      finishing.resolve()
      await release.promise
    }
  )
  let stopped = false
  try {
    for (const request of active) runtime.runSync(streams.start(request))
    runtime.runSync(streams.start(refused))
    await finishing.promise
    const shutdown = runtime
      .runPromiseExit(streams.shutdown())
      .then((value) => {
        stopped = true
        return value
      })
    await Promise.all(active.map((request) => request.settled))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(stopped).toBe(false)
    release.resolve()
    expect(Exit.isSuccess(await shutdown)).toBe(true)
    await refused.settled
  } finally {
    release.resolve()
    await runtime.dispose()
  }
})

it("joined iterator release keeps every original Cause reason", async () => {
  const runtime = ManagedRuntime.make(piModelStreamsLayer)
  const streams = runtime.runSync(PiModelStreams)
  const defect = new Error("native release failed")
  const failure = Cause.combine(
    Cause.fail("remote stop unconfirmed"),
    Cause.die(defect)
  )
  const source = new AssistantMessageEventStream()
  source[Symbol.asyncIterator] = () => ({
    next: async () => ({
      done: false,
      value: { type: "done", reason: "stop", message },
    }),
    return: async () => {
      throw failure
    },
    [Symbol.asyncIterator]() {
      return this
    },
  })
  const request = new PiModelRequest(
    model,
    () => source,
    () => {}
  )
  runtime.runSync(streams.start(request))
  try {
    const result = await request.stream.result().then(
      () => undefined,
      (cause: unknown) => cause
    )
    expect(
      Cause.isCause(result) &&
        result.reasons.some(
          (reason) =>
            (reason._tag === "Fail" &&
              reason.error === "remote stop unconfirmed") ||
            (reason._tag === "Die" &&
              typeof reason.defect === "object" &&
              reason.defect !== null &&
              "_tag" in reason.defect &&
              reason.defect._tag === "Fail" &&
              "error" in reason.defect &&
              reason.defect.error === "remote stop unconfirmed")
        )
    ).toBe(true)
    expect(
      Cause.isCause(result) &&
        result.reasons.some(
          (reason) => reason._tag === "Die" && reason.defect === defect
        )
    ).toBe(true)
  } finally {
    await Effect.runPromiseExit(runtime.disposeEffect)
  }
})

it("one request object has one native dispatch even when start is repeated", async () => {
  const runtime = ManagedRuntime.make(piModelStreamsLayer)
  const streams = runtime.runSync(PiModelStreams)
  const source = new AssistantMessageEventStream()
  source.push({ type: "done", reason: "stop", message })
  const dispatch = vi.fn(() => source)
  const finish = vi.fn()
  const request = new PiModelRequest(model, dispatch, finish)
  try {
    runtime.runSync(streams.start(request))
    runtime.runSync(streams.start(request))
    await request.stream.result()
    expect(dispatch).toHaveBeenCalledOnce()
    expect(finish).toHaveBeenCalledOnce()
  } finally {
    await runtime.dispose()
  }
})

it("a revoked request cannot acquire a native source while shutdown drains it", async () => {
  const runtime = ManagedRuntime.make(piModelStreamsLayer)
  const streams = runtime.runSync(PiModelStreams)
  const dispatch = vi.fn(() => new AssistantMessageEventStream())
  const request = new PiModelRequest(model, dispatch, () => {})
  try {
    request.interrupt()
    runtime.runSync(streams.start(request))
    await runtime.runPromise(streams.shutdown())
    expect(dispatch).not.toHaveBeenCalled()
    expect((await request.stream.result()).stopReason).toBe("aborted")
  } finally {
    await runtime.dispose()
  }
})

it("result-only draining cannot be stolen by a competing iterator", async () => {
  const runtime = ManagedRuntime.make(piModelStreamsLayer)
  const streams = runtime.runSync(PiModelStreams)
  const source = new AssistantMessageEventStream()
  const entered = gate()
  const request = new PiModelRequest(
    model,
    () => {
      entered.resolve()
      return source
    },
    () => {}
  )
  try {
    runtime.runSync(streams.start(request))
    const result = request.stream.result()
    await entered.promise
    await expect(request.stream[Symbol.asyncIterator]().next()).rejects.toThrow(
      "already has a consumer"
    )
    expect(request.signal.aborted).toBe(false)
    source.push({
      type: "done",
      reason: "stop",
      message: fauxAssistantMessage("complete"),
    })
    expect((await result).stopReason).toBe("stop")
  } finally {
    await runtime.dispose()
  }
})

it("runtime scope disposal joins a just-admitted request", async () => {
  const runtime = ManagedRuntime.make(piModelStreamsLayer)
  const streams = runtime.runSync(PiModelStreams)
  const dispatch = vi.fn(() => new AssistantMessageEventStream())
  const request = new PiModelRequest(model, dispatch, () => {})
  runtime.runSync(streams.start(request))
  await runtime.dispose()
  // The current Effect host starts admission synchronously. Disposal must join
  // that request and revoke its signal before returning.
  expect(dispatch).toHaveBeenCalledOnce()
  expect(request.signal.aborted).toBe(true)
  expect((await request.stream.result()).stopReason).toBe("aborted")
})

it("invalid admission events and unrelated releases cannot advance the owner", async () => {
  const launch = vi.fn(() => Effect.void)
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const actor = yield* createEffectActor(
          modelStreamsMachine({ maximum: 1, launch, abort: Effect.void })
        )
        actor.send({
          type: "START",
          task: { id: 1, run: () => Effect.void },
        } as unknown as Parameters<typeof actor.send>[0])
        yield* send(actor, {
          type: "START",
          task: { id: "valid", run: () => Effect.void },
        })
        yield* waitFor(actor, (state) => state.context.active.length === 1)
        yield* send(actor, {
          type: "RELEASE",
          id: "unrelated",
          exit: Exit.die("stale"),
        })
        yield* send(actor, { type: "CLOSE" })
        const state = yield* waitFor(actor, (state) =>
          state.matches("draining")
        )
        expect(state.context.active).toEqual([{ id: "valid", native: true }])
        expect(state.context.fatal).toBeUndefined()
        expect(launch).toHaveBeenCalledOnce()
      })
    )
  )
})

effectIt.effect(
  "the request deadline retains joined cleanup occupancy until release",
  () =>
    Effect.gen(function* () {
      const streams = yield* PiModelStreams
      const entered = Deferred.makeUnsafe<void>(),
        release = gate()
      const source = new AssistantMessageEventStream()
      source[Symbol.asyncIterator] = () => ({
        next: async () => ({
          done: false,
          value: {
            type: "done",
            reason: "stop",
            message: fauxAssistantMessage("done"),
          },
        }),
        return: async () => {
          Deferred.doneUnsafe(entered, Effect.void)
          await release.promise
          return { done: true, value: undefined }
        },
        [Symbol.asyncIterator]() {
          return this
        },
      })
      const request = new PiModelRequest(
        model,
        () => source,
        () => {}
      )
      yield* streams.start(request)
      yield* Deferred.await(entered)
      let settled = false
      void request.settled.then(() => {
        settled = true
      })
      yield* TestClock.adjust(MAX_MODEL_STREAM_MILLIS)
      expect(settled).toBe(false)
      release.resolve()
      const result = yield* Effect.promise(() => request.stream.result())
      expect(result.errorMessage).toContain("timed out")
    }).pipe(Effect.provide(piModelStreamsLayer))
)

it("overflow retains its diagnostic precedence while timed-out cleanup joins", () => {
  const machine = modelStreamRequestMachine({
    stopped: () => false,
    acquire: Effect.void,
    read: Effect.never,
    publish: Effect.succeed(true),
    close: Effect.never,
    abort: Effect.void,
    lifetime: 10,
  })
  const [initial] = initialTransition(machine)
  const [overflow] = transition(machine, initial, { type: "OVERFLOW" })
  const [expired] = transition(machine, overflow, { type: "EXPIRE" })
  expect(expired.matches("closing")).toBe(true)
  expect(expired.context.reason).toBe("overflow")
})

it.each(["compound", "ordinary"] as const)(
  "provider reader %s failure survives actual SDK normalization",
  async (kind) => {
    const runtime = ManagedRuntime.make(piModelStreamsLayer)
    const streams = runtime.runSync(PiModelStreams)
    const models = createAgentModels(
      accountCredentials(async () => credential),
      {
        start: (request) => runtime.runSync(streams.start(request)),
      }
    )
    const defect = new Error("reader defect")
    const failure =
      kind === "compound"
        ? Cause.combine(Cause.fail("reader unavailable"), Cause.die(defect))
        : new Error("network read failed")
    try {
      const result = await models
        .completeSimple(
          models.getModel("openai", "gpt-6.1-sol")!,
          {
            messages: [{ role: "user", content: "synthetic", timestamp: 0 }],
          },
          {
            reasoning: "medium",
            fetch: async () =>
              new Response(
                new ReadableStream({
                  pull(target) {
                    target.error(failure)
                  },
                }),
                { headers: { "content-type": "text/event-stream" } }
              ),
          }
        )
        .then(
          (value) => ({ value }),
          (cause: unknown) => ({ cause })
        )
      if (kind === "compound") {
        expect(
          "cause" in result &&
            Cause.isCause(result.cause) &&
            result.cause.reasons.some(
              (reason) => reason._tag === "Die" && reason.defect === defect
            )
        ).toBe(true)
      } else {
        expect("value" in result && result.value.stopReason).toBe("error")
        expect("value" in result && result.value.errorMessage).toContain(
          "network read failed"
        )
      }
    } finally {
      await Effect.runPromiseExit(runtime.disposeEffect)
    }
  }
)

it.each([false, true])(
  "owner shutdown preserves native interruption after joined provider cleanup (defect=%s)",
  async (cleanupFails) => {
    const runtime = ManagedRuntime.make(piModelStreamsLayer)
    const streams = runtime.runSync(PiModelStreams)
    const entered = gate(),
      cleaning = gate(),
      release = gate()
    const defect = new Error("late owned provider cleanup")
    const outcomes: string[] = []
    const models = createAgentModels(
      accountCredentials(async () => credential),
      {
        start: (request) => runtime.runSync(streams.start(request)),
        onAttempt: () => ({
          id: "owned-native-attempt",
          turnId: "turn",
          usage: async () => {},
          end: async (outcome) => {
            outcomes.push(outcome)
          },
        }),
      }
    )
    let returned = false
    const result = models
      .completeSimple(
        models.getModel("openai", "gpt-6.1-sol")!,
        {
          messages: [
            { role: "user", content: "held native provider", timestamp: 0 },
          ],
        },
        {
          reasoning: "medium",
          fetch: async () => {
            entered.resolve()
            return new Response(
              new ReadableStream<Uint8Array>({
                start: (target) =>
                  target.enqueue(
                    new TextEncoder().encode(
                      'data: {"type":"response.created","response":{"id":"held-response","model":"gpt-6.1-sol","status":"in_progress"}}\n\n'
                    )
                  ),
                cancel: async () => {
                  cleaning.resolve()
                  await release.promise
                  if (cleanupFails)
                    throw Cause.combine(
                      Cause.fail("cleanup unconfirmed"),
                      Cause.die(defect)
                    )
                },
              }),
              { headers: { "content-type": "text/event-stream" } }
            )
          },
        }
      )
      .then(
        (value) => {
          returned = true
          return { value }
        },
        (cause: unknown) => {
          returned = true
          return { cause }
        }
      )
    try {
      await entered.promise
      const shutdown = runtime.runPromiseExit(streams.shutdown())
      await cleaning.promise
      expect(returned).toBe(false)
      expect(outcomes).toEqual([])
      release.resolve()
      const stopped = await shutdown
      const settled = await result
      expect(
        "cause" in settled &&
          Cause.isCause(settled.cause) &&
          Cause.hasInterrupts(settled.cause)
      ).toBe(true)
      expect(outcomes).toEqual(["cancelled"])
      if (cleanupFails) {
        expect(
          "cause" in settled &&
            Cause.isCause(settled.cause) &&
            settled.cause.reasons.some(
              (reason) => reason._tag === "Die" && reason.defect === defect
            )
        ).toBe(true)
        expect(Exit.isFailure(stopped)).toBe(true)
      } else expect(Exit.isSuccess(stopped)).toBe(true)
    } finally {
      release.resolve()
      await result
      await Effect.runPromiseExit(runtime.disposeEffect)
    }
  }
)
