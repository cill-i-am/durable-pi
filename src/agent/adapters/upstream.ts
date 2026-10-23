import { createEffectActor, waitFor } from "@xstate/effect"
import { Effect, Exit, Scope, Semaphore } from "effect"

import type { UpstreamObservationPeer } from "../../inference/adapters/upstream"
import { joinUpstreamCleanup } from "../../inference/upstream-cleanup"
import { orDieAll } from "../../shared/effect"
import { nativeOperation } from "../../shared/interop"
import {
  upstreamDiagnosticMachine,
  upstreamObserverMachine,
} from "../upstream.machine"

/** The gateway owns this scope through admission; HANDOFF transfers it to the
 * response and retained work. Cancellation always joins the original admission. */
export const upstreamDiagnostic = Effect.fn("Agent.upstreamDiagnostic")(
  function* (
    peer: UpstreamObservationPeer,
    request: Request,
    own: (task: Promise<void>) => void
  ) {
    const id = crypto.randomUUID()
    const pipe = new IdentityTransformStream()
    const reader = pipe.readable.getReader()
    const scope = yield* Scope.make()
    let admission: Promise<boolean> | undefined
    const actor = yield* createEffectActor(
      upstreamDiagnosticMachine({
        admit: Effect.promise(
          () => (admission = peer.observeUpstream(id, pipe.writable))
        ),
        close: nativeOperation(
          async () => {
            // Reader cancellation can unblock admission itself. Start it now;
            // the original admission still fences release of the remote lease.
            const cancelling = Promise.resolve().then(() => reader.cancel())
            const releasing = (async () => {
              const admitted = await Promise.allSettled(
                admission ? [admission] : []
              )
              const failed = admitted.flatMap((result) =>
                result.status === "rejected"
                  ? [Promise.reject(result.reason)]
                  : []
              )
              await joinUpstreamCleanup([
                ...failed,
                Promise.resolve().then(() => peer.releaseUpstream(id)),
              ])
            })()
            await joinUpstreamCleanup(
              [cancelling, releasing],
              [() => reader.releaseLock()]
            )
          },
          (cause) => cause
        ),
      })
    ).pipe(Effect.provideService(Scope.Scope, scope))
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
    own(
      work.then(() => {
        request.signal.removeEventListener("abort", abort)
      })
    )
    yield* Effect.addFinalizer((exit) =>
      Exit.isFailure(exit) || !actor.getSnapshot().matches("streaming")
        ? nativeOperation(close, (cause) => cause).pipe(orDieAll)
        : Effect.void
    )
    if (request.signal.aborted) abort()
    const ready = yield* waitFor(
      actor,
      (state) => state.matches("ready") || state.status === "done"
    ).pipe(Effect.orDie)
    if (ready.status === "done") {
      yield* ready.output!
      return new Response("Diagnostic already active", { status: 429 })
    }
    const body = new ReadableStream<Uint8Array>({
      type: "bytes",
      start(controller) {
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
            await close()
            controller.close()
          } else controller.enqueue(next.value.slice())
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
    actor.send({ type: "HANDOFF" })
    yield* waitFor(
      actor,
      (state) => state.matches("streaming") || state.status === "done"
    ).pipe(Effect.orDie)
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "private, no-store",
        "x-accel-buffering": "no",
      },
    })
  },
  orDieAll
)

/** A single actor owns admission, claim, expiry and joined release. The mutex
 * protects request/reply observation of the mailbox, not lease authority. */
export const makeUpstreamObserver = Effect.gen(function* () {
  const scope = yield* Scope.make()
  const actor = yield* createEffectActor(
    upstreamObserverMachine({
      release: (sink) =>
        sink
          ? nativeOperation(
              () => sink.abort(),
              (cause) => cause
            )
          : Effect.void,
    })
  ).pipe(Effect.provideService(Scope.Scope, scope))
  const gate = Semaphore.makeUnsafe(1)
  const settle = waitFor(
    actor,
    (state) => state.matches("idle") || state.matches("closed")
  ).pipe(Effect.orDie)
  const shutdown = gate
    .withPermit(
      Effect.gen(function* () {
        if (!actor.getSnapshot().matches("closed"))
          actor.send({ type: "CLOSE" })
        const state = yield* waitFor(actor, (state) =>
          state.matches("closed")
        ).pipe(Effect.orDie)
        yield* state.context.outcome
      })
    )
    .pipe(
      Effect.ensuring(Scope.close(scope, Exit.void)),
      Effect.uninterruptible
    )
  yield* Effect.addFinalizer(() => shutdown.pipe(orDieAll))
  return {
    shutdown,
    settled: (id: string) =>
      waitFor(
        actor,
        (state) => state.context.id !== id || state.matches("closed")
      ).pipe(
        Effect.orDie,
        Effect.flatMap((state) => state.context.outcome)
      ),
    observe: (id: string, sink: WritableStream<Uint8Array>) =>
      gate.withPermit(
        Effect.gen(function* () {
          if (!actor.getSnapshot().matches("idle")) {
            yield* nativeOperation(
              () => sink.abort(),
              (cause) => cause
            )
            return false
          }
          actor.send({ type: "OFFER", id, sink })
          yield* waitFor(actor, (state) => state.context.id === id).pipe(
            Effect.orDie
          )
          return true
        })
      ),
    release: (id: string) =>
      gate.withPermit(
        Effect.gen(function* () {
          if (actor.getSnapshot().context.id !== id) return
          actor.send({ type: "RELEASE", id })
          const state = yield* settle
          yield* state.context.outcome
        })
      ),
    consume: gate.withPermit(
      Effect.gen(function* () {
        const state = actor.getSnapshot()
        if (!state.matches({ leased: "available" })) return undefined
        const sink = state.context.sink
        actor.send({ type: "CLAIM", id: state.context.id! })
        yield* waitFor(
          actor,
          (state) => !state.matches({ leased: "available" })
        ).pipe(Effect.orDie)
        return sink
      })
    ),
  }
})
