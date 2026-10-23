import { createEffectActor, waitFor } from "@xstate/effect"
import { Effect, Schema } from "effect"

import { preserveFatal } from "../../shared/effect"
import { jsonRequest } from "../../shared/http"
import { routineCommandMachine } from "../command.machine"
import {
  RoutineConflict,
  RoutineId,
  SaveRoutine,
  SetRoutineStatus,
  RunRoutineNow,
} from "../contracts"
import type { Routines, RoutineError } from "../service"

export function routinesRequest<TRequirements>(
  store: Routines["Service"],
  request: Request,
  path: string,
  wake: () => Effect.Effect<number, RoutineError, TRequirements>,
  stop: (id: string) => Effect.Effect<void, RoutineError, TRequirements>
) {
  return Effect.gen(function* () {
    if (path === "routines" && request.method === "GET")
      return Response.json({
        routines: yield* store.list(),
        runs: yield* store.runs(),
      })
    if (request.method !== "POST")
      return new Response("Not found", { status: 404 })
    const raw = yield* jsonRequest(
      request,
      Schema.Unknown,
      60000,
      () => new RoutineConflict({ message: "Invalid routine request." })
    )
    if (path === "routines/stop") {
      const { id } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ id: RoutineId })
      )(raw)
      yield* stop(id)
      return Response.json({ ok: true })
    }
    const execute = (deadline: number) =>
      Effect.gen(function* () {
        switch (path) {
          case "routines/save":
            return yield* store.save(
              yield* Schema.decodeUnknownEffect(SaveRoutine)(raw),
              deadline
            )
          case "routines/status":
            return yield* store.setStatus(
              yield* Schema.decodeUnknownEffect(SetRoutineStatus)(raw),
              deadline
            )
          case "routines/run":
            return yield* store.runNow(
              yield* Schema.decodeUnknownEffect(RunRoutineNow)(raw),
              deadline
            )
          case "routines/cancel":
            return yield* store.cancelOperation(
              (yield* Schema.decodeUnknownEffect(
                Schema.Struct({ operationId: RoutineId })
              )(raw)).operationId
            )
          default:
            return yield* new RoutineConflict({
              message: "Unknown routine action.",
            })
        }
      })
    const { operationId } = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ operationId: RoutineId })
    )(raw)
    const enabling =
      path === "routines/run" ||
      ((path === "routines/save" || path === "routines/status") &&
        typeof raw === "object" &&
        raw !== null &&
        "status" in raw &&
        raw.status === "active")
    const actor = yield* createEffectActor(
      routineCommandMachine({
        needsDiscovery: enabling
          ? store
              .operationExists(operationId)
              .pipe(Effect.map((exists) => !exists))
          : Effect.succeed(false),
        arm: Effect.suspend(wake),
        execute,
        acknowledge: Effect.suspend(wake),
      })
    )
    const done = yield* waitFor(actor, (state) => state.status === "done").pipe(
      Effect.orDie
    )
    return Response.json(yield* done.output!)
  }).pipe(
    Effect.scoped,
    preserveFatal,
    Effect.catchTags({
      RoutineConflict: (error) => rejected(error.message),
      RoutineStorageError: () => rejected(incomplete),
      SchemaError: () => rejected(incomplete),
    })
  )
}
const incomplete =
  "The routine request could not finish. Retry the same change."
const rejected = (error: string) =>
  Effect.succeed(Response.json({ error }, { status: 409 }))
