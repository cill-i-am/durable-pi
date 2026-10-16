import { Effect, Schema } from "effect"

import { preserveFatal } from "../../shared/effect"
import { nativeBytes } from "../../shared/stream"
import { ExecutorUnavailable } from "../executor"
import { executionWithSignal } from "./interop"

export const executionJson = <T, TRequirements>(
  request: Request,
  schema: Schema.ConstraintDecoder<T, TRequirements>
) =>
  executionWithSignal(
    Effect.scoped(
      Effect.gen(function* () {
        if (!request.body) return yield* new ExecutorUnavailable()
        const bytes = yield* nativeBytes(
          request.body,
          256_000,
          () => new ExecutorUnavailable(),
          () => new ExecutorUnavailable()
        )
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
          new TextDecoder().decode(bytes)
        ).pipe(
          preserveFatal,
          Effect.mapError(() => new ExecutorUnavailable())
        )
      })
    ),
    request.signal
  )
