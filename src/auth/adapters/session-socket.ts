import { Cause } from "effect"

type SocketPeer = Pick<
  WebSocket,
  "close" | "send" | "addEventListener" | "removeEventListener"
>
type SessionUpstream = SocketPeer & Pick<WebSocket, "accept" | "binaryType">

export function bindSessionSocket(
  browser: SocketPeer,
  upstream: SocketPeer,
  authorized: () => Promise<boolean>,
  failed: (cause: unknown) => void = () => {}
) {
  let closed = false
  let deadline = Date.now() + 15_000
  let checking = false
  function close(code = 1000, reason = "Connection closed") {
    if (closed) return
    closed = true
    clearInterval(timer)
    browser.removeEventListener("message", fromBrowser)
    upstream.removeEventListener("message", fromUpstream)
    const failures: Cause.Reason<never>[] = []
    for (const socket of [browser, upstream]) {
      socket.removeEventListener("close", disconnected)
      socket.removeEventListener("error", disconnected)
      try {
        socket.close(code, reason)
      } catch (cause) {
        failures.push(Cause.makeDieReason(cause))
      }
    }
    if (failures.length) throw Cause.fromReasons(failures)
  }
  function closeSafely(code = 1000, reason = "Connection closed") {
    try {
      close(code, reason)
    } catch (cause) {
      failed(cause)
    }
  }
  const timer = setInterval(() => {
    if (Date.now() >= deadline) return closeSafely(1008, "Sign in again")
    if (checking) return
    checking = true
    void authorized()
      .then((allowed) => {
        if (!allowed) closeSafely(1008, "Sign in again")
        else if (!closed) deadline = Date.now() + 15_000
      })
      .catch((cause) => {
        closeSafely(1011, "Could not verify session")
        failed(cause)
      })
      .finally(() => {
        checking = false
      })
  }, 5_000)
  function forward(target: SocketPeer, value: string | ArrayBuffer) {
    if (closed) return
    if (Date.now() >= deadline) return closeSafely(1008, "Sign in again")
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value).length
        : value.byteLength
    if (bytes > 256 * 1024) return closeSafely(1009, "Message too large")
    try {
      target.send(value)
    } catch {
      closeSafely()
    }
  }
  const fromBrowser = (event: MessageEvent) => forward(upstream, event.data)
  const fromUpstream = (event: MessageEvent) => forward(browser, event.data)
  const disconnected = () => closeSafely()
  browser.addEventListener("message", fromBrowser)
  upstream.addEventListener("message", fromUpstream)
  for (const socket of [browser, upstream]) {
    socket.addEventListener("close", disconnected)
    socket.addEventListener("error", disconnected)
  }
  return close
}

export interface SessionSocket {
  readonly response: Response
  readonly close: () => void
}
export function sessionSocketResponse(
  upstream: SessionUpstream,
  authorized: () => Promise<boolean>,
  failed: (cause: unknown) => void
): SessionSocket {
  const pair = new WebSocketPair()
  let close: (() => void) | undefined
  try {
    pair[1].accept()
    upstream.accept()
    pair[1].binaryType = upstream.binaryType = "arraybuffer"
    close = bindSessionSocket(pair[1], upstream, authorized, failed)
    return {
      response: new Response(null, { status: 101, webSocket: pair[0] }),
      close,
    }
  } catch (cause) {
    const failures: Cause.Reason<never>[] = Cause.isCause(cause)
      ? [...cause.reasons].map((reason) =>
          reason._tag === "Fail" ? Cause.makeDieReason(reason) : reason
        )
      : [Cause.makeDieReason(cause)]
    if (close) {
      try {
        close()
      } catch (cleanup) {
        if (Cause.isCause(cleanup))
          failures.push(
            ...cleanup.reasons.map((reason) =>
              reason._tag === "Fail" ? Cause.makeDieReason(reason) : reason
            )
          )
        else failures.push(Cause.makeDieReason(cleanup))
      }
    } else
      for (const socket of [pair[1], upstream]) {
        try {
          socket.close(1011, "Could not open session")
        } catch (cleanup) {
          failures.push(Cause.makeDieReason(cleanup))
        }
      }
    throw Cause.fromReasons(failures)
  }
}
