import { createEffectActor, join, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Scope } from "effect"

import { sessionSocketMachine } from "../session-socket.machine"

type SocketPeer = Pick<
  WebSocket,
  "close" | "send" | "addEventListener" | "removeEventListener"
>
type SessionUpstream = SocketPeer & Pick<WebSocket, "accept" | "binaryType">
export interface SessionSocketClose {
  (code?: number, reason?: string): void
  /** Completes only after listeners, sockets and any native auth check settle. */
  readonly settled: Promise<void>
}
const nativeCause = (cause: unknown): Cause.Cause<unknown> =>
  Cause.isCause(cause) ? cause : Cause.die(cause)
const nativeSync = <T>(run: () => T) =>
  Effect.try({ try: run, catch: nativeCause }).pipe(
    Effect.catch((cause) => Effect.failCause(cause))
  )
const combined = (causes: readonly Cause.Cause<unknown>[]) =>
  Cause.fromReasons(causes.flatMap((cause) => cause.reasons))

/** The callable disposer requests machine closure; settled is the joined native
 * lifetime. Read-only auth has no cancellation API and retains its real outcome. */
export function bindSessionSocket(
  browser: SocketPeer,
  upstream: SocketPeer,
  authorized: () => Promise<boolean>,
  failed: (cause: unknown) => void = () => {}
): SessionSocketClose {
  const lifetime = Scope.makeUnsafe()
  const resources = Scope.makeUnsafe()
  const failures: Cause.Cause<unknown>[] = []
  const retainFailure = (cause: Cause.Cause<unknown>) =>
    Effect.sync(() => {
      failures.push(cause)
    })
  const finalizer = (release: () => void) =>
    Effect.addFinalizer(() =>
      nativeSync(release).pipe(Effect.catchCause(retainFailure))
    ).pipe(Effect.provideService(Scope.Scope, resources))
  const releaseSocket = (socket: SocketPeer) => {
    const state = actor?.getSnapshot().context
    socket.close(state?.code ?? 1011, state?.reason ?? "Could not open session")
  }
  let actor: EffectActor<ReturnType<typeof sessionSocketMachine>> | undefined
  function makeActor() {
    return Effect.runSync(
      createEffectActor(
        sessionSocketMachine({
          now: Date.now,
          authorized: Effect.tryPromise({
            try: authorized,
            catch: nativeCause,
          }).pipe(
            Effect.catch((cause) => Effect.failCause(cause)),
            Effect.tapCause(retainFailure),
            Effect.uninterruptible
          ),
          forward: ({ direction, data }) =>
            Effect.sync(() => {
              try {
                ;(direction === "browser" ? upstream : browser).send(data)
              } catch (cause) {
                failures.push(nativeCause(cause))
                actor?.send({ type: "BROKEN" })
              }
            }),
          close: Scope.close(resources, Exit.void),
        })
      ).pipe(Effect.provideService(Scope.Scope, lifetime))
    )
  }
  try {
    for (const socket of [browser, upstream])
      Effect.runSync(finalizer(() => releaseSocket(socket)))
    actor = makeActor()
    const listen = (
      socket: SocketPeer,
      type: "message" | "close" | "error",
      listener: EventListener
    ) => {
      // Register removal before installation: a native add can throw after work.
      Effect.runSync(
        finalizer(() => socket.removeEventListener(type, listener))
      )
      socket.addEventListener(type, listener)
    }
    for (const [socket, direction] of [
      [browser, "browser"],
      [upstream, "upstream"],
    ] as const) {
      listen(socket, "message", ((
        event: MessageEvent<string | ArrayBuffer>
      ) => {
        actor?.send({ type: "FRAME", direction, data: event.data })
      }) as EventListener)
      for (const type of ["close", "error"] as const)
        listen(socket, type, () =>
          actor?.send({
            type: "CLOSE",
            code: 1000,
            reason: "Connection closed",
          })
        )
    }
  } catch (cause) {
    failures.unshift(nativeCause(cause))
    actor?.stop()
    Effect.runSync(Scope.close(resources, Exit.void))
    void Effect.runPromiseExit(Scope.close(lifetime, Exit.void)).then(
      (exit) => {
        if (Exit.isFailure(exit)) failed(exit.cause)
      }
    )
    throw combined(failures)
  }
  const running = actor
  const settled = Effect.runPromiseExit(join(running)).then(async (exit) => {
    if (Exit.isFailure(exit)) failures.push(exit.cause)
    await Effect.runPromise(Scope.close(resources, Exit.void))
    const closed = await Effect.runPromiseExit(Scope.close(lifetime, Exit.void))
    if (Exit.isFailure(closed)) failures.push(closed.cause)
    if (failures.length) {
      let cause = combined(failures)
      try {
        failed(cause)
      } catch (failure) {
        cause = Cause.combine(cause, nativeCause(failure))
      }
      throw cause
    }
  })
  void settled.catch(() => {})
  return Object.assign(
    (code = 1000, reason = "Connection closed") => {
      running.send({ type: "CLOSE", code, reason })
    },
    { settled }
  )
}

export interface SessionSocket {
  readonly response: Response
  readonly close: () => void
  readonly settled?: Promise<void>
}
export function sessionSocketResponse(
  upstream: SessionUpstream,
  authorized: () => Promise<boolean>,
  failed: (cause: unknown) => void
): SessionSocket {
  const pair = new WebSocketPair()
  const failures: Cause.Cause<unknown>[] = []
  const opened = Effect.runSyncExit(
    Effect.gen(function* () {
      for (const socket of [pair[1], upstream]) {
        yield* Effect.addFinalizer((exit) =>
          Exit.isFailure(exit)
            ? nativeSync(() =>
                socket.close(1011, "Could not open session")
              ).pipe(
                Effect.catchCause((cause) =>
                  Effect.sync(() => {
                    failures.push(cause)
                  })
                )
              )
            : Effect.void
        )
      }
      return yield* nativeSync(() => {
        pair[1].accept()
        upstream.accept()
        pair[1].binaryType = upstream.binaryType = "arraybuffer"
        return new Response(null, { status: 101, webSocket: pair[0] })
      })
    }).pipe(Effect.scoped)
  )
  if (Exit.isFailure(opened)) throw combined([opened.cause, ...failures])
  const close = bindSessionSocket(pair[1], upstream, authorized, failed)
  return { response: opened.value, close, settled: close.settled }
}
