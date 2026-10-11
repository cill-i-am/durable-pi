import { Effect, Schema } from "effect"
import {
  AccessConflict,
  AccessDenied,
  DecideApproval,
  UpdatePolicy,
} from "./contracts"
import type { AccessGate } from "./gate"
import { boundedBytes } from "../workspace/http"

export function accessRequest(
  gate: AccessGate,
  request: Request,
  path: string,
  canWrite: () => boolean
) {
  return Effect.tryPromise({
    try: async () => {
      if (request.method === "GET" && path === "access")
        return { tools: gate.store.policies(), approvals: gate.store.pending() }
      if (request.method !== "POST")
        throw new AccessConflict({ message: "Use POST to change tool access." })
      const input: unknown = JSON.parse(
        new TextDecoder().decode(await boundedBytes(request, 4096))
      )
      if (!canWrite())
        throw new AccessDenied({
          message: "Restore this bot before changing its access.",
        })
      if (path === "access/policy") {
        const body = Schema.decodeUnknownSync(UpdatePolicy)(input)
        gate.store.update(body.name, body.expectedRevision, body.mode)
      } else if (path === "access/decide") {
        const body = Schema.decodeUnknownSync(DecideApproval)(input)
        gate.store.decide(body.id, body.approve, body.expectedRevision)
      } else throw new AccessConflict({ message: "Unknown access request." })
      gate.notify()
      return { tools: gate.store.policies(), approvals: gate.store.pending() }
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.map((value) => Response.json(value)),
    Effect.catch((cause) =>
      Effect.succeed(
        Response.json(
          {
            error:
              cause instanceof AccessDenied || cause instanceof AccessConflict
                ? cause.message
                : "The access request could not be completed. Refresh and try again.",
          },
          { status: 409 }
        )
      )
    )
  )
}
