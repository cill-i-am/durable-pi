import * as Drizzle from "alchemy/Drizzle/D1"
import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { lower } from "../../storage/expressions"
import { mapSqliteError } from "../../storage/sqlite"
import { user } from "../schema"

export class AuthStorageError extends Schema.TaggedError<AuthStorageError>()(
  "AuthStorageError",
  { cause: Schema.Unknown }
) {}

/** Owned reads use Alchemy's scoped first-party Effect D1 client. Better Auth
 * retains its conventional Drizzle adapter for the SDK-owned account writes. */
export function ownerAccounts(binding: D1Database) {
  const database = Drizzle.D1(Effect.succeed(binding))
  const read = <TValue, TError, TRequirements>(
    effect: Effect.Effect<TValue, TError, TRequirements>
  ) => mapSqliteError(effect, (cause) => new AuthStorageError({ cause }))
  return {
    registered: () =>
      read(
        Effect.scoped(
          Effect.gen(function* () {
            const db = yield* database
            return (
              (yield* db.select({ id: user.id }).from(user).limit(1)).length !==
              0
            )
          })
        )
      ).pipe(Effect.uninterruptible),
    owner: (email: string) =>
      read(
        Effect.scoped(
          Effect.gen(function* () {
            const db = yield* database
            const row = yield* db
              .select({ id: user.id })
              .from(user)
              .where(eq(lower(user.email), lower(email)))
              .limit(1)
              .get()
            return row ? Schema.decodeUnknownSync(Schema.String)(row.id) : null
          })
        )
      ).pipe(Effect.uninterruptible),
  }
}
