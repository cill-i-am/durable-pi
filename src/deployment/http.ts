import { Schema } from "effect"

import { matchesSecret } from "../auth/server"
import { Deployment } from "./readiness"
import { buildRevision } from "./revision"

/** CI's existing setup capability can inspect deployment versions only. It
 * cannot choose an account/actor or invoke a conversation through this route. */
export async function deploymentResponse(
  request: Request,
  secret: string,
  read: () => Promise<{ worker: string; agents: string[] }>
): Promise<Response> {
  const headers = { "cache-control": "private, no-store" }
  if (
    !(await matchesSecret(request.headers.get("x-setup-token") ?? "", secret))
  )
    return new Response("Unauthorized", { status: 401, headers })
  try {
    return Response.json(
      Schema.decodeUnknownSync(Deployment)({
        ...(await read()),
        website: buildRevision,
      }),
      { headers }
    )
  } catch {
    return new Response("Deployment is still becoming available.", {
      status: 503,
      headers,
    })
  }
}
