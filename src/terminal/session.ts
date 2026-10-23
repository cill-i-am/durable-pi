import {
  createEffectActor,
  send,
  waitFor,
  type EffectActor,
} from "@xstate/effect"
import { Cause, Clock, Deferred, Effect, Exit } from "effect"

import { fatalCause, orDieAll } from "../shared/effect"
import { TerminalFailure } from "./contracts"
import type { InteractiveState } from "./contracts"
import { sessionLive } from "./domain"
import type {
  InteractiveRuntime,
  TerminalRuntimeError,
  TerminalSocket,
} from "./runtime"
import { terminalSessionMachine } from "./session.machine"

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

/** The command scope owns the machine. Native socket acquisition and its
 * noncooperative cleanup retain the machine reservation until settlement. */
export class InteractiveSession implements TerminalSession {
  private actor!: EffectActor<ReturnType<typeof terminalSessionMachine>>
  get maximumAt() {
    return this.actor.getSnapshot().context.maximumAt
  }
  get expiresAt() {
    return this.actor.getSnapshot().context.expiresAt
  }
  get phase(): "starting" | "ready" | "saving" {
    const state = this.actor.getSnapshot()
    return state.matches("ready")
      ? "ready"
      : state.matches("saving")
        ? "saving"
        : "starting"
  }
  private readonly finished = Deferred.makeUnsafe<void>()
  readonly completion = Deferred.await(this.finished)
  private changed = Deferred.makeUnsafe<void>()
  private get runtime() {
    return this.actor.getSnapshot().context.runtime
  }
  private disconnect: (() => void) | null = null
  private inputBytes = 0
  private outputBytes = 0
  private pending = 0
  private readonly relayFailures: unknown[] = []
  private readonly stopped = () => {
    this.actor.send({ type: "END" })
    this.closeRelay()
  }
  private constructor(
    readonly id: string,
    private readonly controller: AbortController,
    private readonly relay: TerminalRelay,
    private readonly clock: Clock.Clock
  ) {}
  static make(
    id: string,
    controller: AbortController,
    relay: TerminalRelay,
    clock: Clock.Clock
  ) {
    return Effect.gen(function* () {
      const session = new InteractiveSession(id, controller, relay, clock)
      session.actor = yield* createEffectActor(
        terminalSessionMachine({
          now: () => clock.currentTimeMillisUnsafe(),
          stopped: () => controller.signal.aborted,
          complete: Effect.sync(() => {
            session.closeRelay()
            Deferred.doneUnsafe(session.finished, Effect.void)
          }),
          end: Effect.sync(() => session.dispose()),
        })
      ).pipe(Effect.provideService(Clock.Clock, clock))
      controller.signal.addEventListener("abort", session.stopped, {
        once: true,
      })
      if (controller.signal.aborted) session.stopped()
      yield* Effect.addFinalizer(() => Effect.sync(() => session.dispose()))
      return session
    })
  }
  get live() {
    return (
      this.actor.getSnapshot().status === "active" &&
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
  private request(
    event:
      | { type: "RENEW" | "SAVE" }
      | { type: "READY"; runtime: InteractiveRuntime }
      | { type: "CLAIM"; connection: string }
  ) {
    return Effect.gen({ self: this }, function* () {
      if (this.actor.getSnapshot().status !== "active")
        return yield* new TerminalFailure({
          message: "This terminal session has ended.",
        })
      const reply = yield* Deferred.make<void, TerminalFailure>()
      yield* send(this.actor, { ...event, reply })
      yield* Effect.raceFirst(
        Deferred.await(reply),
        waitFor(this.actor, (state) => state.status !== "active").pipe(
          Effect.catchTag("ActorStoppedError", (error) =>
            error.snapshot.status === "error"
              ? Effect.die(error.snapshot.error)
              : Effect.fail(
                  new TerminalFailure({
                    message: "This terminal session has ended.",
                  })
                )
          ),
          Effect.flatMap((state) =>
            state.status === "error"
              ? Effect.die(state.error)
              : Effect.fail(
                  new TerminalFailure({
                    message: "This terminal session has ended.",
                  })
                )
          )
        )
      )
    })
  }
  renew = Effect.fn("Terminal.renewSession")(() =>
    this.request({ type: "RENEW" })
  )
  ready = (runtime: InteractiveRuntime) =>
    this.request({ type: "READY", runtime })
  save = Effect.fn("Terminal.saveSession")(() => this.request({ type: "SAVE" }))
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
    const generation = crypto.randomUUID()
    let installed = false
    return Effect.acquireUseRelease(
      Effect.gen({ self: this }, function* () {
        if (!this.runtime || request.signal.aborted)
          return yield* new TerminalFailure({
            message: "This terminal session is not ready.",
          })
        yield* this.request({ type: "CLAIM", connection: generation })
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
                this.actor.send({ type: "RELEASE", connection: generation })
                if (this.actor.getSnapshot().context.connection === generation)
                  this.disconnect = null
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
              if (!installed)
                this.actor.send({ type: "RELEASE", connection: generation })
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
  private current(generation: string) {
    return (
      this.actor.getSnapshot().context.connection === generation &&
      this.live &&
      this.phase === "ready"
    )
  }
  closeRuntime = () => (this.runtime ? this.runtime.close() : Effect.void)
  private closeRelay() {
    const disconnect = this.disconnect
    this.disconnect = null
    try {
      disconnect?.()
    } catch (cause) {
      this.relayFailures.push(cause)
      this.controller.abort()
    }
  }
  dispose() {
    this.controller.signal.removeEventListener("abort", this.stopped)
    this.controller.abort()
    if (this.actor.getSnapshot().status === "active")
      this.actor.send({ type: "END" })
    this.closeRelay()
    this.notify()
    Deferred.doneUnsafe(this.finished, Effect.void)
  }
}
export const makeInteractiveSession = InteractiveSession.make
