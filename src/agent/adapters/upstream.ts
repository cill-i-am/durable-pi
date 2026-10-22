import { Deferred, Effect } from "effect"

import type { UpstreamObservationPeer } from "../../inference/adapters/upstream"

/** This byte channel is created in the gateway, before model dispatch. Both
 * its lifetime and the actor's unused one-shot lease are bounded to a minute. */
export const upstreamDiagnostic = Effect.fn("Agent.upstreamDiagnostic")(
  function* (
    peer: UpstreamObservationPeer,
    request: Request,
    own: (task: Promise<void>) => void
  ) {
    const id = crypto.randomUUID()
    const pipe = new IdentityTransformStream()
    const reader = pipe.readable.getReader()
    const ended = yield* Deferred.make<void>()
    const finish = () => Deferred.doneUnsafe(ended, Effect.void)
    let handedOff = false
    let admission: Promise<boolean> | undefined
    let task: Promise<unknown> | undefined
    let releasing: Promise<void> | undefined
    let heartbeat: (() => void) | undefined
    const release = () =>
      (releasing ??= Promise.resolve().then(async () => {
        // An unused transferred writable needs its actor owner to abort it while
        // the gateway cancels the reader. Neither release may wait for the other.
        const settled = await Promise.allSettled([
          reader.cancel(),
          peer.releaseUpstream(id),
        ])
        reader.releaseLock()
        if (settled[1].status === "rejected") throw settled[1].reason
      }))
    yield* Effect.addFinalizer(() =>
      handedOff
        ? Effect.void
        : Effect.promise(async () => {
            await admission?.catch(() => {})
            finish()
            await release()
            await task
          })
    )
    const admitted = yield* Effect.promise(
      () => (admission = peer.observeUpstream(id, pipe.writable))
    )
    if (!admitted) {
      yield* Effect.promise(() => reader.cancel())
      return new Response("Diagnostic already active", { status: 429 })
    }
    const work = Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* Effect.forever(
          Effect.sleep(1000).pipe(
            Effect.andThen(
              Effect.sync(() => {
                try {
                  heartbeat?.()
                } catch {
                  finish()
                }
              })
            )
          )
        ).pipe(Effect.forkScoped)
        yield* Effect.raceFirst(Deferred.await(ended), Effect.sleep(60_000))
      }).pipe(Effect.scoped, Effect.ensuring(Effect.promise(release))),
      { signal: request.signal }
    )
    task = work
    own(work.then(() => {}))
    const body = new ReadableStream<Uint8Array>({
      type: "bytes",
      start(controller) {
        heartbeat = () => {
          if ((controller.desiredSize ?? -1) >= 0)
            controller.enqueue(
              new TextEncoder().encode(": upstream heartbeat\n\n")
            )
        }
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ stage: "ready", id })}\n\n`
          )
        )
      },
      async pull(controller) {
        try {
          const next = await reader.read()
          if (next.done) {
            finish()
            await work
            controller.close()
          } else controller.enqueue(next.value.slice())
        } catch (cause) {
          finish()
          await work
          controller.error(cause)
        }
      },
      async cancel() {
        finish()
        await work
      },
    })
    const response = new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "private, no-store",
        "x-accel-buffering": "no",
      },
    })
    handedOff = true
    return response
  }
)
