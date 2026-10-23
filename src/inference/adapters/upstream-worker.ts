import { createEffectActor, waitFor } from "@xstate/effect"
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers"
import { Cause, Deferred, Effect, Exit, Schema, Scope } from "effect"

import { fatalCause } from "../../shared/effect"
import { nativeOperation } from "../../shared/interop"
import { joinUpstreamCleanup } from "../upstream-cleanup"
import {
  upstreamClientMachine,
  upstreamMarkersMachine,
  upstreamRelayMachine,
} from "../upstream.machine"
import {
  upstreamNativeCancellation,
  upstreamResponse,
  type UpstreamCorrelation,
} from "./upstream"

interface UpstreamRequestData {
  url: string
  method: string
  headers: [string, string][]
  body: ReadableStream<Uint8Array> | null
}

/** Internal loopback capability only: no HTTP handler or arbitrary proxy URL. */
export class UpstreamRelay extends WorkerEntrypoint {
  start(
    input: UpstreamRequestData,
    sink: WritableStream<Uint8Array>,
    correlation: UpstreamCorrelation
  ) {
    // AbortSignal is deliberately not serialized. The returned RPC target
    // owns a cancellation capability, including the wait before headers.
    const request = new Request(input.url, input)
    const url = new URL(request.url)
    if (
      request.method !== "POST" ||
      url.origin !== "https://api.openai.com" ||
      url.pathname !== "/v1/responses" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Unsupported diagnostic provider request")
    return new UpstreamRequest(request, sink, correlation, (task) =>
      this.ctx.waitUntil(task)
    )
  }
}

class UpstreamRequest extends RpcTarget {
  readonly #ready = Effect.runSync(Deferred.make<Response>())
  readonly #work: Promise<Exit.Exit<void, unknown>>
  readonly #cancel: () => Promise<void>

  constructor(
    request: Request,
    sink: WritableStream<Uint8Array>,
    correlation: UpstreamCorrelation,
    own: (task: Promise<void>) => void
  ) {
    super()
    const writer = sink.getWriter()
    let pending = 0
    const completed = Effect.runSync(Deferred.make<Exit.Exit<void, unknown>>())
    let markerActor:
      | {
          getSnapshot: () => {
            matches: (state: "observing" | "flushing") => boolean
          }
          send: (event: { type: "CLOSE" }) => void
        }
      | undefined
    const mark = (stage: string) => {
      if (!markerActor?.getSnapshot().matches("observing") || pending >= 16)
        return
      pending++
      void writer
        .write(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ stage, ...correlation })}\n\n`
          )
        )
        .then(
          () => {
            pending--
          },
          () => {
            pending--
            markerActor?.send({ type: "CLOSE" })
          }
        )
    }
    // The observation machine owns flush/expiry only; its failure cannot Stop
    // or delay provider inference. Pending marker count is just a buffer bound.
    const markersReady = Effect.runSync(Deferred.make<void>())
    own(
      Effect.runPromiseExit(
        Effect.gen(function* () {
          const actor = yield* createEffectActor(
            upstreamMarkersMachine({
              completion: Deferred.await(completed).pipe(
                Effect.tap((exit) =>
                  Effect.sync(() =>
                    mark(Exit.isSuccess(exit) ? "complete" : "failed")
                  )
                ),
                Effect.asVoid
              ),
              flush: Effect.promise(() => writer.close()),
              close: Effect.promise(async () => {
                try {
                  await writer.abort().catch(() => {})
                } finally {
                  writer.releaseLock()
                }
              }),
            })
          )
          markerActor = actor
          yield* Deferred.succeed(markersReady, undefined)
          yield* waitFor(actor, (state) => state.status === "done").pipe(
            Effect.orDie
          )
        }).pipe(Effect.scoped)
      ).then(() => {})
    )
    let closeRequest!: () => void
    let ready!: () => void
    const actorReady = new Promise<void>((resolve) => {
      ready = resolve
    })
    const program = Effect.gen({ self: this }, function* () {
      yield* Deferred.await(markersReady)
      // These are joined invocation receipts, not another lifecycle owner.
      let settlement: Deferred.Deferred<Exit.Exit<unknown, unknown>> | undefined
      const observed = <A>(work: Effect.Effect<A, unknown, Scope.Scope>) =>
        Effect.gen(function* () {
          const done = yield* Deferred.make<Exit.Exit<unknown, unknown>>()
          settlement = done
          return yield* work.pipe(
            Effect.scoped,
            Effect.onExit((exit) =>
              Deferred.succeed(done, exit).pipe(Effect.asVoid)
            )
          )
        })
      const actor = yield* createEffectActor(
        upstreamRelayMachine({
          fetch: observed(
            Effect.gen(function* () {
              mark("dispatch")
              return yield* nativeOperation(
                (signal) =>
                  fetch(
                    new Request(request, { signal, redirect: "manual" })
                  ).catch((cause: unknown) => {
                    if (signal.aborted && upstreamNativeCancellation(cause))
                      throw Cause.interrupt()
                    throw cause
                  }),
                (cause, channel) => {
                  if (channel === "failure") return cause
                  throw new Error("Diagnostic upstream request failed")
                }
              )
            })
          ),
          relay: (response) =>
            observed(
              Effect.gen({ self: this }, function* () {
                mark("headers")
                yield* upstreamResponse(response, this.#ready, mark)
              })
            ),
          close: Effect.gen({ self: this }, function* () {
            const exit = settlement
              ? yield* Deferred.await(settlement)
              : Exit.void
            // A caller awaiting headers must also settle when Stop won dispatch.
            yield* Deferred.failCause(
              this.#ready,
              Cause.die(new Error("Upstream request closed"))
            )
            if (Exit.isFailure(exit)) {
              const reasons = exit.cause.reasons.filter(
                (reason) => reason._tag !== "Interrupt"
              )
              if (reasons.length)
                return yield* Effect.failCause(Cause.fromReasons(reasons))
            }
          }),
        })
      )
      closeRequest = () => {
        if (actor.getSnapshot().status !== "done") actor.send({ type: "CLOSE" })
      }
      ready()
      const done = yield* waitFor(
        actor,
        (state) => state.status === "done"
      ).pipe(Effect.orDie)
      yield* done.output!
    }).pipe(
      Effect.scoped,
      Effect.onExit((exit) =>
        Deferred.failCause(
          this.#ready,
          Exit.isFailure(exit)
            ? fatalCause(exit.cause)
            : Cause.die(new Error("Upstream request closed"))
        ).pipe(Effect.asVoid)
      )
    )
    this.#work = Effect.runPromiseExit(program)
    this.#cancel = async () => {
      await actorReady
      closeRequest()
      const exit = await this.#work
      if (
        Exit.isFailure(exit) &&
        exit.cause.reasons.some((reason) => reason._tag !== "Interrupt")
      )
        throw exit.cause
    }
    own(
      this.#work.then((exit) => {
        Deferred.doneUnsafe(completed, Effect.succeed(exit))
      })
    )
  }
  response() {
    return Effect.runPromise(Deferred.await(this.#ready))
  }
  cancel() {
    return this.#cancel()
  }
  [Symbol.dispose]() {
    void this.#cancel().catch(() => {})
  }
}

export interface UpstreamRequestHandle {
  response(): PromiseLike<Response>
  cancel(): PromiseLike<void>
  [Symbol.dispose](): void
}
export interface UpstreamRelayBinding {
  start(
    input: UpstreamRequestData,
    sink: WritableStream<Uint8Array>,
    correlation: UpstreamCorrelation
  ): PromiseLike<UpstreamRequestHandle>
}

/** Keep the remote request owned through EOF, body cancellation and abort
 * before headers. Disposing the RPC target also aborts a disconnected caller. */
export async function observedUpstreamFetch(
  relay: UpstreamRelayBinding,
  request: Request,
  sink: WritableStream<Uint8Array>,
  correlation: UpstreamCorrelation
): Promise<Response> {
  const scope = Effect.runSync(Scope.make())
  let remoteTask: Promise<UpstreamRequestHandle> | undefined
  let headers: Promise<Response> | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let reading: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
  const actor = await Effect.runPromise(
    createEffectActor(
      upstreamClientMachine({
        acquire: Effect.promise(
          () =>
            (remoteTask = Promise.resolve(
              relay.start(
                {
                  url: request.url,
                  method: request.method,
                  headers: [...request.headers],
                  body: request.body,
                },
                sink,
                correlation
              )
            ))
        ),
        headers: Effect.promise(async () => {
          const remote = await remoteTask!
          return await (headers = Promise.resolve(remote.response()))
        }),
        close: nativeOperation(
          async () => {
            if (!remoteTask) return
            const remote = await remoteTask
            // Remote Stop starts before waiting for headers or a held local reader.
            const cancellation = Promise.resolve().then(() => remote.cancel())
            const release = (async () => {
              const response = await (headers ??= Promise.resolve().then(() =>
                remote.response()
              )).catch(() => undefined)
              if (reader) await reader.cancel()
              else await response?.body?.cancel()
            })()
            await joinUpstreamCleanup(
              [cancellation, release, reading ?? Promise.resolve()],
              [() => reader?.releaseLock(), () => remote[Symbol.dispose]()]
            )
          },
          (cause) => cause
        ),
      })
    ).pipe(Effect.provideService(Scope.Scope, scope))
  )
  const work = Effect.runPromiseExit(
    waitFor(actor, (state) => state.status === "done").pipe(
      Effect.orDie,
      Effect.flatMap((state) => state.output!),
      Effect.ensuring(Scope.close(scope, Exit.void))
    )
  )
  const close = async () => {
    if (actor.getSnapshot().status !== "done") actor.send({ type: "CLOSE" })
    const exit = await work
    if (Exit.isFailure(exit)) throw exit.cause
  }
  const abort = () => {
    void close().catch(() => {})
  }
  request.signal.addEventListener("abort", abort, { once: true })
  void work.then(() => request.signal.removeEventListener("abort", abort))
  if (request.signal.aborted) abort()
  try {
    const state = await Effect.runPromise(
      waitFor(
        actor,
        (state) => state.matches("streaming") || state.status === "done"
      )
    )
    if (request.signal.aborted) {
      await close()
      request.signal.throwIfAborted()
    }
    if (state.status === "done") {
      await close()
      request.signal.throwIfAborted()
      if (state.context.response) return state.context.response
      throw new Error("Upstream request already closed")
    }
    const response = state.context.response!
    reader = response.body!.getReader()
    const acquired = reader
    const body = new ReadableStream<Uint8Array>({
      type: "bytes",
      async pull(controller) {
        try {
          const next = await (reading = acquired.read())
          if (next.done) {
            await close()
            controller.close()
          } else
            controller.enqueue(
              Schema.decodeUnknownSync(Schema.Uint8Array)(next.value).slice()
            )
        } catch (cause) {
          try {
            await joinUpstreamCleanup([Promise.reject(cause), close()])
          } catch (failure) {
            controller.error(failure)
          }
        }
      },
      cancel: close,
    })
    return new Response(body, response)
  } catch (cause) {
    await joinUpstreamCleanup([Promise.reject(cause), close()])
    throw cause
  }
}
