import type { ITerminalAddon, Terminal } from "@xterm/xterm"

type ConnectionState = "connecting" | "connected" | "disconnected"

/** The native PTY sends bytes plus one readiness frame; input stays bounded. */
export class NativeTerminalAddon implements ITerminalAddon {
  private terminal: Terminal | undefined
  private socket: WebSocket | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private listeners: { dispose: () => void }[] = []
  private stopped = true
  private ready = false
  private queued: Uint8Array[] = []
  private queuedBytes = 0
  constructor(
    private readonly url: () => string,
    private readonly changed: (state: ConnectionState) => void
  ) {}
  activate(terminal: Terminal) {
    this.terminal = terminal
    this.listeners.push(
      terminal.onData((text) => this.input(new TextEncoder().encode(text))),
      terminal.onBinary((text) =>
        this.input(Uint8Array.from(text, (char) => char.charCodeAt(0)))
      ),
      terminal.onResize(() => this.resize())
    )
  }
  private input(bytes: Uint8Array) {
    if (this.stopped) return
    if (bytes.length + this.queuedBytes > 65536) {
      this.disconnect()
      return
    }
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) {
      for (let offset = 0; offset < bytes.length; offset += 16384)
        this.socket.send(bytes.subarray(offset, offset + 16384))
      return
    }
    this.queued.push(bytes)
    this.queuedBytes += bytes.length
  }
  private resize() {
    if (
      !this.ready ||
      this.socket?.readyState !== WebSocket.OPEN ||
      !this.terminal
    )
      return
    this.socket.send(
      JSON.stringify({
        type: "resize",
        cols: Math.min(240, Math.max(2, this.terminal.cols)),
        rows: Math.min(100, Math.max(2, this.terminal.rows)),
      })
    )
  }
  connect() {
    if (!this.terminal || !this.stopped) return
    this.stopped = false
    this.open()
  }
  private open() {
    if (this.stopped || !this.terminal) return
    this.ready = false
    this.changed("connecting")
    const url = new URL(this.url())
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    url.searchParams.set("cols", String(this.terminal.cols))
    url.searchParams.set("rows", String(this.terminal.rows))
    const socket = new WebSocket(url)
    this.socket = socket
    socket.binaryType = "arraybuffer"
    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (this.socket !== socket || this.stopped) return
      if (event.data === '{"type":"ready"}') {
        this.ready = true
        this.resize()
        for (const bytes of this.queued)
          for (let offset = 0; offset < bytes.length; offset += 16384)
            socket.send(bytes.subarray(offset, offset + 16384))
        this.queued = []
        this.queuedBytes = 0
        this.changed("connected")
      } else if (event.data instanceof ArrayBuffer)
        this.terminal?.write(new Uint8Array(event.data))
    })
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.ready = false
      this.changed("disconnected")
      if (!this.stopped) this.timer = setTimeout(() => this.open(), 1000)
    })
  }
  disconnect() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const socket = this.socket
    this.socket = undefined
    this.ready = false
    this.queued = []
    this.queuedBytes = 0
    socket?.close()
    this.changed("disconnected")
  }
  dispose() {
    this.disconnect()
    for (const listener of this.listeners) listener.dispose()
    this.listeners = []
  }
}
