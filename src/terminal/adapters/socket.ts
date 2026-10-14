export function validTerminalInput(data: string | ArrayBuffer): boolean {
  if (data instanceof ArrayBuffer) return data.byteLength <= 16_384
  if (typeof data !== "string" || data.length > 256) return false
  try {
    const v = JSON.parse(data) as {
      type?: unknown
      cols?: unknown
      rows?: unknown
    }
    return (
      v.type === "resize" &&
      typeof v.cols === "number" &&
      typeof v.rows === "number" &&
      Number.isInteger(v.cols) &&
      Number.isInteger(v.rows) &&
      v.cols >= 2 &&
      v.cols <= 240 &&
      v.rows >= 2 &&
      v.rows <= 100 &&
      Object.keys(v).length === 3
    )
  } catch {
    return false
  }
}
export function relayTerminal(
  upstream: WebSocket,
  allow: (direction: "input" | "output", bytes: number) => boolean,
  onClose: () => void
) {
  const pair = new WebSocketPair(),
    client = pair[0],
    server = pair[1]
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    onClose()
    try {
      server.close(1000, "Terminal disconnected")
    } catch {}
    try {
      upstream.close(1000, "Terminal disconnected")
    } catch {}
  }
  const size = (data: string | ArrayBuffer) =>
    typeof data === "string"
      ? new TextEncoder().encode(data).length
      : data.byteLength
  server.binaryType = "arraybuffer"
  upstream.binaryType = "arraybuffer"
  server.accept()
  upstream.accept()
  server.addEventListener("message", (event) => {
    const data = event.data
    if (!validTerminalInput(data) || !allow("input", size(data))) {
      close()
      return
    }
    try {
      upstream.send(data)
    } catch {
      close()
    }
  })
  upstream.addEventListener("message", (event) => {
    const data = event.data
    if (size(data) > 256 * 1024 || !allow("output", size(data))) {
      close()
      return
    }
    try {
      server.send(data)
    } catch {
      close()
    }
  })
  for (const socket of [server, upstream]) {
    socket.addEventListener("close", close)
    socket.addEventListener("error", close)
  }
  return {
    response: new Response(null, { status: 101, webSocket: client }),
    close,
  }
}
