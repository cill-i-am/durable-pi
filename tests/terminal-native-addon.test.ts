import type { Terminal } from "@xterm/xterm"
import { afterEach, expect, it, vi } from "vitest"

import { NativeTerminalAddon } from "../src/features/terminal/native-terminal-addon"

class Socket extends EventTarget {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 1
  binaryType = ""
  sent: unknown[] = []
  closing = false
  constructor(readonly url: URL) {
    super()
    Socket.instances.push(this)
  }
  send(value: unknown) {
    this.sent.push(value)
  }
  close() {
    this.closing = true
  }
  finish() {
    this.readyState = 3
    this.dispatchEvent(new Event("close"))
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }))
  }
}
afterEach(() => {
  vi.unstubAllGlobals()
  Socket.instances = []
})
it("the real addon waits for native close and fences old frames before reconnect", async () => {
  vi.stubGlobal("WebSocket", Socket)
  let input: (text: string) => void = () => {}
  const write = vi.fn(),
    disposed = vi.fn(),
    changed = vi.fn()
  const terminal = {
    cols: 80,
    rows: 24,
    write,
    onData: (next: (text: string) => void) => {
      input = next
      return { dispose: disposed }
    },
    onBinary: () => ({ dispose: disposed }),
    onResize: () => ({ dispose: disposed }),
  } as unknown as Terminal
  const addon = new NativeTerminalAddon(
    () => "https://app.example/terminal/socket",
    changed
  )
  addon.activate(terminal)
  addon.connect()
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1))
  const first = Socket.instances[0]!
  input("queued")
  first.message('{"type":"ready"}')
  await vi.waitFor(() => expect(first.sent).toHaveLength(2))
  expect(first.sent[1]).toEqual(new TextEncoder().encode("queued"))
  addon.disconnect()
  addon.connect()
  await vi.waitFor(() => expect(first.closing).toBe(true))
  expect(Socket.instances).toHaveLength(1)
  first.message(new Uint8Array([9]).buffer)
  first.finish()
  await vi.waitFor(() =>
    expect(changed).toHaveBeenLastCalledWith("disconnected")
  )
  addon.connect()
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(2))
  first.message('{"type":"ready"}')
  first.message(new Uint8Array([9]).buffer)
  expect(write).not.toHaveBeenCalled()
  const second = Socket.instances[1]!
  addon.dispose()
  let settled = false
  void addon.settled.then(() => {
    settled = true
  })
  await vi.waitFor(() => expect(second.closing).toBe(true))
  expect(settled).toBe(false)
  second.finish()
  expect((await addon.settled)._tag).toBe("Success")
  expect(disposed).toHaveBeenCalledTimes(3)
})
