import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers"
import { Deferred, Effect, Exit, Schema } from "effect"

import { nativeOperation } from "../../shared/interop"
import { upstreamResponse, type UpstreamCorrelation } from "./upstream"

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
  readonly #abort = new AbortController()
  readonly #ready = Effect.runSync(Deferred.make<Response>())
  readonly #work: Promise<Exit.Exit<void>>

  constructor(
    request: Request,
    sink: WritableStream<Uint8Array>,
    correlation: UpstreamCorrelation,
    own: (task: Promise<void>) => void
  ) {
    super()
    const writer = sink.getWriter()
    let pending = 0
    let closed = false
    const mark = (stage: string) => {
      if (closed || pending >= 16) return
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
            closed = true
          }
        )
    }
    const program = Effect.gen({ self: this }, function* () {
      mark("dispatch")
      const response = yield* nativeOperation(
        (signal) => fetch(new Request(request, { signal, redirect: "manual" })),
        () => {
          throw new Error("Diagnostic upstream request failed")
        }
      )
      mark("headers")
      yield* upstreamResponse(response, this.#ready, mark)
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? Deferred.failCause(this.#ready, exit.cause).pipe(Effect.asVoid)
          : Effect.void
      ),
      Effect.scoped
    )
    this.#work = Effect.runPromiseExit(program, { signal: this.#abort.signal })
    own(this.#work.then(() => {}))
    // Diagnostic backpressure must never delay provider settlement. Retain
    // queued markers in a separately owned, bounded flush after inference ends.
    own(
      Effect.runPromiseExit(
        Effect.gen({ self: this }, function* () {
          const exit = yield* Effect.promise(() => this.#work)
          mark(Exit.isSuccess(exit) ? "complete" : "failed")
          yield* Effect.raceFirst(
            Effect.promise(() => writer.close().catch(() => {})),
            Effect.sleep(3000)
          )
        }).pipe(
          // Expiry closes observation only. The caller retains its ordinary
          // inference deadline and owns cancellation of the upstream pump.
          Effect.raceFirst(Effect.sleep(60_000)),
          Effect.ensuring(
            Effect.promise(async () => {
              closed = true
              await writer.abort().catch(() => {})
              writer.releaseLock()
            })
          )
        )
      ).then(() => {})
    )
  }

  response() {
    return Effect.runPromise(Deferred.await(this.#ready))
  }
  async cancel() {
    this.#abort.abort()
    await this.#work
  }
  [Symbol.dispose]() {
    this.#abort.abort()
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
  const remote = await relay.start(
    {
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      body: request.body,
    },
    sink,
    correlation
  )
  let closing: Promise<void> | undefined
  let reader: ReadableStreamDefaultReader<unknown> | undefined
  let reading: Promise<ReadableStreamReadResult<unknown>> | undefined
  let ended = false
  const close = () =>
    (closing ??= Promise.resolve().then(async () => {
      const acquired = reader
      const results = await Promise.allSettled([
        acquired && !ended ? acquired.cancel() : Promise.resolve(),
        remote.cancel(),
        reading?.then(
          () => {},
          () => {}
        ) ?? Promise.resolve(),
      ])
      try {
        acquired?.releaseLock()
      } finally {
        request.signal.removeEventListener("abort", abort)
        remote[Symbol.dispose]()
      }
      const failed = results.filter((result) => result.status === "rejected")
      if (failed.length)
        throw new AggregateError(
          failed.map((result): unknown => result.reason),
          "Upstream cleanup failed"
        )
    }))
  const abort = () => {
    void close().catch(() => {})
  }
  request.signal.addEventListener("abort", abort, { once: true })
  if (request.signal.aborted) abort()
  try {
    const response = await remote.response()
    // A late response acquired after pre-header cancellation still needs its
    // own release; the first cleanup may have completed without a reader.
    if (closing) {
      await response.body?.cancel()
      await closing
      request.signal.throwIfAborted()
      throw new Error("Upstream request already closed")
    }
    if (!response.body) {
      await close()
      return response
    }
    reader = response.body.getReader()
    const acquired = reader
    const body = new ReadableStream<Uint8Array>({
      type: "bytes",
      async pull(controller) {
        try {
          reading = acquired.read().catch((cause: unknown) => {
            ended = true
            throw cause
          })
          const next = await reading
          if (next.done) {
            ended = true
            await close()
            controller.close()
          } else
            controller.enqueue(
              Schema.decodeUnknownSync(Schema.Uint8Array)(next.value).slice()
            )
        } catch (cause) {
          try {
            await close()
          } finally {
            controller.error(cause)
          }
        }
      },
      cancel: () => close(),
    })
    return new Response(body, response)
  } catch (cause) {
    await close()
    throw cause
  }
}
