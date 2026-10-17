import type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  Api,
} from "@earendil-works/pi-ai"
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream"
import { Cause, Context, Effect, Exit, Fiber, Layer } from "effect"

import { fatalCause, orDieAll } from "../../shared/effect"

export const MAX_PROVIDER_BYTES = 16 * 1024 * 1024
export const MAX_PENDING_MODEL_EVENTS = 128
export const MAX_MODEL_STREAM_MILLIS = 600_000
const MAX_ACTIVE_MODEL_STREAMS = 16

const failedMessage = (
  model: Model<Api>,
  aborted: boolean,
  message: string
): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: aborted ? "aborted" : "error",
  errorMessage: message,
  timestamp: Date.now(),
})

/** The SDK owns its protocol and normalization. This adapter owns the foreign
 * work, returned queue and reader cleanup that the SDK's Promise facade hides. */
export class PiModelRequest {
  private readonly controller = new AbortController()
  readonly signal = this.controller.signal
  private readonly pending = new Set<Promise<unknown>>()
  private readonly bodies = new Set<() => Promise<void>>()
  private fatal?: Cause.Cause<unknown>
  private readonly retained = new Set<Cause.Cause<unknown>>()
  private terminal?: Extract<AssistantMessageEvent, { type: "done" | "error" }>
  private overflow = false
  private expired = false
  private resolve!: (exit: Exit.Exit<void>) => void
  readonly settled = new Promise<Exit.Exit<void>>((resolve) => {
    this.resolve = resolve
  })
  readonly stream: OwnedModelStream
  constructor(
    readonly model: Model<Api>,
    private readonly source: (
      request: PiModelRequest
    ) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
    private readonly finished: (
      event: Extract<AssistantMessageEvent, { type: "done" | "error" }>
    ) => void | Promise<void>,
    private readonly callerSignal?: AbortSignal
  ) {
    this.stream = new OwnedModelStream(this)
  }
  abort() {
    this.controller.abort()
  }
  expire() {
    this.expired = true
    this.abort()
  }
  private retain(cause: Cause.Cause<unknown>) {
    if (this.retained.has(cause)) return
    this.retained.add(cause)
    if (Cause.hasDies(cause) || Cause.hasInterrupts(cause))
      this.fatal = this.fatal ? Cause.combine(this.fatal, cause) : cause
  }
  async callback<T>(start: () => Promise<T>): Promise<T> {
    const work = Promise.resolve().then(() => {
      this.signal.throwIfAborted()
      return start()
    })
    this.pending.add(work)
    try {
      return await work
    } catch (cause) {
      if (Cause.isCause(cause)) this.retain(cause)
      throw cause
    } finally {
      this.pending.delete(work)
    }
  }
  async fetch(
    input: RequestInfo | URL,
    options: RequestInit | undefined,
    fetcher: typeof fetch
  ): Promise<Response> {
    return this.callback(async () => {
      const response = await fetcher(input, {
        ...options,
        signal: options?.signal
          ? AbortSignal.any([this.signal, options.signal])
          : this.signal,
      })
      if (!response.body) return response
      const reader = response.body.getReader()
      let ended = false,
        bytes = 0
      let reading: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
      let closing: Promise<void> | undefined
      const close = (): Promise<void> =>
        (closing ??= (async () => {
          let failed = false,
            failure: unknown
          try {
            const results = await Promise.allSettled([
              ended ? Promise.resolve() : reader.cancel(),
              reading?.then(
                () => undefined,
                () => undefined
              ) ?? Promise.resolve(),
            ])
            if (results[0].status === "rejected") throw results[0].reason
          } catch (cause) {
            this.retain(Cause.die(cause))
            failed = true
            failure = cause
          }
          try {
            reader.releaseLock()
          } catch (cause) {
            this.retain(Cause.die(cause))
            if (!failed) failure = cause
            failed = true
          }
          this.bodies.delete(close)
          if (failed) throw failure
        })())
      this.bodies.add(close)
      const body = new ReadableStream<Uint8Array>(
        {
          pull: async (target) => {
            try {
              reading = reader.read()
              const next = await reading.catch((cause) => {
                ended = true
                throw cause
              })
              if (next.done) {
                ended = true
                target.close()
                await close()
                return
              }
              bytes += next.value.byteLength
              if (bytes > MAX_PROVIDER_BYTES) {
                this.overflow = true
                this.abort()
                throw new Error("Provider response exceeded the supported size")
              }
              target.enqueue(next.value)
            } catch (cause) {
              target.error(cause)
            }
          },
          cancel: close,
        },
        { highWaterMark: 0 }
      )
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    })
  }
  private async close() {
    // A native SDK may stop awaiting credentials/fetch after abort. Their late
    // results still belong to this request, including newly acquired bodies.
    this.abort()
    while (this.pending.size) await Promise.allSettled([...this.pending])
    await Promise.allSettled([...this.bodies].map((close) => close()))
  }
  readonly effect = Effect.callback<void>((resume, signal) => {
    const abort = () => this.abort()
    signal.addEventListener("abort", abort, { once: true })
    this.callerSignal?.addEventListener("abort", abort, { once: true })
    if (signal.aborted || this.callerSignal?.aborted) this.abort()
    const work = (async () => {
      let iterator: AsyncIterator<AssistantMessageEvent> | undefined
      try {
        if (this.signal.aborted) return
        iterator = (await this.source(this))[Symbol.asyncIterator]()
        for (;;) {
          const next = await iterator.next()
          if (next.done) break
          const event = next.value
          if (event.type === "done" || event.type === "error") {
            this.terminal = event
            break
          }
          if (!this.stream.publish(event)) {
            this.overflow = true
            this.abort()
            break
          }
        }
      } catch (cause) {
        this.retain(Cause.isCause(cause) ? cause : Cause.die(cause))
      } finally {
        this.abort()
        // Return is a native resource operation too; never drop a failed release.
        try {
          await iterator?.return?.()
        } catch (cause) {
          this.retain(Cause.die(cause))
        }
        await this.close()
        signal.removeEventListener("abort", abort)
        this.callerSignal?.removeEventListener("abort", abort)
      }
    })()
    work.then(
      () =>
        resume(
          this.fatal ? Effect.failCause(this.fatal).pipe(orDieAll) : Effect.void
        ),
      (cause) => resume(Effect.die(cause))
    )
    return Effect.promise(() => work).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          this.fatal ? Effect.failCause(this.fatal).pipe(orDieAll) : Effect.void
        )
      )
    )
  })
  private completion?: Promise<Exit.Exit<void>>
  complete(exit: Exit.Exit<void>): Effect.Effect<void> {
    return Effect.callback<void>((resume) => {
      const work = (this.completion ??= this.finish(exit))
      work.then(
        (settled) =>
          resume(
            Exit.isFailure(settled)
              ? Effect.failCause(settled.cause)
              : Effect.void
          ),
        (cause) => resume(Effect.die(cause))
      )
      return Effect.promise(() => work).pipe(Effect.asVoid)
    })
  }
  private async finish(exit: Exit.Exit<void>): Promise<Exit.Exit<void>> {
    let event = this.terminal
    if (
      Exit.isFailure(exit) ||
      !event ||
      this.overflow ||
      this.expired ||
      this.callerSignal?.aborted
    ) {
      const aborted =
        !this.overflow &&
        !this.expired &&
        (this.callerSignal?.aborted ||
          (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)))
      const message = failedMessage(
        this.model,
        !!aborted,
        this.overflow
          ? "Provider stream exceeded the supported buffer or response size."
          : this.expired
            ? "The provider request timed out."
            : aborted
              ? "The model request was cancelled."
              : "The provider stream ended before completion."
      )
      event = {
        type: "error",
        reason: message.stopReason === "aborted" ? "aborted" : "error",
        error: message,
      }
    }
    let completion: Exit.Exit<void> = Exit.void
    try {
      await this.finished(event)
    } catch (cause) {
      completion = Exit.failCause(
        fatalCause(Cause.isCause(cause) ? cause : Cause.die(cause))
      )
    } finally {
      const settled = Exit.isFailure(completion)
        ? Exit.isFailure(exit)
          ? Exit.failCause(Cause.combine(exit.cause, completion.cause))
          : completion
        : exit
      this.resolve(settled)
      this.stream.finish(event)
    }
    return completion
  }
  decline(reason: string) {
    const message = failedMessage(this.model, false, reason)
    this.terminal = { type: "error", reason: "error", error: message }
    return this.complete(Exit.void)
  }
}

class OwnedModelStream extends AssistantMessageEventStream {
  private queued = 0
  private consuming = false
  private resultDrain?: Promise<void>
  constructor(private readonly request: PiModelRequest) {
    super()
  }
  publish(event: AssistantMessageEvent) {
    if (this.queued >= MAX_PENDING_MODEL_EVENTS) return false
    this.queued++
    super.push(event)
    return true
  }
  finish(event: AssistantMessageEvent) {
    super.push(event)
    super.end()
  }
  private async join() {
    const exit = await this.request.settled
    if (Exit.isFailure(exit)) throw exit.cause
  }
  override async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
    this.consuming = true
    try {
      const iterator = super[Symbol.asyncIterator]()
      for (;;) {
        const next = await iterator.next()
        if (next.done) break
        this.queued = Math.max(0, this.queued - 1)
        yield next.value
      }
      await this.join()
    } finally {
      this.request.abort()
      await this.join()
    }
  }
  override async result(): Promise<AssistantMessage> {
    if (!this.consuming) {
      this.consuming = true
      this.resultDrain = (async () => {
        const iterator = super[Symbol.asyncIterator]()
        for (;;) {
          const next = await iterator.next()
          if (next.done) break
          this.queued = Math.max(0, this.queued - 1)
        }
      })()
    }
    const value = await super.result()
    await this.join()
    await this.resultDrain
    return value
  }
}

export class PiModelStreams extends Context.Service<
  PiModelStreams,
  {
    start: (request: PiModelRequest) => Effect.Effect<void>
    shutdown: () => Effect.Effect<void>
  }
>()("durable-pi/inference/PiModelStreams") {}

export const piModelStreamsLayer = Layer.effect(
  PiModelStreams,
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const active = new Set<{ fiber?: Fiber.Fiber<void> }>()
    let closed = false,
      fatal: Cause.Cause<never> | undefined
    const shutdown = () =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          closed = true
          yield* Effect.forEach(
            [...active],
            (entry) =>
              entry.fiber ? Fiber.interrupt(entry.fiber) : Effect.void,
            { concurrency: "unbounded" }
          )
          if (fatal) return yield* Effect.failCause(fatal)
        })
      )
    yield* Effect.addFinalizer(shutdown)
    return PiModelStreams.of({
      shutdown,
      start: (request) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (closed || active.size >= MAX_ACTIVE_MODEL_STREAMS) {
              yield* Effect.forkIn(
                request.decline(
                  closed
                    ? "Model requests are currently unavailable."
                    : "Too many model requests are active. Wait for some work to finish."
                ),
                scope
              )
              return
            }
            const entry: { fiber?: Fiber.Fiber<void> } = {}
            active.add(entry)
            entry.fiber = yield* Effect.forkIn(
              Effect.scoped(
                Effect.gen(function* () {
                  const deadline = yield* Effect.forkScoped(
                    Effect.sleep(MAX_MODEL_STREAM_MILLIS).pipe(
                      Effect.andThen(Effect.sync(() => request.expire()))
                    )
                  )
                  yield* request.effect.pipe(
                    Effect.ensuring(Fiber.interrupt(deadline))
                  )
                })
              ).pipe(
                Effect.onExit((exit) => request.complete(exit)),
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    active.delete(entry)
                    if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) {
                      closed = true
                      fatal = fatal
                        ? Cause.combine(fatal, exit.cause)
                        : exit.cause
                    }
                  })
                )
              ),
              scope
            )
          })
        ),
    })
  })
)

/** Use at a genuine SDK callback to keep a failed Exit intact across its
 * Promise API. The request retains it before the SDK normalizes its error. */
export async function modelCallback<T, TError>(
  work: Promise<Exit.Exit<T, TError>>
): Promise<T> {
  const exit = await work
  if (Exit.isSuccess(exit)) return exit.value
  throw exit.cause
}
