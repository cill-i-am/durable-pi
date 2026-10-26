import { createEffectActor } from "@xstate/effect"

import { makeBrowserSoundPorts } from "./browser-sound"
import { soundAuditionMachine, type SoundPorts } from "./sound.machine"

/** Caller owns the Effect scope and joins its closure before releasing ownership. */
export function makeSoundAudition(ports: SoundPorts = makeBrowserSoundPorts()) {
  return createEffectActor(soundAuditionMachine(ports))
}
