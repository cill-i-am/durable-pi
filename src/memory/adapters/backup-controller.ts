import {
  decideBackupController,
  initialBackupController,
  readBackupController,
  type BackupController,
} from "../backup-discovery.machine"
import type { BackupClaim } from "../backup.machine"

const controllerKey = "memory-backups:failure"

/** The scheduler record retains publication claims even when its final write
 * fails. Storage read failure is unknown authority, never an empty record. */
export class BackupControllerRecord {
  private unpersisted?: BackupController
  constructor(private readonly storage: () => DurableObjectStorage) {}

  async read() {
    if (this.unpersisted) return this.unpersisted
    const raw = await this.storage().get(controllerKey)
    return raw === undefined
      ? initialBackupController()
      : readBackupController(raw)
  }

  async commit(next: BackupController) {
    await this.storage().put(controllerKey, next)
    this.unpersisted = undefined
  }

  async retainExhaustion(next: BackupController) {
    this.unpersisted = next
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
