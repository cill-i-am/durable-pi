import { Clock, Effect } from "effect"

export type FirstTextTrace = {
  readonly turnId: string
  readonly attemptId: string
  readonly sessionId: string
  readonly providerAt: number
  nativeObservedAt?: number
  storageSyncStartedAt?: number
  storageSyncReadyAt?: number
  snapshotStartedAt?: number
  snapshotReadyAt?: number
  publishedAt?: number
}

/** Actor-local diagnostics only. Bounded and volatile; never an authority,
 * journal or cache of message content. All actor milestones share one clock. */
export class ConversationLatency {
  private readonly traces = new Map<string, FirstTextTrace>()
  private readonly confirmations = new WeakMap<
    FirstTextTrace,
    Effect.Effect<void>
  >()

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

  /** Opt-in diagnostic: join the platform durability barrier without changing
   * write policy or allowing unconfirmed output. Never run for historical turns. */
  confirm = (turnIds: readonly string[], sync: Effect.Effect<void>) =>
    Effect.gen({ self: this }, function* () {
      for (const id of turnIds) {
        const trace = this.traces.get(id)
        if (!trace) continue
        let confirmation = this.confirmations.get(trace)
        if (!confirmation) {
          confirmation = yield* Effect.cached(
            Effect.gen(function* () {
              trace.storageSyncStartedAt = yield* Clock.currentTimeMillis
              yield* sync
              trace.storageSyncReadyAt = yield* Clock.currentTimeMillis
            })
          )
          this.confirmations.set(trace, confirmation)
        }
        yield* confirmation
      }
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
