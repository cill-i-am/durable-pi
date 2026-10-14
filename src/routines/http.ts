import { Effect, Schema } from "effect"
import { boundedBytes } from "../workspace/http"
import type { RoutineStore } from "./adapters/sqlite"
import {
  RoutineConflict,
  RoutineId,
  SaveRoutine,
  SetRoutineStatus,
  RunRoutineNow,
} from "./contracts"

export function routinesRequest(
  store: RoutineStore,
  request: Request,
  path: string,
  wake: () => Promise<void>,
  stop: (id: string) => Promise<void>
) {
  return Effect.gen(function* () {
    if (path === "routines" && request.method === "GET")
      return Response.json({ routines: store.list(), runs: store.runs() })
    if (request.method !== "POST")
      return new Response("Not found", { status: 404 })
    const raw = yield* Effect.tryPromise(
      async () =>
        JSON.parse(
          new TextDecoder().decode(await boundedBytes(request, 60000))
        ) as unknown
    )
    if (path === "routines/stop") {
      const { id } = yield* Effect.try(() =>
        Schema.decodeUnknownSync(Schema.Struct({ id: RoutineId }))(raw)
      )
      yield* Effect.tryPromise(() => stop(id))
      return Response.json({ ok: true })
    }
    yield* Effect.tryPromise(wake)
    const value = yield* Effect.try(() => {
      switch (path) {
        case "routines/save":
          return store.save(Schema.decodeUnknownSync(SaveRoutine)(raw))
        case "routines/status":
          return store.setStatus(
            Schema.decodeUnknownSync(SetRoutineStatus)(raw)
          )
        case "routines/run":
          return store.runNow(Schema.decodeUnknownSync(RunRoutineNow)(raw))
        case "routines/cancel":
          return store.cancelOperation(
            Schema.decodeUnknownSync(Schema.Struct({ operationId: RoutineId }))(
              raw
            ).operationId
          )
        default:
          throw new RoutineConflict({ message: "Unknown routine action." })
      }
    })
    yield* Effect.tryPromise(wake)
    return Response.json(value)
  }).pipe(
    Effect.catch((cause) => {
      const error =
        cause instanceof RoutineConflict
          ? cause
          : typeof cause === "object" &&
              "cause" in cause &&
              cause.cause instanceof RoutineConflict
            ? cause.cause
            : null
      return Effect.succeed(
        Response.json(
          {
            error:
              error?.message ??
              "The routine request could not finish. Retry the same change.",
          },
          { status: 409 }
        )
      )
    })
  )
}
