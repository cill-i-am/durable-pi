import { createFileRoute } from "@tanstack/react-router"
import { authorizedOwner, sameOrigin } from "../auth/server"
import { getEnv } from "../env"

async function handle(request: Request) {
  const env = getEnv()
  if (
    (request.method !== "GET" ||
      request.headers.get("upgrade") === "websocket") &&
    !sameOrigin(request, env.APP_URL)
  )
    return new Response("Forbidden", { status: 403 })
  const user = await authorizedOwner(request, env)
  if (!user) return new Response("Unauthorized", { status: 401 })
  const headers = new Headers({
    "content-type": request.headers.get("content-type") ?? "application/json",
    "x-owner-id": user.id,
    "x-app-origin": new URL(env.APP_URL).origin,
  })
  if (request.headers.get("upgrade") === "websocket")
    headers.set("upgrade", "websocket")
  const response = await env.AGENT_SERVICE.fetch(
    new Request(
      `https://agent.internal${new URL(request.url).pathname}${new URL(request.url).search}`,
      {
        method: request.method,
        redirect: "manual",
        headers,
        signal: request.signal,
        body: request.method === "GET" ? undefined : request.body,
      }
    )
  )
  if (response.status === 101) return response
  const out = new Response(response.body, response)
  out.headers.set("Cache-Control", "private, no-store")
  out.headers.set("X-Content-Type-Options", "nosniff")
  return out
}
export const Route = createFileRoute("/api/agent/$")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
    },
  },
})
