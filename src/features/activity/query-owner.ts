import { createEffectActor } from "@xstate/effect"
import { Cause, Effect, Equal, Exit } from "effect"

import { agentUrl, ApiError, errorMessage } from "@/http/client"
import { fatalCause } from "@/shared/effect"
import { nativeOperation, nativeFailure } from "@/shared/interop"

import {
  activityQueryMachine,
  type ActivityQueryView,
  type ActivityQueryWork,
} from "./query.machine"

export function makeActivityQueryOwner(
  view: ActivityQueryView,
  work: ActivityQueryWork
) {
  return Effect.gen(function* () {
    const failures: Cause.Cause<unknown>[] = []
    // Registered before the actor: this runs after its children have joined,
    // including an interrupted native request's late cleanup failure.
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() =>
        failures.length
          ? Effect.failCause(
              fatalCause(
                Cause.fromReasons(failures.flatMap((cause) => cause.reasons))
              )
            )
          : Effect.void
      )
    )
    return yield* createEffectActor(
      activityQueryMachine({
        ...work,
        read: (input) =>
          Effect.scoped(work.read(input)).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (
                  Exit.isFailure(exit) &&
                  (Cause.hasDies(exit.cause) ||
                    (Cause.hasInterrupts(exit.cause) &&
                      exit.cause.reasons.some(
                        (reason) => reason._tag === "Fail"
                      )))
                )
                  failures.push(exit.cause)
              })
            )
          ),
      }),
      { input: view }
    )
  })
}

export function activityQueryRequest<A>(
  read: (signal: AbortSignal) => Promise<A>
) {
  return Effect.suspend(() => {
    let retained: Cause.Cause<unknown> | undefined
    return nativeOperation(
      (signal) =>
        read(signal).catch((cause) => {
          if (
            Cause.isCause(cause) &&
            (Cause.hasDies(cause) || Cause.hasInterrupts(cause)) &&
            cause.reasons.some((reason) => reason._tag !== "Interrupt")
          )
            retained = cause
          throw cause
        }),
      (cause) => cause
    ).pipe(
      Effect.onExit((exit) => {
        if (!retained) return Effect.void
        const present = Exit.isFailure(exit) ? exit.cause.reasons : []
        const missing = retained.reasons.filter(
          (reason) =>
            !present.some(
              (value) =>
                Equal.equals(value, reason) ||
                (value._tag === "Die" && Equal.equals(value.defect, reason))
            )
        )
        return missing.length
          ? Effect.failCause(fatalCause(Cause.fromReasons(missing)))
          : Effect.void
      })
    )
  })
}
export function activityQueryMessage(
  cause: Cause.Cause<unknown>,
  fallback: string
) {
  const failure = cause.reasons.find((reason) => reason._tag === "Fail")
  return failure?._tag === "Fail" && failure.error instanceof Error
    ? failure.error.message
    : fallback
}

/** Keep the same API error contract while owning an unread response body. */
export async function activityJsonRequest(
  agentId: string,
  path: string,
  signal: AbortSignal,
  body?: unknown
): Promise<unknown> {
  let response: Response | undefined
  let failure: unknown
  let failed = false
  let result: unknown
  try {
    response = await fetch(agentUrl(agentId, path), {
      signal,
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!response.ok) {
      if (response.status === 401)
        throw new ApiError(401, "Your session has expired. Sign in again.")
      const error = await response.json().catch((cause: unknown) => {
        if (Cause.isCause(cause)) throw cause
        return { error: "Connection interrupted. Please retry." }
      })
      throw new ApiError(
        response.status,
        errorMessage(error),
        typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
          ? error.code
          : undefined
      )
    }
    result = await response.json()
  } catch (cause) {
    failure = cause
    failed = true
  } finally {
    if (response?.body && !response.bodyUsed && !response.body.locked) {
      try {
        await response.body.cancel()
      } catch (cause) {
        const cleanup = Cause.isCause(cause) ? cause : Cause.die(cause)
        failure = failed
          ? Cause.combine(
              nativeFailure(failure, (value) => value),
              cleanup
            )
          : cleanup
        failed = true
      }
    }
  }
  if (failed) throw failure
  return result
}
