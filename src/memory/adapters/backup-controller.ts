import { initialTransition, transition } from "xstate"

import {
  decideBackupController,
  initialBackupController,
  readBackupController,
  type BackupController,
} from "../backup-discovery.machine"
import type { BackupClaim } from "../backup.machine"
import { backupControllerRecordMachine as machine } from "../controller-record.machine"

const controllerKey = "memory-backups:failure"

/** The scheduler record retains publication claims even when its final write
 * fails. Storage read failure is unknown authority, never an empty record. */
export class BackupControllerRecord {
  private state = initialTransition(machine)[0]
  constructor(private readonly storage: () => DurableObjectStorage) {}

  async read() {
    if (this.state.matches("retained")) return this.state.context.retained!
    const generation = this.state.context.generation
    const raw = await this.storage().get(controllerKey)
    const control =
      raw === undefined ? initialBackupController() : readBackupController(raw)
    this.state = transition(machine, this.state, {
      type: "OBSERVED",
      record: control,
      generation,
    })[0]
    return this.state.context.retained ?? this.state.context.observed ?? control
  }

  async commit(next: BackupController) {
    next = readBackupController(next)
    const generation = this.state.context.generation
    await this.storage().put(controllerKey, next)
    this.state = transition(machine, this.state, {
      type: "COMMITTED",
      record: next,
      generation,
    })[0]
  }

  async retainExhaustion(next: BackupController) {
    next = readBackupController(next)
    this.state = transition(machine, this.state, {
      type: "RETAIN",
      record: next,
    })[0]
    await this.commit(next)
  }

  async attach(claim: BackupClaim) {
    const state = await this.read()
    if (state.phase !== "exhausted") return false
    await this.retainExhaustion(
      decideBackupController(state, { type: "ATTACH", claim })
    )
    return true
  }

  async settle(claim: BackupClaim) {
    const state = await this.read()
    const next = decideBackupController(state, {
      type: "SETTLED",
      attemptId: claim.attemptId,
    })
    // Settlement records the receipt; it does not renew warm exhausted authority.
    await this.storage().put(controllerKey, next)
  }
}
