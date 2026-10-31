import { createEffectActor } from "@xstate/effect"

import {
  decisionDockMachine,
  type DecisionDockView,
} from "./decision-dock.machine"

/** The mounted conversation owns this scope. No presentation state is persisted. */
export const makeDecisionDockOwner = (input: DecisionDockView) =>
  createEffectActor(decisionDockMachine, { input })
