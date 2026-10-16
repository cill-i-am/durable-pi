import { afterEach, expect, it, vi } from "vitest"
import type { Terminal } from "@xterm/xterm"
import { NativeTerminalAddon } from "../src/features/terminal/native-terminal-addon"

class Socket extends EventTarget {
  static OPEN = 1
  static sockets: Socket[] = []
  readyState = 1
  binaryType = ""
  sent: (string | Uint8Array)[] = []
  constructor(readonly url: URL) {
    super()
    Socket.sockets.push(this)
  }
  send(bytes: string | Uint8Array) {
    this.sent.push(bytes)
  }
  close() {
    this.readyState = 3
    this.dispatchEvent(new Event("close"))
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }))
  }
}
function fixture() {
  vi.stubGlobal("WebSocket", Socket)
  const listeners: Record<string, (value: never) => void> = {}
  const disposed = vi.fn()
  const write = vi.fn()
  const register = (key: string) => (fn: (value: never) => void) => {
    listeners[key] = fn
    return { dispose: disposed }
  }
  const terminal = {
    cols: 999,
    rows: 999,
    write,
    onData: register("data"),
    onBinary: register("binary"),
    onResize: register("resize"),
  }
  const changed = vi.fn()
  const addon = new NativeTerminalAddon(
    () => "https://example.com/socket",
    changed
  )
  addon.activate(terminal as unknown as Terminal)
  addon.connect()
  return {
    addon,
    terminal,
    listeners,
    disposed,
    changed,
    write,
    socket: Socket.sockets.at(-1)!,
  }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  Socket.sockets = []
})
it("waits for readiness, sends UTF-8 in bounded frames, and renders binary output", () => {
  const { addon, socket, listeners, write, changed } = fixture()
  listeners.data!("café 🧭" as never)
  expect(socket.sent).toEqual([])
  socket.message('{"type":"ready"}')
  expect(JSON.parse(socket.sent[0] as string)).toEqual({
    type: "resize",
    cols: 240,
    rows: 100,
  })
  expect(new TextDecoder().decode(socket.sent[1] as Uint8Array)).toBe("café 🧭")
  listeners.data!("x".repeat(40000) as never)
  expect(socket.sent.slice(2).map((x) => x.length)).toEqual([
    16384, 16384, 7232,
  ])
  const output = new TextEncoder().encode("output")
  socket.message(output.buffer)
  expect(write).toHaveBeenCalledWith(output)
  expect(changed).toHaveBeenLastCalledWith("connected")
  addon.dispose()
})
it("reconnects after close, ignores stale callbacks, and disposes timers and listeners", () => {
  vi.useFakeTimers()
  const { addon, socket, disposed, write } = fixture()
  socket.close()
  vi.advanceTimersByTime(1000)
  expect(Socket.sockets).toHaveLength(2)
  socket.message(new TextEncoder().encode("stale").buffer)
  expect(write).not.toHaveBeenCalled()
  addon.dispose()
  vi.advanceTimersByTime(10000)
  expect(Socket.sockets).toHaveLength(2)
  expect(disposed).toHaveBeenCalledTimes(3)
})
it("disconnects when queued input exceeds the bound", () => {
  const { addon, socket, listeners } = fixture()
  listeners.data!("x".repeat(65537) as never)
  expect(socket.readyState).toBe(3)
  expect(socket.sent).toEqual([])
  addon.dispose()
})
