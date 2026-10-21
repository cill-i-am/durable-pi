import { Clock, Effect } from "effect"

export type HandoffQueue = {
  readonly desiredSize: number | null
  readonly pullCount: number
  readonly lastPullAt: number | undefined
}
export type HandoffPublication = {
  readonly turnId: string
  readonly attemptId: string
  readonly streamId: string
  readonly publishedAt: number
  readonly enqueuedAt: number
  readonly queue: HandoffQueue
}

/** A bounded, scoped diagnostic only. Timers expose event-loop progress after
 * enqueue; sync joins actual durability without weakening write confirmation.
 * No message data or SQL is retained. Worker clocks advance at I/O boundaries. */
export const probeHandoff = Effect.fn("Conversations.probeHandoff")(
  (
    publication: HandoffPublication,
    sync: Effect.Effect<void>,
    queue: () => HandoffQueue
  ) =>
    Effect.gen(function* () {
      const samples: {
        requestedAt: number
        resumedAt: number
        confirmedAt: number
        queue: HandoffQueue
      }[] = []
      for (const delay of [1, 25, 100, 500]) {
        const requestedAt = yield* Clock.currentTimeMillis
        yield* Effect.sleep(delay)
        const resumedAt = yield* Clock.currentTimeMillis
        yield* sync
        samples.push({
          requestedAt,
          resumedAt,
          confirmedAt: yield* Clock.currentTimeMillis,
          queue: queue(),
        })
      }
      yield* Effect.logInfo("Conversation.firstTextActor").pipe(
        Effect.annotateLogs({ ...publication, samples })
      )
    })
)
