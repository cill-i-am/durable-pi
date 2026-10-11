import type { RoutineStore } from "./adapters/sqlite"
import type { RoutineRun } from "./contracts"
import { ConversationFull, type Turn } from "../conversations/turns"

interface RoutineHost {
  getTurn: (id: string) => Pick<Turn, "id" | "status" | "error"> | undefined
  modelConnected: () => Promise<boolean>
  wakeConversation: () => Promise<void>
  admit: (run: RoutineRun) => void
  stop: (id: string) => void
  notify: () => void
}
/** Reconciles durable schedule intent with the conversation; the platform owns alarms/retries. */
export class RoutinePump {
  constructor(
    private readonly store: RoutineStore,
    private readonly host: RoutineHost,
    private readonly now: () => number = Date.now
  ) {}
  retry() {
    const next = this.store.nextWake()
    return next === undefined ? undefined : Math.max(this.now() + 60000, next)
  }
  async run() {
    if (this.store.nextWake() === undefined) return
    const previous = this.store.inFlight()
    if (previous?.status === "queued") {
      const turn = this.host.getTurn(previous.turnId)
      if (!turn)
        this.store.finish(
          previous.turnId,
          "failed",
          "The admitted reply is unavailable."
        )
      else if (
        turn.status === "done" ||
        turn.status === "failed" ||
        turn.status === "cancelled"
      )
        this.store.finish(turn.id, turn.status, turn.error)
      else if (!this.store.canRun(turn.id)) {
        await this.host.wakeConversation()
        this.host.stop(turn.id)
      }
    }
    this.store.claimDue()
    if (
      this.store.inFlight()?.status === "pending" &&
      (await this.host.modelConnected())
    ) {
      await this.host.wakeConversation()
      try {
        this.store.deliver((run) => this.host.admit(run))
      } catch (cause) {
        if (!(cause instanceof ConversationFull)) throw cause
      }
      this.host.notify()
    }
    const next = this.store.nextWake()
    return next === undefined ? undefined : Math.max(this.now() + 100, next)
  }
}
