import { Effect } from "effect"

import { agentProxy } from "../../src/auth/adapters/agent-proxy"

const cancellations = new Map<string, number>()
const bytes = new TextEncoder()

export async function eventStreamProbe(
  request: Request,
  ctx: ExecutionContext
) {
  const url = new URL(request.url)
  const path = url.pathname
  const id = url.searchParams.get("id") ?? "default"
  if (path === "/encoding/state")
    return Response.json({ cancellations: cancellations.get(id) ?? 0 })
  if (path !== "/encoding/stream" && path !== "/encoding/probe-failure")
    return new Response("Not found", { status: 404 })
  cancellations.set(id, 0)
  let timer: ReturnType<typeof setInterval>
  const response = await agentProxy(request, {
    appUrl: new URL(request.url).origin,
    owner: Effect.succeed({ id: "synthetic-encoding-owner" }),
    own: (pending) => ctx.waitUntil(pending),
    forward: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            value.enqueue(bytes.encode("data: first\n\n"))
            timer = setInterval(() => {
              if (path === "/encoding/probe-failure") {
                clearInterval(timer)
                value.error(new Error("Synthetic encoding source failure"))
              } else value.enqueue(bytes.encode(": keepalive\n\n"))
            }, 300)
          },
          cancel() {
            cancellations.set(id, (cancellations.get(id) ?? 0) + 1)
            clearInterval(timer)
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      ),
  })
  if (path === "/encoding/probe-failure") {
    const reader = response.body!.getReader()
    let received = false
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) return Response.json({ received, failed: false })
        received ||= next.value.length > 0
      }
    } catch {
      return Response.json({ received, failed: true })
    }
  }
  // Frameworks may clone Responses; the manual encoding flag must survive it.
  return new Response(response.body, response)
}
