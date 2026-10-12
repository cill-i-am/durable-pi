import type { Sqlite } from "../../storage/sqlite"
import {
  initialRecovery,
  observeRound,
  recoveryPolicy,
  type Observation,
  type RecoveryPolicy,
  type RecoveryState,
} from "../recovery"

/** Run-owned bounded projection; originals and dispatch receipts keep their owners. */
export class RunRecoveryStore {
  constructor(
    private readonly db: Sqlite,
    readonly policy: RecoveryPolicy = recoveryPolicy
  ) {
    if (
      !Number.isInteger(policy.warnAfter) ||
      policy.warnAfter < 2 ||
      !Number.isInteger(policy.stopAfter) ||
      policy.stopAfter <= policy.warnAfter ||
      !Number.isInteger(policy.recoveryAttempts) ||
      policy.recoveryAttempts < 1
    )
      throw new Error("Invalid tool recovery policy")
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
    return row?.recovery ? JSON.parse(row.recovery) : undefined
  }
  observe(
    turnId: string,
    conversationId: string,
    epoch: string,
    requestEpoch: string,
    observations: readonly Observation[]
  ) {
    return this.db.transaction(() => {
      const turn = this.db.all<{ status: string; session_id: string | null }>(
        "SELECT status,session_id FROM chat_turns WHERE id=? AND parent_id IS NULL",
        turnId
      )[0]
      if (
        !turn ||
        turn.session_id !== conversationId ||
        !["preparing", "running"].includes(turn.status)
      )
        return undefined
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
          new Date().toISOString(),
          JSON.stringify(state.view)
        )
      return state
    })
  }
}
