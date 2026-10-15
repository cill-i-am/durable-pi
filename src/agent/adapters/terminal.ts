import { Cause } from "effect"

/** A native upgrade must retain its WebSocket metadata. A response acquired
 * after caller departure is still ours to close before the host call settles. */
export async function proxyTerminalRequest(
  request: Request,
  binding: { fetch: (request: Request) => Promise<Response> },
  actor: string
): Promise<Response> {
  const cancelled = () => request.signal.aborted
  if (cancelled()) throw Cause.interrupt()
  const path = new URL(request.url).pathname.replace("/api/agent/", "")
  const response = await binding.fetch(
    new Request(
      `https://terminal.internal/${actor}/${path}${new URL(request.url).search}`,
      request
    )
  )
  if (!cancelled()) return response
  const failures: Cause.Reason<never>[] = [Cause.makeInterruptReason()]
  const socket = response.webSocket
  if (socket && socket.readyState < 2) {
    try {
      socket.accept()
    } catch (cause) {
      failures.push(Cause.makeDieReason(cause))
    }
    try {
      socket.close(1000, "Request cancelled")
    } catch (cause) {
      failures.push(Cause.makeDieReason(cause))
    }
  }
  try {
    if (response.body && !response.bodyUsed && !response.body.locked)
      await response.body.cancel()
  } catch (cause) {
    failures.push(Cause.makeDieReason(cause))
  }
  throw Cause.fromReasons(failures)
}
