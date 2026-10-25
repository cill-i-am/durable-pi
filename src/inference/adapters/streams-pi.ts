import type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  Api,
} from "@earendil-works/pi-ai"
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream"
import { createEffectActor, waitFor, type EffectActor } from "@xstate/effect"
import {
  Cause,
  Clock,
  Context,
  Effect,
  Equal,
  Exit,
  Layer,
  Scope,
} from "effect"

import { fatalCause, orDieAll } from "../../shared/effect"
import {
  claimModelRequest,
  consumeModelStream,
  modelStreamRequestMachine,
  modelStreamsMachine,
  newModelRequestReservation,
  newModelStreamConsumer,
  type ModelStreamOutcome,
} from "../model-stream.machine"

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
  private outcome: ModelStreamOutcome = { reason: "ended" }
  private actor?: EffectActor<ReturnType<typeof modelStreamRequestMachine>>
  private readonly events: {
    type: "STOP" | "INTERRUPT" | "OVERFLOW" | "EXPIRE"
  }[] = []
  private iterator?: AsyncIterator<AssistantMessageEvent>
  private event?: AssistantMessageEvent
  private closing?: Promise<void>
  private reservation = newModelRequestReservation()
  readonly id = crypto.randomUUID()
  private maximumAt = Infinity
  claim(now: number) {
    const previous = this.reservation
    this.reservation = claimModelRequest(previous)
    if (previous === this.reservation) return false
    this.maximumAt = now + MAX_MODEL_STREAM_MILLIS
    return true
  }
  private send(type: "STOP" | "INTERRUPT" | "OVERFLOW" | "EXPIRE") {
    if (!this.actor) this.events.push({ type })
    else if (this.actor.getSnapshot().status === "active")
      this.actor.send({ type })
  }
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
    this.send("STOP")
    this.controller.abort()
  }
  interrupt() {
    this.send("INTERRUPT")
    this.controller.abort()
  }
  expire() {
    this.send("EXPIRE")
    this.controller.abort()
  }
  private retain(cause: Cause.Cause<unknown>) {
    if (this.retained.has(cause)) return
    this.retained.add(cause)
    if (Cause.hasDies(cause) || Cause.hasInterrupts(cause)) {
      const reasons = [
        ...(this.fatal?.reasons ?? []),
        ...fatalCause(cause).reasons,
      ]
      this.fatal = Cause.fromReasons(
        reasons.filter(
          (reason, index) =>
            !reasons
              .slice(0, index)
              .some((prior) => Equal.equals(prior, reason))
        )
      )
    }
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
            this.retain(
              fatalCause(Cause.isCause(cause) ? cause : Cause.die(cause))
            )
            failed = true
            failure = cause
          }
          try {
            reader.releaseLock()
          } catch (cause) {
            this.retain(
              fatalCause(Cause.isCause(cause) ? cause : Cause.die(cause))
            )
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
                if (Cause.isCause(cause)) this.retain(cause)
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
                this.send("OVERFLOW")
                this.controller.abort()
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
  private close() {
    return (this.closing ??= (async () => {
      this.controller.abort()
      // Late acquisition, SDK callbacks and native reads keep their ownership.
      while (this.pending.size) await Promise.allSettled([...this.pending])
      try {
        await this.iterator?.return?.()
      } catch (cause) {
        this.retain(fatalCause(Cause.isCause(cause) ? cause : Cause.die(cause)))
      }
      while (this.pending.size) await Promise.allSettled([...this.pending])
      await Promise.allSettled([...this.bodies].map((close) => close()))
    })())
  }
  private native<T>(start: () => Promise<T>): Effect.Effect<T> {
    return Effect.callback<T>((resume, signal) => {
      const abort = () => this.abort()
      signal.addEventListener("abort", abort, { once: true })
      const work = Promise.resolve().then(start)
      this.pending.add(work)
      work
        .then(
          (value) => resume(Effect.succeed(value)),
          (cause) => {
            const failure = Cause.isCause(cause) ? cause : Cause.die(cause)
            this.retain(failure)
            resume(Effect.failCause(failure).pipe(orDieAll))
          }
        )
        .finally(() => {
          this.pending.delete(work)
          signal.removeEventListener("abort", abort)
        })
      return Effect.promise(() =>
        work.then(
          () => undefined,
          () => undefined
        )
      )
    })
  }
  readonly effect = Effect.scoped(
    Effect.gen({ self: this }, function* () {
      const abort = () => this.abort()
      this.callerSignal?.addEventListener("abort", abort, { once: true })
      if (this.callerSignal?.aborted) this.abort()
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => this.close()).pipe(
          Effect.andThen(
            Effect.sync(() =>
              this.callerSignal?.removeEventListener("abort", abort)
            )
          )
        )
      )
      const now = yield* Clock.currentTimeMillis
      this.actor = yield* createEffectActor(
        modelStreamRequestMachine({
          stopped: () => this.signal.aborted,
          acquire: this.native(async () => {
            if (!this.signal.aborted)
              this.iterator = (await this.source(this))[Symbol.asyncIterator]()
          }),
          read: this.native(async () => {
            if (this.signal.aborted) return "ended" as const
            const next = await this.iterator!.next()
            if (next.done) return "ended" as const
            this.event = next.value
            if (next.value.type === "done" || next.value.type === "error") {
              this.terminal = next.value
              return "terminal" as const
            }
            return "event" as const
          }),
          publish: Effect.sync(() => this.stream.publish(this.event!)),
          close: Effect.promise(() => this.close()),
          abort: Effect.sync(() => this.controller.abort()),
          lifetime: Math.max(0, this.maximumAt - now),
        })
      )
      for (const event of this.events.splice(0)) this.actor.send(event)
      const settled = yield* waitFor(
        this.actor,
        (state) => state.status === "done"
      ).pipe(Effect.orDie)
      this.outcome = settled.output!
      if (Exit.isFailure(settled.output!.exit))
        this.retain(settled.output!.exit.cause)
    })
  ).pipe(
    Effect.onExit(() =>
      Effect.suspend(() =>
        this.fatal ? Effect.failCause(this.fatal).pipe(orDieAll) : Effect.void
      )
    )
  )
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
  private terminalEvent(exit: Exit.Exit<void>) {
    let event = this.terminal
    if (
      Exit.isFailure(exit) ||
      !event ||
      this.outcome.reason === "overflow" ||
      this.outcome.reason === "expired" ||
      this.outcome.reason === "cancelled" ||
      this.callerSignal?.aborted
    ) {
      const aborted =
        this.outcome.reason !== "overflow" &&
        this.outcome.reason !== "expired" &&
        (this.outcome.reason === "cancelled" ||
          this.callerSignal?.aborted ||
          (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)))
      const message = failedMessage(
        this.model,
        !!aborted,
        this.outcome.reason === "overflow"
          ? "Provider stream exceeded the supported buffer or response size."
          : this.outcome.reason === "expired"
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
    return event
  }
  private async finish(exit: Exit.Exit<void>): Promise<Exit.Exit<void>> {
    const event = this.terminalEvent(exit)
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
  private consumer = newModelStreamConsumer()
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
    const admission = consumeModelStream(this.consumer, "ITERATE")
    this.consumer = admission.state
    if (!admission.commands.includes("ITERATE"))
      throw new Error("This model stream already has a consumer.")
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
      this.consumer = consumeModelStream(this.consumer, "RELEASE").state
      this.request.abort()
      await this.join()
    }
  }
  override async result(): Promise<AssistantMessage> {
    const admission = consumeModelStream(this.consumer, "RESULT")
    this.consumer = admission.state
    if (admission.commands.includes("DRAIN")) {
      this.resultDrain = (async () => {
        const iterator = super[Symbol.asyncIterator]()
        for (;;) {
          const next = await iterator.next()
          if (next.done) break
          this.queued = Math.max(0, this.queued - 1)
        }
      })().finally(() => {
        this.consumer = consumeModelStream(this.consumer, "RELEASE").state
      })
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
    // Keep queued admissions launchable while the layer's finalizer drains them.
    // The resource scope closes only after shutdown and the owner actor join.
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer((exit) => Scope.close(scope, exit))
    const active = new Map<string, PiModelRequest>()
    const owner = yield* createEffectActor(
      modelStreamsMachine({
        maximum: MAX_ACTIVE_MODEL_STREAMS,
        abort: Effect.sync(() => {
          for (const request of active.values()) request.interrupt()
        }),
        launch: (task, refusal) =>
          Effect.forkIn(
            task.run(refusal).pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  active.delete(task.id)
                  owner.send({ type: "RELEASE", id: task.id, exit })
                })
              )
            ),
            scope
          ).pipe(Effect.asVoid),
      })
    )
    const shutdown = () =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          owner.send({ type: "CLOSE" })
          const stopped = yield* waitFor(
            owner,
            (state) =>
              state.matches("draining") && state.context.active.length === 0
          ).pipe(Effect.orDie)
          if (stopped.context.fatal)
            return yield* Effect.failCause(stopped.context.fatal)
        })
      )
    yield* Effect.addFinalizer(shutdown)
    return PiModelStreams.of({
      shutdown,
      start: (request) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            Effect.sync(() => {
              if (!request.claim(now)) return
              active.set(request.id, request)
              owner.send({
                type: "START",
                task: {
                  id: request.id,
                  run: (refusal) =>
                    refusal
                      ? request.decline(refusal)
                      : request.effect.pipe(
                          Effect.onExit((exit) => request.complete(exit))
                        ),
                },
              })
            })
          )
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
