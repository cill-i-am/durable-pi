import { Effect, Schema } from "effect"

import { preserveFatal } from "../../shared/effect"
import { jsonRequest } from "../../shared/http"
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
  wake: () => Effect.Effect<void, RoutineError, TRequirements>,
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
    yield* wake()
    const value = yield* Effect.gen(function* () {
      switch (path) {
        case "routines/save":
          return yield* store.save(
            yield* Schema.decodeUnknownEffect(SaveRoutine)(raw)
          )
        case "routines/status":
          return yield* store.setStatus(
            yield* Schema.decodeUnknownEffect(SetRoutineStatus)(raw)
          )
        case "routines/run":
          return yield* store.runNow(
            yield* Schema.decodeUnknownEffect(RunRoutineNow)(raw)
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
    yield* wake()
    return Response.json(value)
  }).pipe(
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
