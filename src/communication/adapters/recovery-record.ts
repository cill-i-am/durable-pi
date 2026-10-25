import { failure, type MailboxRecovery } from "../contracts"
import {
  readCommunicationDiscovery,
  readMailboxRecoveryState,
  transitionMailboxRecovery,
} from "../recovery.machine"

const recoveryKey = "bot-communication:failure"

/** Owns the durable recovery epoch. Queue observations stay inside its transaction. */
export class MailboxRecoveryRecord {
  constructor(
    private readonly host: {
      storage: () => DurableObjectStorage
      epoch: (jobId: string) => string | undefined
      discovery: () => ReturnType<typeof readCommunicationDiscovery> | undefined
    }
  ) {}

  async read() {
    return readMailboxRecoveryState(await this.host.storage().get(recoveryKey))
  }

  async retain(completed: { jobId: string; recovery: MailboxRecovery }) {
    await this.host.storage().transaction(async (storage) => {
      const prior = readMailboxRecoveryState(await storage.get(recoveryKey))
      // A joined failed epoch can be retried after its SDK row was removed,
      // but cannot replace a newer pump or a newer durable failure summary.
      const current = this.host.epoch(completed.jobId)
      if (
        (current !== undefined && current !== completed.recovery.epoch) ||
        prior.retiredEpoch === completed.recovery.epoch ||
        (current === undefined &&
          prior.recovery &&
          prior.recovery.epoch !== completed.recovery.epoch)
      )
        return
      await storage.put(
        recoveryKey,
        transitionMailboxRecovery(prior, {
          type: "EXHAUSTED",
          recovery: completed.recovery,
        })
      )
    })
  }

  async retry(epoch: string, deadline: number) {
    await this.host.storage().transaction(async (storage) => {
      const prior = readMailboxRecoveryState(await storage.get(recoveryKey))
      const discovery = this.host.discovery()
      const now = Date.now()
      if (prior.recovery?.epoch !== epoch)
        throw failure(
          "conflict",
          "This mailbox failure has changed. Reload its current status."
        )
      if (
        !discovery ||
        discovery.recoveryEpoch !== epoch ||
        discovery.armedUntil < deadline ||
        now >= deadline
      )
        throw failure(
          "storage",
          "Mailbox recovery discovery expired. Retry the same recovery."
        )
      const next = transitionMailboxRecovery(prior, {
        type: "RETRY",
        epoch,
        now,
        deadline,
        pumpEpoch: this.host.epoch("bot-communication:pump") ?? null,
      })
      if (next.recovery)
        throw failure("conflict", "Mailbox recovery was not accepted.")
      await storage.put(recoveryKey, next)
    })
  }
}
