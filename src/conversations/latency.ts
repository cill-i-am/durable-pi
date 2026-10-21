import { Clock, Effect } from "effect"

export type FirstTextTrace = {
  readonly turnId: string
  readonly attemptId: string
  readonly sessionId: string
  readonly providerAt: number
  nativeObservedAt?: number
  snapshotStartedAt?: number
  snapshotReadyAt?: number
  publishedAt?: number
}

/** Actor-local diagnostics only. Bounded and volatile; never an authority,
 * journal or cache of message content. All actor milestones share one clock. */
export class ConversationLatency {
  private readonly traces = new Map<string, FirstTextTrace>()

  provider = (turnId: string, attemptId: string, sessionId: string) =>
    Effect.gen({ self: this }, function* () {
      if (this.traces.has(turnId)) return
      this.traces.set(turnId, {
        turnId,
        attemptId,
        sessionId,
        providerAt: yield* Clock.currentTimeMillis,
      })
      if (this.traces.size > 32)
        this.traces.delete(this.traces.keys().next().value!)
    })

  native = (sessionId: string) =>
    Effect.gen({ self: this }, function* () {
      const now = yield* Clock.currentTimeMillis
      for (const trace of this.traces.values())
        if (
          trace.sessionId === sessionId &&
          trace.nativeObservedAt === undefined
        )
          trace.nativeObservedAt = now
    })

  publication = (
    turnId: string,
    snapshotStartedAt: number,
    snapshotReadyAt: number
  ) =>
    Effect.gen({ self: this }, function* () {
      const trace = this.traces.get(turnId)
      if (!trace) return undefined
      return {
        ...trace,
        snapshotStartedAt,
        snapshotReadyAt,
        publishedAt: yield* Clock.currentTimeMillis,
      }
    })
}
