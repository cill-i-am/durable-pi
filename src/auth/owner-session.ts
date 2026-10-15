import { nativeOperation } from "../shared/interop"
import { Effect, Schema } from "effect"

export class OwnerSessionUnavailable extends Schema.TaggedError<OwnerSessionUnavailable>()(
  "OwnerSessionUnavailable",
  { cause: Schema.Unknown }
) {}

export const ownerSession = Effect.fn("Identity.ownerSession")(function* <
  TUser extends { readonly id: string; readonly email: string },
>(read: () => Promise<{ readonly user: TUser } | null>, ownerEmail: string) {
  yield* Effect.yieldNow
  const session = yield* nativeOperation(read, (cause, channel) => {
    const known = Schema.decodeUnknownOption(OwnerSessionUnavailable)(cause)
    if (known._tag === "Some") return known.value
    if (channel === "failure" || Schema.isSchemaError(cause)) throw cause
    return new OwnerSessionUnavailable({ cause })
  })
  return session?.user.email.toLowerCase() === ownerEmail.toLowerCase()
    ? session.user
    : null
})

export const sessionUnavailableResponse = (error: OwnerSessionUnavailable) =>
  Effect.logError("Identity.sessionLookupFailed", error.cause).pipe(
    Effect.annotateLogs({
      event: "auth.session_lookup_failed",
      operation: "getSession",
    }),
    Effect.as(
      Response.json(
        {
          code: "SESSION_UNAVAILABLE",
          error: "Could not verify your session. Please try again.",
        },
        {
          status: 503,
          headers: { "Cache-Control": "private, no-store", "Retry-After": "5" },
        }
      )
    )
  )
