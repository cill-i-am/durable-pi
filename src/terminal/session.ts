import { Cause, Deferred, Effect, Exit, Option, Schema } from "effect"
import type { Clock } from "effect"

import { fatalCause, orDieAll } from "../shared/effect"
import { TerminalFailure } from "./contracts"
import type { InteractiveState } from "./contracts"
import { SESSION_LIFETIME, sessionExpiry, sessionLive } from "./domain"
import type {
  InteractiveRuntime,
  TerminalRuntimeError,
  TerminalSocket,
} from "./runtime"

export { SESSION_LEASE, SESSION_LIFETIME } from "./domain"
export type TerminalRelay = (
  open: () => TerminalSocket,
  allow: (direction: "input" | "output", bytes: number) => boolean,
  onClose: () => void,
  onFailure: (cause: unknown) => void
) => { response: Response; close: () => void }

export interface TerminalSession {
  readonly live: boolean
  state: () => typeof InteractiveState.Type
  renew: () => Effect.Effect<void, TerminalFailure>
  save: () => Effect.Effect<void, TerminalFailure>
  connect: (
    request: Request
  ) => Effect.Effect<Response, TerminalFailure | TerminalRuntimeError>
}

const expected = Schema.decodeUnknownOption(TerminalFailure)
const attempt = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const error = expected(cause)
      if (Option.isSome(error)) return error.value
      throw cause
    },
  })

/** Owns lease and connection decisions. Its monitor is forked in the command
 * scope; the runtime adapter additionally joins noncooperative socket startup. */
export class InteractiveSession implements TerminalSession {
  readonly maximumAt: number
  expiresAt: number
  phase: "starting" | "ready" | "saving" = "starting"
  private readonly finished = Deferred.makeUnsafe<void>()
  readonly completion = Deferred.await(this.finished)
  private changed = Deferred.makeUnsafe<void>()
  private runtime: InteractiveRuntime | null = null
  private disconnect: (() => void) | null = null
  private inputBytes = 0
  private outputBytes = 0
  private pending = 0
  private connection: symbol | null = null
  private disposed = false
  private readonly relayFailures: unknown[] = []
  private readonly stopped = () => this.dispose()
  constructor(
    readonly id: string,
    private readonly controller: AbortController,
    private readonly relay: TerminalRelay,
    private readonly clock: Clock.Clock
  ) {
    const now = clock.currentTimeMillisUnsafe()
    this.maximumAt = now + SESSION_LIFETIME
    this.expiresAt = sessionExpiry(now, this.maximumAt)
    controller.signal.addEventListener("abort", this.stopped, { once: true })
    if (controller.signal.aborted) this.dispose()
  }
  get live() {
    return (
      !this.disposed &&
      sessionLive(
        this.clock.currentTimeMillisUnsafe(),
        this.expiresAt,
        this.controller.signal.aborted
      )
    )
  }
  state() {
    return {
      id: this.id,
      phase: this.phase,
      expiresAt: this.expiresAt,
      maximumAt: this.maximumAt,
    }
  }
  private notify() {
    const previous = this.changed
    this.changed = Deferred.makeUnsafe<void>()
    Deferred.doneUnsafe(previous, Effect.void)
  }
  watchLease = Effect.fn("Terminal.sessionLease")(() =>
    Effect.gen({ self: this }, function* () {
      while (!this.disposed && this.phase !== "saving") {
        const changed = this.changed
        const expired = yield* Effect.raceFirst(
          Effect.sleep(
            Math.max(0, this.expiresAt - this.clock.currentTimeMillisUnsafe())
          ).pipe(Effect.as(true)),
          Deferred.await(changed).pipe(Effect.as(false))
        )
        if (expired) {
          this.controller.abort()
          return
        }
      }
    })
  )
  renew = Effect.fn("Terminal.renewSession")(() =>
    attempt(() => {
      if (!this.live || this.phase === "saving")
        throw new TerminalFailure({
          message: "This terminal session has ended.",
        })
      this.expiresAt = sessionExpiry(
        this.clock.currentTimeMillisUnsafe(),
        this.maximumAt
      )
      this.notify()
    })
  )
  ready = (runtime: InteractiveRuntime) =>
    attempt(() => {
      if (!this.live)
        throw new TerminalFailure({
          message: "This terminal session has ended.",
        })
      this.runtime = runtime
      this.phase = "ready"
    })
  save = Effect.fn("Terminal.saveSession")(() =>
    attempt(() => {
      if (!this.live || this.phase !== "ready")
        throw new TerminalFailure({
          message: "Wait for the terminal to be ready before saving.",
        })
      this.phase = "saving"
      this.disconnect?.()
      this.disconnect = null
      this.notify()
      Deferred.doneUnsafe(this.finished, Effect.void)
    })
  )
  settleConnections = Effect.fn("Terminal.settleConnections")(() =>
    Effect.gen({ self: this }, function* () {
      while (this.pending) yield* Deferred.await(this.changed)
      const failures = this.relayFailures.splice(0)
      const report = failures.length
        ? Effect.failCause(
            Cause.fromReasons<never>(
              failures.flatMap((cause) =>
                Cause.isCause(cause)
                  ? fatalCause(cause).reasons
                  : [Cause.makeDieReason(cause)]
              )
            )
          ).pipe(orDieAll)
        : Effect.void
      yield* (this.runtime ? this.runtime.settle() : Effect.void).pipe(
        Effect.ensuring(report)
      )
    })
  )
  connect = Effect.fn("Terminal.connectSession")((request: Request) => {
    const generation = Symbol()
    let installed = false
    return Effect.acquireUseRelease(
      attempt(() => {
        if (
          !this.live ||
          this.phase !== "ready" ||
          !this.runtime ||
          request.signal.aborted
        )
          throw new TerminalFailure({
            message: "This terminal session is not ready.",
          })
        if (this.connection)
          throw new TerminalFailure({
            message:
              "This terminal is open in another panel. Close it before reconnecting here.",
          })
        this.connection = generation
        this.pending++
        return this.runtime
      }),
      (runtime) =>
        Effect.scoped(
          Effect.gen({ self: this }, function* () {
            const handshake = yield* runtime.connect(
              new Request(request, {
                signal: AbortSignal.any([
                  request.signal,
                  this.controller.signal,
                ]),
              })
            )
            const current = () =>
              this.current(generation) && !request.signal.aborted
            if (!current()) {
              return yield* new TerminalFailure({
                message: "This terminal session has ended.",
              })
            }
            const relay = this.relay(
              handshake.accept,
              (direction, bytes) => {
                if (!this.current(generation)) return false
                if (direction === "input") this.inputBytes += bytes
                else this.outputBytes += bytes
                if (
                  this.inputBytes > 256_000 ||
                  this.outputBytes > 4 * 1024 * 1024
                ) {
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
              },
              (cause) => {
                this.relayFailures.push(cause)
                this.controller.abort()
              }
            )
            if (!current()) {
              relay.close()
              return yield* new TerminalFailure({
                message: "This terminal session has ended.",
              })
            }
            this.disconnect = relay.close
            handshake.transfer()
            installed = true
            return relay.response
          })
        ),
      (runtime) =>
        (installed ? Effect.void : runtime.settle()).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (!installed && this.connection === generation)
                this.connection = null
              this.pending--
              this.notify()
            })
          )
        )
    ).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && Cause.hasDies(exit.cause)
          ? Effect.sync(() => {
              this.relayFailures.push(exit.cause)
              this.controller.abort()
            })
          : Effect.void
      )
    )
  })
  private current(generation: symbol) {
    return this.connection === generation && this.live && this.phase === "ready"
  }
  closeRuntime = () => (this.runtime ? this.runtime.close() : Effect.void)
  dispose() {
    this.disposed = true
    this.controller.signal.removeEventListener("abort", this.stopped)
    this.disconnect?.()
    this.disconnect = null
    this.connection = null
    this.notify()
    Deferred.doneUnsafe(this.finished, Effect.void)
  }
}
