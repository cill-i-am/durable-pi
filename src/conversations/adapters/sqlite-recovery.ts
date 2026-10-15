import type { Sqlite } from "../../storage/sqlite"
import { Schema } from "effect"
import { ConversationStorageError } from "../turns"
import type { RecoveryLedger } from "../recovery-service"
import {
  initialRecovery,
  observeRound,
  recoveryPolicy,
  requireRecoveryPolicy,
  canObserveRecovery,
  RecoveryStateRecord,
  type Observation,
  type RecoveryPolicy,
  type RecoveryState,
} from "../recovery"

export class RunRecoveryStore implements RecoveryLedger {
  readonly transactionGroup: object
  constructor(
    private readonly db: Sqlite,
    readonly policy: RecoveryPolicy = recoveryPolicy
  ) {
    requireRecoveryPolicy(policy)
    this.transactionGroup = db
    const native = db
    const storage = <T>(operation: string, body: () => T): T => {
      try {
        return body()
      } catch (cause) {
        throw new ConversationStorageError({ operation, cause })
      }
    }
    this.db = db = {
      all: (query, ...bindings) =>
        storage("read recovery", () => native.all(query, ...bindings)),
      run: (query, ...bindings) =>
        storage("write recovery", () => native.run(query, ...bindings)),
      transaction: (body) => {
        const callback: { failed: boolean; cause?: unknown } = { failed: false }
        try {
          return native.transaction(() => {
            try {
              return body()
            } catch (cause) {
              callback.failed = true
              callback.cause = cause
              throw cause
            }
          })
        } catch (cause) {
          if (callback.failed && cause === callback.cause) throw cause
          throw new ConversationStorageError({
            operation: "recovery transaction",
            cause,
          })
        }
      },
    }
    db.run(`CREATE TABLE IF NOT EXISTS chat_recovery_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id TEXT NOT NULL,
      at TEXT NOT NULL, view TEXT NOT NULL)`)
    db.run(
      "CREATE INDEX IF NOT EXISTS chat_recovery_run ON chat_recovery_history(turn_id,id)"
    )
  }
  get(turnId: string): RecoveryState | undefined {
    const row = this.db.all<{ recovery: string | null }>(
      "SELECT recovery FROM chat_turns WHERE id=? AND parent_id IS NULL",
      turnId
    )[0]
    if (!row?.recovery) return
    const historical = JSON.parse(row.recovery)
    const decoded = Schema.decodeUnknownSync(RecoveryStateRecord)(historical)
    return {
      ...historical,
      ...decoded,
      buckets: decoded.buckets.map((bucket) => ({ ...bucket })),
      view: decoded.view ? { ...decoded.view } : null,
    }
  }
  observe(
    turnId: string,
    conversationId: string,
    epoch: string,
    requestEpoch: string,
    observations: readonly Observation[],
    at = new Date().toISOString()
  ) {
    return this.db.transaction(() => {
      const turn = this.db.all<{ status: string; session_id: string | null }>(
        "SELECT status,session_id FROM chat_turns WHERE id=? AND parent_id IS NULL",
        turnId
      )[0]
      if (!canObserveRecovery(turn, conversationId)) return
      const previous = this.get(turnId)
      const state = observeRound(
        previous ?? initialRecovery(epoch),
        epoch,
        requestEpoch,
        observations,
        this.policy
      )
      this.db.run(
        "UPDATE chat_turns SET recovery=? WHERE id=?",
        JSON.stringify(state),
        turnId
      )
      if (
        state.view &&
        JSON.stringify(previous?.view) !== JSON.stringify(state.view)
      )
        this.db.run(
          "INSERT INTO chat_recovery_history(turn_id,at,view) VALUES (?,?,?)",
          turnId,
          at,
          JSON.stringify(state.view)
        )
      return state
    })
  }
}
