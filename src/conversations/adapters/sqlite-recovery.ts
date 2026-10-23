import { and, eq, isNull } from "drizzle-orm"
import { Effect } from "effect"

import { mapSqliteError, type Sqlite } from "../../storage/sqlite"
import {
  initialRecovery,
  recoveryPolicy,
  requireRecoveryPolicy,
  canObserveRecovery,
  decodeRecoveryState,
  type Observation,
  type RecoveryPolicy,
} from "../recovery"
import type { RecoveryLedger } from "../recovery-service"
import { observeRound } from "../tool-recovery.machine"
import { ConversationStorageError } from "../turns"
import { chatTurns, chatRecoveryHistory } from "./schema"

export class RunRecoveryStore implements RecoveryLedger {
  readonly transactionGroup: object
  constructor(
    private readonly db: Sqlite,
    readonly policy: RecoveryPolicy = recoveryPolicy
  ) {
    requireRecoveryPolicy(policy)
    this.transactionGroup = db
  }
  get(turnId: string): ReturnType<RecoveryLedger["get"]> {
    return mapSqliteError(
      this.db.use((orm) =>
        orm
          .select({ recovery: chatTurns.recovery })
          .from(chatTurns)
          .where(and(eq(chatTurns.id, turnId), isNull(chatTurns.parent_id)))
          .limit(1)
      ),
      (cause) =>
        new ConversationStorageError({ operation: "read recovery", cause })
    ).pipe(
      Effect.map((rows) => {
        if (!rows[0]?.recovery) return
        return decodeRecoveryState(JSON.parse(rows[0].recovery))
      })
    )
  }
  observe(
    turnId: string,
    conversationId: string,
    epoch: string,
    requestEpoch: string,
    observations: readonly Observation[],
    at = new Date().toISOString(),
    guard?: () => Effect.Effect<string | undefined, ConversationStorageError>
  ): ReturnType<RecoveryLedger["observe"]> {
    return mapSqliteError(
      this.db.transaction(() =>
        Effect.gen({ self: this }, function* () {
          const currentEpoch = guard ? yield* guard() : requestEpoch
          if (currentEpoch === undefined) return
          const rows = yield* this.db.use((orm) =>
            orm
              .select({
                status: chatTurns.status,
                session_id: chatTurns.session_id,
              })
              .from(chatTurns)
              .where(and(eq(chatTurns.id, turnId), isNull(chatTurns.parent_id)))
              .limit(1)
          )
          if (!canObserveRecovery(rows[0], conversationId)) return
          const previous = yield* this.get(turnId),
            state = observeRound(
              previous ?? initialRecovery(epoch),
              epoch,
              currentEpoch,
              observations,
              this.policy
            )
          yield* this.db.use((orm) =>
            orm
              .update(chatTurns)
              .set({ recovery: JSON.stringify(state) })
              .where(eq(chatTurns.id, turnId))
          )
          if (
            state.view &&
            JSON.stringify(previous?.view) !== JSON.stringify(state.view)
          )
            yield* this.db.use((orm) =>
              orm.insert(chatRecoveryHistory).values({
                turn_id: turnId,
                at,
                view: JSON.stringify(state.view),
              })
            )
          return state
        })
      ),
      (cause) =>
        new ConversationStorageError({ operation: "observe recovery", cause })
    )
  }
}
