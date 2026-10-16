import { Cause, Effect } from "effect"

import { releaseUnreadResponse } from "../interop"

/** A forwarded upgrade retains native metadata. Failed forwarding owns every
 * cleanup attempt; a successful scope transfers the original Response. */
export const releaseForwardedResponse = (response: Response) =>
  Effect.gen(function* () {
    const failures: Cause.Reason<never>[] = []
    const attempt = (work: Effect.Effect<unknown>) =>
      work.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            failures.push(...cause.reasons)
          })
        )
      )
    const socket = response.webSocket
    if (socket && socket.readyState < 2) {
      yield* attempt(Effect.sync(() => socket.accept()))
      yield* attempt(Effect.sync(() => socket.close(1000, "Request cancelled")))
    }
    yield* attempt(releaseUnreadResponse(response))
    if (failures.length)
      return yield* Effect.failCause(Cause.fromReasons(failures))
  })
