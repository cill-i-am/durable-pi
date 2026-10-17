import { Cause, Effect, Exit, Schema } from "effect"

import { activityRequest } from "../../activity/adapters/http"
import {
  activityDirectory,
  type ActivityReadRpc,
} from "../../activity/adapters/rpc"
import {
  agentRpc,
  agentRpcNative,
  type AgentRpc,
} from "../../agents/adapters/rpc"
import { agentRuntimeReader } from "../../agents/adapters/statuses"
import { AgentId, agentObjectName, homeAgentId } from "../../agents/domain"
import { agentStatuses } from "../../agents/statuses"
import type { accountConnectionRpc } from "../../inference/adapters/account-rpc"
import { reportService } from "../../observability/events"
import { WorkerTelemetry } from "../../observability/worker"
import { releaseForwardedResponse } from "../../shared/adapters/response"
import { preserveFatal } from "../../shared/effect"
import { nativeOperation } from "../../shared/interop"
import {
  webhookAuthorizationRpc,
  WebhookAuthorizationFailure,
  type WebhookAuthorizationRpc,
} from "../../webhooks/adapters/authorization-rpc"
import { bearer } from "../../webhooks/adapters/crypto"

type Peer = AgentRpc &
  ActivityReadRpc &
  WebhookAuthorizationRpc &
  Parameters<typeof accountConnectionRpc>[0] & {
    fetch: (request: Request) => Promise<Response>
  }
export interface AgentGatewayBindings {
  AGENT: { getByName: (name: string) => Peer }
}
class AgentGatewayUnavailable extends Schema.TaggedError<AgentGatewayUnavailable>()(
  "AgentGatewayUnavailable",
  {}
) {}
const native = <T>(start: (signal: AbortSignal) => Promise<T>) =>
  nativeOperation(start, (cause, channel) => {
    if (
      Schema.decodeUnknownOption(WebhookAuthorizationFailure)(cause)._tag ===
      "Some"
    )
      return new AgentGatewayUnavailable()
    if (channel === "failure" || Schema.isSchemaError(cause)) throw cause
    return new AgentGatewayUnavailable()
  })

const forward = (peer: Peer, request: Request) =>
  Effect.gen(function* () {
    let acquired: Response | undefined
    yield* Effect.addFinalizer((exit) =>
      acquired && Exit.isFailure(exit)
        ? releaseForwardedResponse(acquired)
        : Effect.void
    )
    return yield* native((signal) =>
      peer.fetch(new Request(request, { signal })).then((response) => {
        acquired = response
        return response
      })
    )
  })

function suspendFamilyWork(
  root: Peer,
  owner: string,
  env: AgentGatewayBindings,
  request: Request
) {
  return Effect.gen(function* () {
    const profiles = yield* agentRpcNative(() => agentRpc(root).profiles())
    for (const profile of profiles) {
      const target = env.AGENT.getByName(agentObjectName(owner, profile.id))
      yield* agentRpcNative(() =>
        agentRpc(target).configure(
          profile.id === homeAgentId ? "" : owner,
          profile,
          owner
        )
      )
      const response = yield* forward(target, request)
      yield* releaseForwardedResponse(response)
      if (response.status !== 403)
        return new Response("Could not confirm suspension", { status: 503 })
    }
    return Response.json({ ok: true })
  })
}

export function agentGatewayProgram(
  request: Request,
  env: AgentGatewayBindings,
  own?: (work: Promise<void>) => void
) {
  return Effect.gen(function* () {
    yield* Effect.yieldNow
    const owner = request.headers.get("x-owner-id")
    if (!owner) return new Response("Unauthorized", { status: 401 })
    const url = new URL(request.url)
    if (
      !url.pathname.startsWith("/api/agent/") ||
      url.hostname === "alchemy-rpc"
    )
      return new Response("Not found", { status: 404 })
    const decoded = Schema.decodeUnknownOption(AgentId)(
      url.searchParams.get("agent") ?? homeAgentId
    )
    if (decoded._tag === "None")
      return new Response("Not found", { status: 404 })
    const root = env.AGENT.getByName(owner)
    const path = url.pathname.slice("/api/agent/".length)
    if (path === "family/suspend" && request.method === "POST") {
      return yield* suspendFamilyWork(root, owner, env, request)
    }
    if (path === "bots/statuses") {
      if (request.method !== "GET")
        return new Response("Method not allowed", { status: 405 })
      if (!own)
        return new Response("Bot status is temporarily unavailable", {
          status: 503,
        })
      const profiles = yield* agentRpcNative(() => agentRpc(root).profiles())
      return Response.json(
        yield* agentStatuses(
          profiles,
          agentRuntimeReader(
            (agent) =>
              agentRpc(
                env.AGENT.getByName(agentObjectName(owner, agent.id))
              ).status(),
            own
          )
        )
      )
    }
    if (path === "activity" || path.startsWith("activity/conversations/")) {
      if (!own)
        return new Response("Activity is temporarily unavailable", {
          status: 503,
        })
      return yield* activityRequest(
        activityDirectory(
          owner,
          root,
          (name) => env.AGENT.getByName(name),
          own
        ),
        decoded.value,
        request,
        path
      )
    }
    if (
      ["bots", "skills", "connections", "whatsapp", "model-account"].some(
        (base) => path === base || path.startsWith(`${base}/`)
      )
    )
      return yield* forward(root, request)
    const agent = yield* agentRpcNative(() =>
      agentRpc(root).profile(decoded.value)
    )
    if (!agent) return new Response("Not found", { status: 404 })
    const target = env.AGENT.getByName(agentObjectName(owner, agent.id))
    if (path === "webhooks/incoming") {
      const key = bearer(request)
      if (
        agent.status !== "active" ||
        !key ||
        !(yield* native(() =>
          webhookAuthorizationRpc(target).authorized(
            url.searchParams.get("routine") ?? "",
            key
          )
        ))
      )
        return new Response("Unauthorized", { status: 401 })
    }
    yield* agentRpcNative(() =>
      agentRpc(target).configure(
        agent.id === homeAgentId ? "" : owner,
        agent,
        owner
      )
    )
    return yield* forward(target, request)
  }).pipe(
    Effect.scoped,
    Effect.onExit((exit) =>
      Exit.isFailure(exit)
        ? Effect.sync(() => reportService(exit.cause, "agent"))
        : Effect.void
    ),
    preserveFatal,
    Effect.catchTags({
      AgentGatewayUnavailable: unavailable,
      AgentNotFound: unavailable,
      AgentConflict: unavailable,
      AgentStorageError: unavailable,
      AgentSynchronizationError: unavailable,
      AgentRuntimeUnavailable: unavailable,
    }),
    Effect.withSpan("Agent.gateway")
  )
}
const unavailable = () =>
  Effect.succeed(
    Response.json(
      { error: "This bot is temporarily unavailable. Please retry." },
      { status: 503 }
    )
  )
export async function agentGateway(
  request: Request,
  env: AgentGatewayBindings,
  ctx?: Pick<ExecutionContext, "waitUntil">
): Promise<Response> {
  const work = Effect.runPromiseExit(
    agentGatewayProgram(
      request,
      env,
      ctx ? (pending) => ctx.waitUntil(pending) : undefined
    ).pipe(Effect.provide(WorkerTelemetry)),
    { signal: request.signal }
  )
  let registration: Cause.Cause<never> | undefined
  try {
    ctx?.waitUntil(work)
  } catch (defect) {
    registration = Cause.die(defect)
  }
  const exit = await work
  if (registration) {
    if (Exit.isSuccess(exit)) {
      const cleanup = await Effect.runPromiseExit(
        releaseForwardedResponse(exit.value)
      )
      if (Exit.isFailure(cleanup))
        registration = Cause.combine(registration, cleanup.cause)
    } else registration = Cause.combine(registration, exit.cause)
    reportService(registration, "agent")
    throw registration
  }
  if (Exit.isFailure(exit)) throw exit.cause
  return exit.value
}
