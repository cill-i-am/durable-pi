import { Data, Effect } from "effect"

export class OwnerSessionUnavailable extends Data.TaggedError(
  "OwnerSessionUnavailable"
)<{
  readonly cause: unknown
}> {}

export const ownerSession = Effect.fn("Identity.ownerSession")(function* <
  TUser extends { readonly id: string; readonly email: string },
>(read: () => Promise<{ readonly user: TUser } | null>, ownerEmail: string) {
  const session = yield* Effect.tryPromise({
    try: read,
    catch: (cause) => new OwnerSessionUnavailable({ cause }),
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
