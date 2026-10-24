import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Cause, Deferred, Effect, FiberSet, Scope } from "effect"

import { orDieAll } from "../shared/effect"
import { AVATAR_PATH } from "./avatar"
import {
  sessionFetchClosed,
  sessionFetchMachine,
  type SessionFetchOutcome,
  type SessionFetchRequest,
} from "./session-fetch.machine"

/** Better Auth owns this callable for its module lifetime. Consumers with an
 * explicit lifetime use makeSessionFetch in their existing Effect scope. */
export function sessionFetch(fetcher: typeof fetch): typeof fetch {
  return Effect.runSync(
    makeSessionFetch(fetcher).pipe(
      Effect.provideService(Scope.Scope, Scope.makeUnsafe())
    )
  )
}

export const makeSessionFetch = (fetcher: typeof fetch) =>
  Effect.gen(function* () {
    const tasks = yield* FiberSet.make<void>()
    const controller = new AbortController()
    const failures: Cause.Cause<unknown>[] = []
    let sequence = 0
    let actor: EffectActor<ReturnType<typeof sessionFetchMachine>>
    const launch = (request: SessionFetchRequest, mutation: boolean) =>
      FiberSet.run(
        tasks,
        Effect.gen(function* () {
          // Interruption cannot release ownership before the foreign promise
          // settles. The owning finalizer signals abort before joining tasks.
          const result: SessionFetchOutcome = yield* Effect.tryPromise({
            try: () =>
              fetcher(request.input, {
                ...request.init,
                signal: AbortSignal.any([
                  controller.signal,
                  AbortSignal.timeout(mutation ? 30_000 : 15_000),
                  ...(mutation && request.signal ? [request.signal] : []),
                ]),
              }),
            catch: (error): SessionFetchOutcome => ({ ok: false, error }),
          }).pipe(
            Effect.map((response): SessionFetchOutcome => ({
              ok: true,
              response,
            })),
            Effect.catch((result) => Effect.succeed(result))
          )
          if (
            !result.ok &&
            Cause.isCause(result.error) &&
            (Cause.hasDies(result.error) ||
              (Cause.hasInterrupts(result.error) &&
                !Cause.hasInterruptsOnly(result.error)))
          )
            failures.push(result.error)
          const ack = yield* Deferred.make<void>()
          yield* send(actor, {
            type: "SETTLED",
            id: request.id,
            mutation,
            outcome: result,
            limitedUntil:
              !mutation && result.ok && result.response.status === 429
                ? retryDeadline(result.response)
                : null,
            ack,
          })
          yield* Deferred.await(ack)
        }).pipe(Effect.uninterruptible)
      ).pipe(Effect.asVoid)
    actor = yield* createEffectActor(
      sessionFetchMachine({ now: Date.now, launch })
    )
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const ack = yield* Deferred.make<void>()
        yield* send(actor, { type: "CLOSE", ack })
        yield* Deferred.await(ack)
        controller.abort(sessionFetchClosed())
        yield* FiberSet.clear(tasks)
        if (failures.length)
          return yield* Effect.failCause(
            Cause.fromReasons(failures.flatMap((cause) => cause.reasons))
          ).pipe(orDieAll)
      })
    )
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const { url, method, callerSignal } = fetchRequest(input, init)
      const reading =
        url.pathname === "/api/auth/get-session" && method === "GET"
      const mutation =
        (url.pathname.startsWith("/api/auth/") ||
          url.pathname === AVATAR_PATH) &&
        method !== "GET"
      if (!reading && !mutation) return fetcher(input, init)
      if (actor.getSnapshot().status !== "active") throw sessionFetchClosed()
      if (reading) callerSignal?.throwIfAborted()
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      )
      const key = JSON.stringify([
        url.href,
        [...headers.entries()].sort(),
        init?.credentials ??
          (input instanceof Request ? input.credentials : "same-origin"),
      ])
      const reply = Deferred.makeUnsafe<SessionFetchOutcome>()
      actor.send({
        type: reading ? "READ" : "MUTATE",
        request: {
          id: ++sequence,
          key,
          input,
          init,
          signal: callerSignal,
          reply,
        },
      })
      const waiting = Effect.runPromise(Deferred.await(reply))
      const result = await (reading
        ? abortable(waiting, callerSignal)
        : waiting)
      if (!result.ok) throw result.error
      return reading ? result.response.clone() : result.response
    }
    return fetch
  })

function retryDeadline(response: Response) {
  const retry = response.headers.get("Retry-After")
  const seconds =
    retry && /^\d+$/.test(retry)
      ? Number(retry)
      : retry
        ? (Date.parse(retry) - Date.now()) / 1000
        : 60
  return (
    Date.now() + Math.max(1, Number.isFinite(seconds) ? seconds : 60) * 1000
  )
}

function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal | null
): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort)
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
  })
}

function fetchRequest(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    "http://local"
  )
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase()
  const callerSignal =
    init?.signal ?? (input instanceof Request ? input.signal : undefined)
  return { url, method, callerSignal }
}
