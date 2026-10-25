import { Effect, Exit, Scope } from "effect"
import { useEffect, useRef } from "react"

import { isInteractionSoundEnabled } from "./interaction-sound-preference"
import { makeInteractionSoundResource } from "./interaction-sound-resource"

type SoundResource = Effect.Success<
  ReturnType<typeof makeInteractionSoundResource>
>

export const useInteractionSound = () => {
  const resource = useRef<SoundResource | null>(null)

  useEffect(() => {
    const scope = Effect.runSync(Scope.make())
    resource.current = Effect.runSync(
      makeInteractionSoundResource(
        () => ("AudioContext" in window ? new AudioContext() : null),
        isInteractionSoundEnabled
      ).pipe(Effect.provideService(Scope.Scope, scope))
    )
    return () => {
      resource.current = null
      // React cleanup cannot await. The closing Effect retains ownership until
      // every click scope and the native AudioContext.close promise have joined.
      Effect.runFork(
        Scope.close(scope, Exit.void).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("InteractionSound.cleanupFailed", cause)
          )
        )
      )
    }
  }, [])

  return async ({ preview = false }: { preview?: boolean } = {}) => {
    const sound = resource.current
    if (sound) await Effect.runPromiseExit(sound.play(preview))
  }
}
