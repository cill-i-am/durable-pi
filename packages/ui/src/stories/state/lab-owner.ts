import { createEffectActor } from "@xstate/effect"
import { Effect } from "effect"

import { makeLabSimulation } from "./lab-simulation"
import { labMachine, type LabPorts } from "./lab.machine"

/** The caller owns the Effect scope and must join its closure. */
export function makeLab(ports?: LabPorts) {
  return Effect.gen(function* () {
    const simulation = yield* makeLabSimulation()
    const actor = yield* createEffectActor(
      labMachine(ports ?? simulation.ports)
    )
    return { actor, simulation }
  })
}
