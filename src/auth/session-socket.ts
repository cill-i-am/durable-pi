/** A browser socket never outlives its database-backed session authorization. */
export function bindSessionSocket(
  browser: WebSocket,
  upstream: WebSocket,
  authorized: () => Promise<boolean>
) {
  let closed = false
  let deadline = Date.now() + 15_000
  let checking = false
  function close(code = 1000, reason = "Connection closed") {
    if (closed) return
    closed = true
    clearInterval(timer)
    for (const socket of [browser, upstream]) {
      try {
        socket.close(code, reason)
      } catch {
        /* Already disconnected. */
      }
    }
  }
  // The deadline is enforced even while a slow database check is outstanding.
  const timer = setInterval(() => {
    if (Date.now() >= deadline) return close(1008, "Sign in again")
    if (checking) return
    checking = true
    void authorized()
      .then((allowed) => {
        if (!allowed) close(1008, "Sign in again")
        else if (!closed) deadline = Date.now() + 15_000
      })
      .catch(() => close(1011, "Could not verify session"))
      .finally(() => {
        checking = false
      })
  }, 5_000)
  function forward(target: WebSocket, value: string | ArrayBuffer) {
    if (closed) return
    if (Date.now() >= deadline) return close(1008, "Sign in again")
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value).length
        : value.byteLength
    if (bytes > 256 * 1024) return close(1009, "Message too large")
    try {
      target.send(value)
    } catch {
      close()
    }
  }
  browser.addEventListener("message", (event) => forward(upstream, event.data))
  upstream.addEventListener("message", (event) => forward(browser, event.data))
  for (const socket of [browser, upstream]) {
    socket.addEventListener("close", () => close())
    socket.addEventListener("error", () => close())
  }
}

export function sessionSocketResponse(
  upstream: WebSocket,
  authorized: () => Promise<boolean>
) {
  const pair = new WebSocketPair()
  pair[1].accept()
  upstream.accept()
  pair[1].binaryType = upstream.binaryType = "arraybuffer"
  bindSessionSocket(pair[1], upstream, authorized)
  return new Response(null, { status: 101, webSocket: pair[0] })
}
