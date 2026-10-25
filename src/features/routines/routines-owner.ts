import { createEffectActor } from "@xstate/effect"
import { Effect, Schema } from "effect"

import { agentApi } from "@/http/client"
import { RoutineChange, RoutineList } from "@/routines/contracts"
import { nativeOperation } from "@/shared/interop"

import { routineWorkFailures } from "./routine-work"
import { routinesUiMachine, type RoutinesWork } from "./routines-ui.machine"

export function routinesRequests(agentId: string): RoutinesWork {
  const request = (path: string, body?: unknown) =>
    nativeOperation(
      (signal) => agentApi(agentId)(path, body, signal),
      (cause) => cause
    )
  const read = () =>
    request("routines").pipe(Effect.map(Schema.decodeUnknownSync(RoutineList)))
  return {
    read,
    change: (input) =>
      request(`routines/${input.path}`, input.body).pipe(
        Effect.map(Schema.decodeUnknownSync(RoutineChange))
      ),
    resolve: (input) =>
      Effect.gen(function* () {
        const result = yield* request("routines/cancel", {
          operationId: input.body.operationId,
        }).pipe(
          Effect.map(
            Schema.decodeUnknownSync(Schema.Struct({ applied: Schema.Boolean }))
          )
        )
        const data = yield* read()
        return { applied: result.applied, data }
      }),
    stop: (id) => request("routines/stop", { id }).pipe(Effect.andThen(read())),
  }
}
export function makeRoutinesOwner(
  view: string,
  work: RoutinesWork,
  visible = true
) {
  return Effect.gen(function* () {
    const observe = yield* routineWorkFailures
    return yield* createEffectActor(
      routinesUiMachine({
        read: () => observe(work.read()),
        change: (input) => observe(work.change(input)),
        resolve: (input) => observe(work.resolve(input)),
        stop: (id) => observe(work.stop(id)),
      }),
      { input: { view, visible } }
    )
  })
}
