import { TerminalFailure } from "./contracts"
import { relayTerminal } from "./adapters/socket"

export interface InteractiveRuntime {
  connect: (request: Request) => Promise<Response>
  close: () => Promise<void>
}
export const SESSION_LEASE = 30_000
export const SESSION_LIFETIME = 10 * 60_000
export class InteractiveSession {
  readonly maximumAt = Date.now() + SESSION_LIFETIME
  expiresAt = Math.min(Date.now() + SESSION_LEASE, this.maximumAt)
  phase: "starting" | "ready" | "saving" = "starting"
  private timer: ReturnType<typeof setTimeout> | undefined
  private finish!: () => void
  readonly completion = new Promise<void>((resolve) => {
    this.finish = resolve
  })
  private runtime: InteractiveRuntime | null = null
  private disconnect: (() => void) | null = null
  private inputBytes = 0
  private outputBytes = 0
  constructor(
    readonly id: string,
    private readonly controller: AbortController
  ) {
    controller.signal.addEventListener(
      "abort",
      () => {
        this.dispose()
        this.finish()
      },
      { once: true }
    )
    this.renew()
  }
  get live() {
    return !this.controller.signal.aborted && Date.now() < this.expiresAt
  }
  state() {
    return {
      id: this.id,
      phase: this.phase,
      expiresAt: this.expiresAt,
      maximumAt: this.maximumAt,
    }
  }
  renew() {
    if (!this.live || this.phase === "saving")
      throw new TerminalFailure({ message: "This terminal session has ended." })
    this.expiresAt = Math.min(Date.now() + SESSION_LEASE, this.maximumAt)
    clearTimeout(this.timer)
    this.timer = setTimeout(
      () => this.controller.abort(),
      Math.max(0, this.expiresAt - Date.now())
    )
  }
  ready(runtime: InteractiveRuntime) {
    if (!this.live)
      throw new TerminalFailure({ message: "This terminal session has ended." })
    this.runtime = runtime
    this.phase = "ready"
  }
  save() {
    if (!this.live || this.phase !== "ready")
      throw new TerminalFailure({
        message: "Wait for the terminal to be ready before saving.",
      })
    this.phase = "saving"
    this.disconnect?.()
    this.disconnect = null
    clearTimeout(this.timer)
    this.finish()
  }
  private pending = new Set<Promise<Response>>()
  connect(request: Request) {
    const operation = this.open(request)
    this.pending.add(operation)
    void operation.finally(() => this.pending.delete(operation)).catch(() => {})
    return operation
  }
  async settleConnections() {
    await Promise.allSettled([...this.pending])
  }
  private async open(request: Request) {
    if (!this.live || this.phase !== "ready" || !this.runtime)
      throw new TerminalFailure({
        message: "This terminal session is not ready.",
      })
    if (this.connection)
      throw new TerminalFailure({
        message:
          "This terminal is open in another panel. Close it before reconnecting here.",
      })
    const generation = Symbol()
    this.connection = generation
    let response: Response
    try {
      response = await this.runtime.connect(
        new Request(request, { signal: this.controller.signal })
      )
    } catch (cause) {
      if (this.connection === generation) this.connection = null
      throw cause
    }
    if (!response.webSocket) {
      if (this.connection === generation) this.connection = null
      throw new TerminalFailure({
        message: "Could not connect to the terminal.",
      })
    }
    if (!this.current(generation)) {
      response.webSocket.accept()
      response.webSocket.close(1000, "Session ended")
      throw new TerminalFailure({ message: "This terminal session has ended." })
    }
    const relay = relayTerminal(
      response.webSocket,
      (direction, bytes) => {
        if (!this.current(generation)) return false
        if (direction === "input") this.inputBytes += bytes
        else this.outputBytes += bytes
        if (this.inputBytes > 256_000 || this.outputBytes > 4 * 1024 * 1024) {
          this.controller.abort()
          return false
        }
        return true
      },
      () => {
        if (this.connection === generation) {
          this.connection = null
          this.disconnect = null
        }
      }
    )
    this.disconnect = relay.close
    return relay.response
  }
  private current(generation: symbol) {
    return this.connection === generation && this.live && this.phase === "ready"
  }
  private connection: symbol | null = null
  async closeRuntime() {
    await this.runtime?.close()
  }
  dispose() {
    clearTimeout(this.timer)
    this.disconnect?.()
    this.disconnect = null
    this.connection = null
  }
}
