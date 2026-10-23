import { Effect } from "effect"

import type { ConfigurationLedger } from "../../agents/configuration"
import { AgentStorageError } from "../../agents/domain"
import { mapSqliteError, type Sqlite } from "../../storage/sqlite"
import type { AppStore } from "./sqlite"

/** Bot archival and its app authority must become visible in one commit. The
 * existing app revision fences remote renders even if restore overtakes local
 * invalidation; immutable receipts and saved app content remain unchanged. */
export function appConfiguration(
  db: Sqlite,
  configuration: ConfigurationLedger,
  apps: Pick<AppStore, "transactionGroup" | "revokeBotAuthority">
): ConfigurationLedger {
  if (configuration.transactionGroup !== db || apps.transactionGroup !== db)
    throw new Error(
      "App configuration must share its storage transaction group."
    )
  return {
    transactionGroup: db,
    read: () => configuration.read(),
    configure: (owner, profile) =>
      mapSqliteError(
        db.transaction(() =>
          Effect.gen(function* () {
            const before = yield* configuration.read()
            yield* configuration.configure(owner, profile)
            const current = yield* configuration.read()
            if (
              current?.status === "archived" &&
              current.revision !== before?.revision
            )
              yield* apps
                .revokeBotAuthority(
                  "This bot was archived before conversation admission. Saved app state is retained."
                )
                .pipe(Effect.mapError(() => new AgentStorageError()))
          })
        ),
        () => new AgentStorageError()
      ),
  }
}

/** Local interruption is outside the SQL transaction. Retain its coordinator
 * through the authority read and synchronous abort so restore cannot overtake
 * that read and expose newly authorized work to an old invalidation callback. */
export function invalidateArchivedApps(
  db: Sqlite,
  configuration: Pick<ConfigurationLedger, "transactionGroup" | "read">,
  invalidate: () => void
) {
  if (configuration.transactionGroup !== db)
    throw new Error(
      "App invalidation must share its storage transaction group."
    )
  return mapSqliteError(
    db.use(() =>
      configuration
        .read()
        .pipe(
          Effect.flatMap((current) =>
            current?.status === "archived"
              ? Effect.sync(invalidate)
              : Effect.void
          )
        )
    ),
    () => new AgentStorageError()
  )
}
