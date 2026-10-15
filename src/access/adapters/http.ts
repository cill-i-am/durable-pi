import { preserveFatal } from "../../shared/effect"
import { Effect, Schema } from "effect"
import {
  AccessConflict,
  AccessDenied,
  DecideApproval,
  UpdatePolicy,
} from "../contracts"
import type { AccessGate } from "../gate"
import { jsonRequest } from "../../shared/http"

export function accessRequest(
  gate: AccessGate,
  request: Request,
  path: string,
  canWrite: () => boolean
) {
  return Effect.gen(function* () {
    if (request.method === "GET" && path === "access")
      return yield* gate.state()
    if (request.method !== "POST")
      return yield* new AccessConflict({
        message: "Use POST to change tool access.",
      })
    const input = yield* jsonRequest(
      request,
      Schema.Unknown,
      4096,
      () =>
        new AccessConflict({
          message:
            "The access request could not be completed. Refresh and try again.",
        })
    )
    if (!canWrite())
      return yield* new AccessDenied({
        message: "Restore this bot before changing its access.",
      })
    if (path === "access/policy") {
      const body = yield* Schema.decodeUnknownEffect(UpdatePolicy)(input)
      yield* gate.updatePolicy(body.name, body.expectedRevision, body.mode)
    } else if (path === "access/decide") {
      const body = yield* Schema.decodeUnknownEffect(DecideApproval)(input)
      yield* gate.decide(
        body.id,
        body.approve,
        body.expectedRevision,
        body.remember
      )
    } else
      return yield* new AccessConflict({ message: "Unknown access request." })
    return yield* gate.state()
  }).pipe(
    Effect.map((value) => Response.json(value)),
    preserveFatal,
    Effect.catchTags({
      AccessDenied: (error) => rejected(error.message),
      AccessConflict: (error) => rejected(error.message),
      AccessStorageError: () => rejected(incomplete),
      SchemaError: () => rejected(incomplete),
    })
  )
}

const incomplete =
  "The access request could not be completed. Refresh and try again."
const rejected = (error: string) =>
  Effect.succeed(Response.json({ error }, { status: 409 }))
