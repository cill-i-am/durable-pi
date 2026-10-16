import { Effect, Schema } from "effect"

import { preserveFatal } from "./effect"
import { nativeBytes } from "./stream"

/** Own the bounded reader until read/cancel settlement and lock release. */
export function requestBytes<TError>(
  request: Request,
  maximum: number,
  invalid: () => TError,
  tooLarge: () => TError = invalid
) {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.yieldNow
      if (!request.body) return yield* Effect.fail(invalid())
      return yield* nativeBytes(request.body, maximum, invalid, tooLarge)
    })
  )
}

/** A failed reader cleanup stays fatal alongside invalid/oversized input. */
export function jsonRequest<T, TError>(
  request: Request,
  schema: Schema.Codec<T, unknown>,
  maximum: number,
  invalid: () => TError
) {
  return requestBytes(request, maximum, invalid).pipe(
    Effect.flatMap((bytes) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
        new TextDecoder().decode(bytes)
      ).pipe(preserveFatal, Effect.mapError(invalid))
    )
  )
}
