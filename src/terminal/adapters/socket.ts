import { Option, Schema } from "effect"
import type { TerminalSocket } from "../runtime"

const Resize = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("resize"),
    cols: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 2, maximum: 240 })
    ),
    rows: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 2, maximum: 100 })
    ),
  })
)
const resize = Schema.decodeUnknownOption(Resize, { onExcessProperty: "error" })
export function validTerminalInput(data: string | ArrayBuffer): boolean {
  return typeof data === "string"
    ? data.length <= 256 && Option.isSome(resize(data))
    : data.byteLength <= 16_384
}
/** The session owns callback failures; native event handlers never detach an
 * unobserved Effect or throw away a cleanup error. */
export function relayTerminal(
  open: () => TerminalSocket,
  allow: (direction: "input" | "output", bytes: number) => boolean,
  onClose: () => void,
  onFailure: (cause: unknown) => void
) {
  let server: WebSocket | undefined, upstream: TerminalSocket | undefined
  let closed = false
  const listeners: (() => void)[] = []
  const close = () => {
    if (closed) return
    closed = true
    for (const remove of listeners) {
      try {
        remove()
      } catch (cause) {
        onFailure(cause)
      }
    }
    listeners.length = 0
    try {
      onClose()
    } catch (cause) {
      onFailure(cause)
    }
    for (const socket of [server, upstream]) {
      if (!socket || socket.readyState >= 2) continue
      try {
        socket.close(1000, "Terminal disconnected")
      } catch (cause) {
        onFailure(cause)
      }
    }
  }
  const size = (data: string | ArrayBuffer) =>
    typeof data === "string"
      ? new TextEncoder().encode(data).length
      : data.byteLength
  try {
    const pair = new WebSocketPair(),
      downstream = pair[1]
    server = downstream
    downstream.binaryType = "arraybuffer"
    downstream.accept()
    const terminal = open()
    upstream = terminal
    terminal.binaryType = "arraybuffer"
    const input = (event: MessageEvent<string | ArrayBuffer>) => {
      if (closed) return
      try {
        if (
          !validTerminalInput(event.data) ||
          !allow("input", size(event.data))
        ) {
          close()
          return
        }
      } catch (cause) {
        onFailure(cause)
        close()
        return
      }
      try {
        terminal.send(event.data)
      } catch {
        close()
      }
    }
    const output = (event: MessageEvent<string | ArrayBuffer>) => {
      if (closed) return
      try {
        if (
          size(event.data) > 256 * 1024 ||
          !allow("output", size(event.data))
        ) {
          close()
          return
        }
      } catch (cause) {
        onFailure(cause)
        close()
        return
      }
      try {
        downstream.send(event.data)
      } catch {
        close()
      }
    }
    downstream.addEventListener("message", input)
    listeners.push(() => downstream.removeEventListener("message", input))
    terminal.addEventListener("message", output)
    listeners.push(() => terminal.removeEventListener("message", output))
    for (const socket of [downstream, terminal]) {
      socket.addEventListener("close", close)
      listeners.push(() => socket.removeEventListener("close", close))
      socket.addEventListener("error", close)
      listeners.push(() => socket.removeEventListener("error", close))
    }
    return {
      response: new Response(null, { status: 101, webSocket: pair[0] }),
      close,
    }
  } catch (cause) {
    close()
    throw cause
  }
}
