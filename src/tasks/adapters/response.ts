import { Effect } from "effect"

import { releaseUnreadResponse } from "../../shared/interop"
import { nativeBytes } from "../../shared/stream"
import { TaskControlError } from "../contracts"

const unavailable = (status: number) =>
  new TaskControlError({
    code: status === 404 ? "not_found" : "unavailable",
    message: "This task's state could not be confirmed. Retry the same handle.",
  })

/** The task caller owns the transferred response until its reader settles. */
export const readTaskResponse = (response: Response) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => releaseUnreadResponse(response))
      // Install ownership before a pre-aborted caller can leave the scope.
      yield* Effect.yieldNow
      if (!response.ok) {
        yield* releaseUnreadResponse(response)
        return yield* unavailable(response.status)
      }
      const bytes = response.body
        ? yield* nativeBytes(
            response.body,
            Infinity,
            () => unavailable(response.status),
            () => unavailable(response.status)
          )
        : new Uint8Array()
      return yield* Effect.sync(
        () => JSON.parse(new TextDecoder().decode(bytes)) as unknown
      )
    })
  )
