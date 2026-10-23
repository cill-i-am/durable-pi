import { Effect, Exit } from "effect"

import { AccessStore } from "../../src/access/adapters/sqlite"
import { AccessGate } from "../../src/access/gate"
import { migrateSqlite } from "../../src/storage/migrations"
import type { Sqlite } from "../../src/storage/sqlite"
import { drizzleProbeRows } from "./drizzle-schema"

/** Real native SQLite plus the production Effect actor. The script kills workerd
 * between prepare and restore; no JS actor or callback survives that restart. */
export function accessOperationProbe(db: Sqlite, restoring: boolean) {
  return Effect.gen(function* () {
    yield* migrateSqlite(db)
    const store = new AccessStore(db, () =>
      Effect.succeed([{ name: "test", description: "Test", mode: "ask" }])
    )
    const gate = new AccessGate(store, () => Effect.succeed(true))
    const intent = (id: string) => ({
      id,
      turnId: "turn",
      tool: "test",
      input: "{}",
    })
    const ids = ["pending", "running", "recoverable", "revoked", "receipt"]
    const rows = () => Effect.all(ids.map((id) => store.get(id)))
    if (!restoring) {
      for (const id of ids) {
        yield* store.begin(intent(id))
        if (id !== "pending") yield* store.decide(id, true, 0)
        if (!["pending", "receipt"].includes(id)) yield* store.claim(id)
      }
      const result = yield* gate.run(
        intent("receipt"),
        db
          .use((orm) =>
            orm
              .insert(drizzleProbeRows)
              .values({ id: 1, value: "one external effect" })
          )
          .pipe(Effect.as("saved receipt"))
      )
      return { result, operations: yield* rows() }
    }
    const before = yield* rows()
    const receipt = yield* gate.run(
      intent("receipt"),
      Effect.die("Receipt replay must not execute work")
    )
    const uncertain = yield* Effect.exit(store.claim("running"))
    const pending = yield* store.claim("pending")
    const recovered = yield* store.claim("recoverable", true)
    yield* store.finish("recoverable", '"reconciled native result"')
    yield* store.update("test", 0, "deny")
    yield* store.update("test", 1, "allow")
    const revoked = yield* Effect.exit(store.claim("revoked", true))
    return {
      before,
      receipt,
      pending,
      recovered,
      uncertain: Exit.isFailure(uncertain),
      revoked: Exit.isFailure(revoked),
      after: yield* rows(),
    }
  })
}
