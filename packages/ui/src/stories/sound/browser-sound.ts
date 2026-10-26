import { Deferred, Effect } from "effect"

import { SoundIssue, type SoundCue, type SoundPorts } from "./sound.machine"

const cues: Record<SoundCue, readonly [number, number]> = {
  complete: [660, 880],
  attention: [440, 349.23],
}

/** Browser capability only. The owning machine admits every audition.
 * Context creation/resume happens only during an active click gesture. */
export function makeBrowserSoundPorts(): SoundPorts {
  const active = new Map<string, Deferred.Deferred<void>>()
  const cancelled = new Set<string>()
  return {
    play: (request) =>
      Effect.gen(function* () {
        const cancel = yield* Effect.acquireRelease(
          Deferred.make<void>().pipe(
            Effect.tap((gate) =>
              Effect.sync(() => active.set(request.receipt, gate))
            )
          ),
          () =>
            Effect.sync(() => {
              active.delete(request.receipt)
              cancelled.delete(request.receipt)
            })
        )
        if (cancelled.has(request.receipt) || document.hidden)
          return "cancelled" as const
        const render = Effect.gen(function* () {
          const context = yield* Effect.acquireRelease(
            Effect.try({
              try: () => {
                if (!window.AudioContext)
                  throw new SoundIssue({
                    message: "Web Audio is unavailable in this browser.",
                  })
                if (
                  navigator.userActivation &&
                  !navigator.userActivation.isActive
                )
                  throw new SoundIssue({
                    message:
                      "Audio needs a direct click. Enable again, then choose a cue.",
                  })
                return new AudioContext()
              },
              catch: (error) =>
                error instanceof SoundIssue
                  ? error
                  : new SoundIssue({
                      message:
                        "Audio could not start. Check browser sound permissions, then enable again.",
                    }),
            }),
            (audio) =>
              Effect.promise(() =>
                audio.state === "closed" ? Promise.resolve() : audio.close()
              )
          )
          yield* Effect.tryPromise({
            try: () => context.resume(),
            catch: () =>
              new SoundIssue({
                message:
                  "Audio was blocked. Check browser sound permissions, then enable again.",
              }),
          })
          if (document.hidden) return "cancelled" as const
          if (context.state !== "running")
            return yield* new SoundIssue({
              message:
                "Audio is suspended. Check browser sound permissions, then enable again.",
            })
          const nodes: { oscillator: OscillatorNode; gain: GainNode }[] = []
          yield* Effect.acquireRelease(Effect.void, () =>
            Effect.sync(() => {
              for (const { oscillator, gain } of nodes) {
                gain.gain.cancelScheduledValues(context.currentTime)
                gain.gain.setValueAtTime(0, context.currentTime)
                oscillator.stop()
                oscillator.disconnect()
                gain.disconnect()
              }
            })
          )
          yield* Effect.sync(() => {
            for (const [index, frequency] of cues[request.cue].entries()) {
              const oscillator = context.createOscillator(),
                gain = context.createGain()
              const start = context.currentTime + index * 0.105
              nodes.push({ oscillator, gain })
              oscillator.type = "sine"
              oscillator.frequency.setValueAtTime(frequency, start)
              gain.gain.setValueAtTime(0, start)
              gain.gain.linearRampToValueAtTime(0.025, start + 0.006)
              gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.09)
              oscillator.connect(gain)
              gain.connect(context.destination)
              oscillator.start(start)
              oscillator.stop(start + 0.095)
            }
          })
          yield* Effect.sleep(240)
          return "played" as const
        })
        return yield* Effect.raceFirst(
          render,
          Deferred.await(cancel).pipe(Effect.as("cancelled" as const))
        )
      }),
    cancel: (request) =>
      Effect.suspend(() => {
        cancelled.add(request.receipt)
        const gate = active.get(request.receipt)
        return gate
          ? Deferred.succeed(gate, undefined).pipe(Effect.asVoid)
          : Effect.void
      }),
  }
}
