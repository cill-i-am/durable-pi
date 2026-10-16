import { Effect, Schema } from "effect"

import { nativeBytes } from "../../shared/stream"
import { CodeOutput } from "../contracts"
import { ExecutorUnavailable } from "../executor"
import { releaseExecutionResponse } from "./interop"

/** The decoded value is returned only after its native body owner has closed. */
export const readOutput = Effect.fn("Execution.readOutput")(
  (response: Response) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => releaseExecutionResponse(response))
        if (!response.ok || !response.body)
          return yield* new ExecutorUnavailable()
        const bytes = yield* nativeBytes(
          response.body,
          200_000,
          () => new ExecutorUnavailable(),
          () => new ExecutorUnavailable()
        )
        return yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(CodeOutput)
        )(new TextDecoder().decode(bytes)).pipe(
          Effect.mapError(() => new ExecutorUnavailable())
        )
      })
    )
)
