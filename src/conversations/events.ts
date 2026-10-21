import { Deferred, Effect, Exit, Queue, Scope } from "effect"

import { observeCleanup } from "../shared/effect"
import type { ChatState } from "./contracts"

export interface ConversationEventSource<TError, TRequirements = never> {
  snapshot: () => Effect.Effect<ChatState, TError, TRequirements>
  beforePublish?: (
    state: ChatState,
    previous: ChatState | undefined
  ) => Effect.Effect<void, TError, TRequirements>
  activeSession: () => Effect.Effect<string | undefined, TError, TRequirements>
  watch: (
    id: string,
    notify: () => void
  ) => Effect.Effect<void, TError, TRequirements | Scope.Scope>
  subscribe: (
    notify: () => void
  ) => Effect.Effect<void, TError, TRequirements | Scope.Scope>
}
export interface ConversationEventSink {
  publish: (state: ChatState, previous: ChatState | undefined) => boolean
  heartbeat: () => boolean
}

/** One scope owns subscription, session watcher, coalesced refresh and timers.
 * Lifecycle/HTTP interprets the completion; this program owns no SDK handles. */
export function conversationEventPump<TError, TRequirements>(
  source: ConversationEventSource<TError, TRequirements>,
  sink: ConversationEventSink
) {
  return Effect.fn("Conversations.stream")(function* () {
    const scope = yield* Scope.Scope
    const changes = yield* Queue.sliding<void>(1)
    const ended = yield* Deferred.make<void>()
    const notify = () => {
      Queue.offerUnsafe(changes, undefined)
    }
    const finish = () => {
      Deferred.doneUnsafe(ended, Effect.void)
    }
    yield* source.subscribe(notify)
    let previous: ChatState | undefined
    let session: string | undefined
    let watchScope: Scope.Closeable | undefined
    const refresh = Effect.gen(function* () {
      const active = yield* source.activeSession()
      if (active !== session) {
        if (watchScope) yield* Scope.close(watchScope, Exit.void)
        session = active
        watchScope = undefined
        if (active) {
          watchScope = yield* Scope.fork(scope, "sequential")
          yield* source
            .watch(active, notify)
            .pipe(Effect.provideService(Scope.Scope, watchScope))
        }
      }
      const current = yield* source.snapshot()
      if (source.beforePublish) yield* source.beforePublish(current, previous)
      if (!sink.publish(current, previous)) finish()
      previous = current
    })
    const heartbeat = Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(15_000)
        if (!sink.heartbeat()) finish()
        else notify()
      })
    )
    yield* heartbeat.pipe(Effect.forkScoped)
    const updates = Effect.gen(function* () {
      yield* refresh
      for (;;) {
        yield* Queue.take(changes)
        yield* Queue.clear(changes)
        yield* refresh
        // Publish the leading change without a debounce penalty. Changes
        // during this interval remain in the sliding queue for the next pass.
        yield* Effect.sleep(80)
      }
    })
    yield* observeCleanup(updates, (observed) =>
      Effect.raceFirst(
        observed,
        Effect.raceFirst(Deferred.await(ended), Effect.sleep(60_000))
      )
    )
  })
}
