import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"

import { orDieAll } from "@/shared/effect"

import {
  interactionSoundMachine,
  type InteractionSoundSession,
} from "./interaction-sound.machine"

const attempt = <T>(work: () => T) =>
  Effect.try({ try: work, catch: (cause) => cause })

/** Node finalizers are installed before the next acquisition or native call. */
export function playInteractionTone(
  audio: AudioContext,
  retainCleanup: (cause: Cause.Cause<unknown>) => void = () => {}
) {
  const release = (work: Effect.Effect<void, unknown>) =>
    work.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit)) retainCleanup(exit.cause)
        })
      ),
      orDieAll
    )
  return Effect.gen(function* () {
    let started = false
    let ended = false
    const oscillator = yield* Effect.acquireRelease(
      attempt(() => audio.createOscillator()),
      (node) =>
        release(
          attempt(() => {
            if (started && !ended) node.stop()
          }).pipe(
            Effect.ensuring(attempt(() => node.disconnect()).pipe(orDieAll))
          )
        )
    )
    const gain = yield* Effect.acquireRelease(
      attempt(() => audio.createGain()),
      (node) => release(attempt(() => node.disconnect()))
    )
    const finished = yield* Deferred.make<void>()
    const onEnded = () => {
      ended = true
      Deferred.doneUnsafe(finished, Effect.void)
    }
    yield* Effect.acquireRelease(
      attempt(() =>
        oscillator.addEventListener("ended", onEnded, { once: true })
      ),
      () =>
        release(attempt(() => oscillator.removeEventListener("ended", onEnded)))
    )
    yield* attempt(() => {
      const start = audio.currentTime
      const end = start + 0.02
      oscillator.type = "triangle"
      oscillator.frequency.setValueAtTime(850, start)
      oscillator.frequency.exponentialRampToValueAtTime(160, end)
      gain.gain.setValueAtTime(0.12, start)
      gain.gain.exponentialRampToValueAtTime(0.0001, end)
      oscillator.connect(gain)
      gain.connect(audio.destination)
      oscillator.start(start)
      started = true
      oscillator.stop(end)
    })
    yield* Deferred.await(finished)
  })
}

/** One component owns a lazy context; each activation has its own scoped actor. */
export function makeInteractionSoundResource(
  create: () => AudioContext | null,
  enabled: () => boolean
) {
  return Effect.gen(function* () {
    const owner = yield* Effect.scope
    const cleanupFailures: Cause.Cause<unknown>[] = []
    yield* Effect.addFinalizer(() =>
      cleanupFailures.length
        ? Effect.failCause(
            Cause.fromReasons(cleanupFailures.flatMap((cause) => cause.reasons))
          ).pipe(orDieAll)
        : Effect.void
    )
    // This scope is registered before request fibers, so their nodes are released
    // before context closure. The close promise itself is joined by this scope.
    const resources = yield* Scope.fork(owner)
    let session: InteractionSoundSession | null = null
    const acquire = Effect.suspend(() => {
      if (session) return Effect.succeed(session)
      return Effect.gen(function* () {
        const audio = yield* Effect.acquireRelease(attempt(create), (audio) =>
          audio
            ? Effect.tryPromise({
                try: () => audio.close(),
                catch: (cause) => cause,
              }).pipe(orDieAll)
            : Effect.void
        )
        if (!audio) return null
        session = {
          state: () => audio.state,
          // Resume has no abort API. Cancelling its observer fences late results;
          // context closure releases native audio. Joining resume before closing
          // would hang shutdown when the browser is waiting for user activation.
          resume: Effect.tryPromise({
            try: () => audio.resume(),
            catch: (cause) => cause,
          }),
          play: playInteractionTone(audio, (cause) =>
            cleanupFailures.push(cause)
          ),
        }
        return session
      }).pipe(Effect.provideService(Scope.Scope, resources))
    })
    const machine = interactionSoundMachine({ acquire, enabled })
    const play = (preview = false) =>
      Effect.gen(function* () {
        const actor = yield* createEffectActor(machine)
        yield* send(actor, { type: "PLAY", preview })
        const settled = yield* waitFor(
          actor,
          (snapshot) => snapshot.status === "done"
        )
        return settled.context.outcome ?? Exit.void
      }).pipe(Effect.scoped, Effect.forkIn(owner), Effect.flatMap(Fiber.join))
    return { play }
  })
}
