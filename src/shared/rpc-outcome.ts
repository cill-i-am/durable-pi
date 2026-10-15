import { Cause, Exit, Schema } from "effect"

/** Native RPC carries plain data, not a squashed exception. Each feature owns
 * its value/error schemas; private defects and annotations stay with the host. */
export function rpcOutcome<T, TError>(
  value: Schema.Codec<T, unknown>,
  error: Schema.Codec<TError, unknown>,
  defect: string
) {
  const codec = Schema.toCodecJson(
    Schema.Exit(value, error, Schema.Literal(defect))
  )
  const decodeError = Schema.decodeUnknownOption(error)
  return {
    isUnexpected: (exit: Exit.Exit<T, unknown>) =>
      Exit.isFailure(exit) &&
      (Cause.hasDies(exit.cause) ||
        exit.cause.reasons.some(
          (reason) =>
            reason._tag === "Fail" && decodeError(reason.error)._tag === "None"
        )),
    encode: (exit: Exit.Exit<T, unknown>): Schema.Json =>
      Schema.encodeSync(codec)(
        Exit.isSuccess(exit)
          ? Exit.succeed(exit.value)
          : Exit.failCause(
              Cause.fromReasons(
                exit.cause.reasons.map((reason): Cause.Reason<TError> => {
                  switch (reason._tag) {
                    case "Fail": {
                      const known = decodeError(reason.error)
                      return known._tag === "Some"
                        ? Cause.makeFailReason(known.value)
                        : Cause.makeDieReason(defect)
                    }
                    case "Die":
                      return Cause.makeDieReason(defect)
                    case "Interrupt":
                      return reason
                  }
                })
              )
            )
      ),
    decode: Schema.decodeUnknownSync(codec),
    /** Decode within native settlement so a late invalid/fatal reply is retained
     * by the caller's join, even after interruption. No Effect runner is used. */
    unwrap: <TValue>(
      raw: unknown,
      result: Schema.Codec<TValue, unknown>
    ): TValue => {
      let exit: Exit.Exit<T, TError>
      try {
        exit = Schema.decodeUnknownSync(codec)(raw)
      } catch (cause) {
        throw Cause.die(cause)
      }
      if (Exit.isFailure(exit)) throw exit.cause
      try {
        return Schema.decodeUnknownSync(Schema.toType(result))(exit.value)
      } catch (cause) {
        throw Cause.die(cause)
      }
    },
  }
}
