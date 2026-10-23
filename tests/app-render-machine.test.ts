import { Effect, Exit } from "effect"
import { expect, it } from "vitest"
import { initialTransition, transition } from "xstate"

import { AppConflict } from "../src/apps/contracts"
import { appRenderMachine } from "../src/apps/render.machine"

it("the render machine accepts cancellation before any prepared result", () => {
  const machine = appRenderMachine<AppConflict>({
    prepare: Effect.never,
    execute: () => Effect.never,
    commit: () => Effect.never,
  })
  const [initial] = initialTransition(machine)
  const [cancelled] = transition(machine, initial, {
    type: "CANCEL",
    outcome: Exit.fail(new AppConflict({ message: "cancelled" })),
  })
  expect(cancelled.status).toBe("done")
  expect(cancelled.value).toBe("settled")
})
