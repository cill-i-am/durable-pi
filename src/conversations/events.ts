import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Clock, Effect, Exit, Queue, Scope } from "effect"

import { fatalCause } from "../shared/effect"
import type { ChatState } from "./contracts"
import { conversationObserverMachine } from "./event-observer.machine"

export interface ConversationEventSource<TError, TRequirements = never> {
  snapshot: () => Effect.Effect<ChatState, TError, TRequirements>
  beforePublish?: (
    state: ChatState,
    previous: ChatState | undefined
  ) => Effect.Effect<void, TError, TRequirements>
  afterPublish?: Effect.Effect<void, TError, TRequirements | Scope.Scope>
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

/** The machine owns observation progression. This scope owns subscription,
 * the replaceable native watcher and every joined invocation. */
export function conversationEventPump<TError, TRequirements>(
  source: ConversationEventSource<TError, TRequirements>,
  sink: ConversationEventSink
) {
  return Effect.fn("Conversations.stream")(function* () {
    const scope = yield* Scope.Scope
    const changes = yield* Queue.sliding<void>(1)
    const notify = () => {
      Queue.offerUnsafe(changes, undefined)
    }
    let watcher: Scope.Closeable | undefined
    const failures: Cause.Cause<unknown>[] = []
    const observe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (
              Exit.isFailure(exit) &&
              (Cause.hasDies(exit.cause) ||
                (Cause.hasInterrupts(exit.cause) &&
                  !Cause.hasInterruptsOnly(exit.cause)))
            )
              failures.push(exit.cause)
          })
        )
      )
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() =>
        failures.length
          ? Effect.failCause(
              fatalCause(
                Cause.fromReasons(failures.flatMap((cause) => cause.reasons))
              )
            )
          : Effect.void
      )
    )
    const release = Effect.suspend(() =>
      watcher
        ? Scope.close(watcher, Exit.void).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                watcher = undefined
              })
            )
          )
        : Effect.void
    )
    yield* Effect.addFinalizer(() => release)
    yield* source.subscribe(notify)
    const actor = yield* createEffectActor(
      conversationObserverMachine({
        changed: Queue.take(changes),
        active: observe(Effect.suspend(source.activeSession)),
        release: observe(release),
        watch: (id) =>
          observe(
            Effect.gen(function* () {
              watcher = yield* Scope.make()
              yield* source.watch(id, notify).pipe(Scope.provide(watcher))
            })
          ),
        snapshot: observe(Effect.suspend(source.snapshot)),
        publish: (current, previous) =>
          observe(
            Effect.gen(function* () {
              if (source.beforePublish)
                yield* source.beforePublish(current, previous)
              const at = yield* Clock.currentTimeMillis
              const accepted = yield* Effect.sync(() =>
                sink.publish(current, previous)
              )
              if (accepted && source.afterPublish)
                yield* source.afterPublish.pipe(
                  Effect.provideService(Scope.Scope, scope)
                )
              return { accepted, at }
            })
          ),
        heartbeat: observe(Effect.sync(sink.heartbeat)),
      })
    )
    const settled = yield* waitFor(
      actor,
      (snapshot) => snapshot.status === "done"
    )
    return yield* settled.output!
  })
}
