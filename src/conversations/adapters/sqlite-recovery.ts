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
      const state = observeRound(
        this.get(turnId) ?? initialRecovery(epoch),
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
      return state
    })
  }
}
