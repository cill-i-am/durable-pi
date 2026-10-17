import { Cause } from "effect"

import { validTerminalInput } from "./socket"
import { withReader } from "./stream"

const interrupted = (cause: unknown) =>
  cause instanceof DOMException && cause.name === "AbortError"

/** Each connection owns a tmux client; the shell survives reconnects. */
export async function nativeTerminal(
  container: Pick<Container, "exec">,
  request: Request
) {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    throw new Error("Expected a terminal WebSocket")
  const abort = new AbortController()
  const process = await container.exec(
    [
      "tmux",
      "new-session",
      "-A",
      "-s",
      "owner",
      "-c",
      "/workspace",
      "/usr/local/bin/pi-shell",
    ],
    {
      pty: { cols: 80, rows: 24 },
      cwd: "/workspace",
      env: { TERM: "xterm-256color", HISTFILE: "/dev/null" },
      signal: abort.signal,
    }
  )
  const exit = process.exitCode.then(
    () => undefined,
    (cause: unknown) => ({ cause })
  )
  let server: WebSocket | undefined
  let writer: WritableStreamDefaultWriter | undefined
  try {
    if (!process.stdin || !process.stdout)
      throw new Error("Missing terminal streams")
    const pair = new WebSocketPair()
    const socket = pair[1]
    server = socket
    socket.binaryType = "arraybuffer"
    socket.accept()
    const stdin = process.stdin.getWriter()
    writer = stdin
    let input = Promise.resolve(),
      queued = 0
    const close = () => {
      abort.abort()
      if (socket.readyState < 2) socket.close(1000, "Terminal disconnected")
    }
    const onInput = (event: MessageEvent<string | ArrayBuffer>) => {
      if (abort.signal.aborted) return
      try {
        if (!validTerminalInput(event.data)) {
          close()
          return
        }
        if (typeof event.data === "string") {
          const { cols, rows } = JSON.parse(event.data) as {
            cols: number
            rows: number
          }
          process.resize(cols, rows)
        } else {
          const bytes = new Uint8Array(event.data)
          queued += bytes.byteLength
          if (queued > 64000) {
            close()
            return
          }
          input = input
            .then(() => stdin.write(bytes))
            .finally(() => {
              queued -= bytes.byteLength
            })
          void input.catch(close)
        }
      } catch {
        close()
      }
    }
    socket.addEventListener("message", onInput)
    socket.addEventListener("close", close)
    socket.addEventListener("error", close)
    socket.send(JSON.stringify({ type: "ready" }))
    const closed = (async () => {
      let failure: Cause.Cause<unknown> | undefined
      const retain = (cause: Cause.Cause<unknown>) => {
        failure = failure ? Cause.combine(failure, cause) : cause
      }
      try {
        await withReader(process.stdout!, abort.signal, async (read) => {
          for (;;) {
            const item = await read()
            if (item.done) break
            socket.send(item.value)
          }
        })
      } catch (cause) {
        const native = Cause.isCause(cause) ? cause : Cause.fail(cause)
        // Disconnect cancels the wait; reader cleanup defects still fence Save.
        if (!abort.signal.aborted || Cause.hasDies(native)) retain(native)
      }
      try {
        close()
      } catch (cause) {
        retain(Cause.die(cause))
      }
      socket.removeEventListener("message", onInput)
      socket.removeEventListener("close", close)
      socket.removeEventListener("error", close)
      try {
        await input
      } catch (cause) {
        if (!interrupted(cause)) retain(Cause.die(cause))
      }
      const stopped = await exit
      if (stopped) retain(Cause.die(stopped.cause))
      try {
        stdin.releaseLock()
      } catch (cause) {
        retain(Cause.die(cause))
      }
      if (failure) throw failure
    })()
    // The interactive runtime retains failed connections until cleanup joins them.
    void closed.catch(() => {})
    return {
      response: new Response(null, { status: 101, webSocket: pair[0] }),
      closed,
      close,
    }
  } catch (cause) {
    const failures = Cause.isCause(cause)
      ? [...cause.reasons]
      : [Cause.makeFailReason(cause)]
    abort.abort()
    try {
      server?.close(1011, "Terminal unavailable")
    } catch (cause) {
      failures.push(Cause.makeDieReason(cause))
    }
    const stopped = await exit
    if (stopped) failures.push(Cause.makeDieReason(stopped.cause))
    try {
      writer?.releaseLock()
    } catch (cause) {
      failures.push(Cause.makeDieReason(cause))
    }
    throw Cause.fromReasons(failures)
  }
}
