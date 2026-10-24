import {
  createEffectActor,
  send,
  waitFor,
  type EffectActor,
} from "@xstate/effect"
import type { ITerminalAddon, Terminal } from "@xterm/xterm"
import { Cause, Effect, Exit } from "effect"

import { nativeOperation } from "@/shared/interop"

import { terminalWorkFailures } from "./owned-work"
import { terminalSocketMachine, type SocketEvent } from "./socket.machine"

type ConnectionState = "connecting" | "connected" | "disconnected"
type Actor = EffectActor<ReturnType<typeof terminalSocketMachine>>
/** The machine admits input/reconnect. The native capability owns socket close. */
export class NativeTerminalAddon implements ITerminalAddon {
  private actor: Promise<Actor> | undefined
  private socket: WebSocket | undefined
  private closing: Promise<void> = Promise.resolve()
  private completion: Promise<Exit.Exit<unknown, unknown>> = Promise.resolve(
    Exit.void
  )
  constructor(
    private readonly url: () => string,
    private readonly changed: (state: ConnectionState) => void
  ) {}
  activate(terminal: Terminal) {
    if (this.actor) return
    let ready!: (actor: Actor) => void
    this.actor = new Promise((resolve) => {
      ready = resolve
    })
    this.completion = Effect.runPromiseExit(
      Effect.gen({ self: this }, function* () {
        const observe = yield* terminalWorkFailures
        let actor: Actor
        const emit = (event: SocketEvent) => Effect.runFork(send(actor, event))
        const open = (token: number) =>
          nativeOperation<void, unknown>(
            (signal) => {
              const url = new URL(this.url())
              url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
              url.searchParams.set("cols", String(terminal.cols))
              url.searchParams.set("rows", String(terminal.rows))
              const socket = new WebSocket(url)
              this.socket = socket
              socket.binaryType = "arraybuffer"
              const closed = new Promise<void>((resolve) => {
                const message = (event: MessageEvent<unknown>) => {
                  if (signal.aborted) return
                  if (event.data === '{"type":"ready"}')
                    emit({ type: "READY", token })
                  else if (event.data instanceof ArrayBuffer)
                    emit({
                      type: "OUTPUT",
                      token,
                      bytes: new Uint8Array(event.data),
                    })
                }
                const abort = () => socket.close()
                socket.addEventListener("message", message)
                socket.addEventListener(
                  "close",
                  () => {
                    signal.removeEventListener("abort", abort)
                    socket.removeEventListener("message", message)
                    if (this.socket === socket) this.socket = undefined
                    resolve()
                  },
                  { once: true }
                )
                signal.addEventListener("abort", abort, { once: true })
                if (signal.aborted) abort()
              })
              this.closing = closed
              return closed
            },
            (cause) => cause
          )
        actor = yield* createEffectActor(
          terminalSocketMachine({
            open: (token) => observe(open(token)),
            close: () =>
              observe(
                Effect.promise(() => {
                  this.socket?.close()
                  return this.closing
                })
              ),
          })
        )
        const listeners = [
          actor.subscribe((snapshot) =>
            this.changed(
              snapshot.matches({ open: "ready" })
                ? "connected"
                : snapshot.matches("open")
                  ? "connecting"
                  : "disconnected"
            )
          ),
          actor.on("output", ({ bytes }) => terminal.write(bytes)),
          actor.on("send", ({ bytes }) => {
            if (this.socket?.readyState === WebSocket.OPEN)
              for (let offset = 0; offset < bytes.length; offset += 16384)
                this.socket.send(bytes.subarray(offset, offset + 16384))
          }),
          actor.on("resize", () => {
            if (this.socket?.readyState === WebSocket.OPEN)
              this.socket.send(
                JSON.stringify({
                  type: "resize",
                  cols: Math.min(240, Math.max(2, terminal.cols)),
                  rows: Math.min(100, Math.max(2, terminal.rows)),
                })
              )
          }),
        ]
        const inputs = [
          terminal.onData((text) =>
            Effect.runFork(
              send(actor, {
                type: "INPUT",
                bytes: new TextEncoder().encode(text),
              })
            )
          ),
          terminal.onBinary((text) =>
            Effect.runFork(
              send(actor, {
                type: "INPUT",
                bytes: Uint8Array.from(text, (char) => char.charCodeAt(0)),
              })
            )
          ),
          terminal.onResize(() =>
            Effect.runFork(send(actor, { type: "RESIZE" }))
          ),
        ]
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const subscription of listeners) subscription.unsubscribe()
            for (const input of inputs) input.dispose()
          })
        )
        ready(actor)
        yield* waitFor(actor, (snapshot) => snapshot.status === "done")
      }).pipe(Effect.scoped)
    )
    void this.completion.then((exit) => {
      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
        Effect.runFork(Effect.logError(exit.cause))
    })
  }
  connect() {
    void this.actor?.then((actor) =>
      Effect.runPromise(send(actor, { type: "CONNECT" }))
    )
  }
  disconnect() {
    void this.actor?.then((actor) =>
      Effect.runPromise(send(actor, { type: "DISCONNECT" }))
    )
  }
  dispose() {
    void this.actor?.then((actor) =>
      Effect.runPromise(send(actor, { type: "DISPOSE" }))
    )
  }
  get settled() {
    return this.completion
  }
}
