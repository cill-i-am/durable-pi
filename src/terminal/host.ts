import { createEffectActor, waitFor } from "@xstate/effect"
import { Effect, Exit } from "effect"

import { observeCleanup } from "../shared/effect"
import { nativeOperation } from "../shared/interop"
import {
  advanceTerminalHost,
  initialTerminalHost,
  terminalHostDrainMachine,
  terminalHostWorkMachine,
  type TerminalHostState,
} from "./host.machine"

export class TerminalTransportHost<E, Receipt> {
  private state = initialTerminalHost()
  private readonly snapshots = new Map<string, Promise<Receipt>>()
  constructor(
    private readonly work: {
      run: <T>(
        work: Effect.Effect<T, E>,
        options?: { signal?: AbortSignal }
      ) => Promise<T>
      writable: () => boolean
      now?: () => number
      state: Effect.Effect<TerminalHostState, E>
      cancel: (id: string) => Effect.Effect<void, E>
      recover: Effect.Effect<void, E>
      containerRunning: () => boolean
      snapshot: (name: string, drain: () => Promise<void>) => Promise<Receipt>
    }
  ) {}
  get videoBusy() {
    return this.state.context.video !== null
  }
  private owned<T>(work: Effect.Effect<T, E>) {
    return observeCleanup(work, (observed) =>
      Effect.gen(function* () {
        const actor = yield* createEffectActor(
          terminalHostWorkMachine(observed)
        )
        const done = yield* waitFor(
          actor,
          (state) => state.status === "done"
        ).pipe(Effect.orDie)
        return yield* done.output!
      }).pipe(Effect.scoped)
    )
  }
  video(work: Effect.Effect<Response, E>, signal: AbortSignal) {
    const token = crypto.randomUUID()
    this.state = advanceTerminalHost(this.state, {
      type: "VIDEO",
      token,
      allowed: this.work.writable(),
    })
    if (this.state.context.video !== token)
      return Promise.resolve(new Response("Busy", { status: 503 }))
    return Promise.resolve()
      .then(() => this.work.run(this.owned(work), { signal }))
      .finally(() => {
        this.state = advanceTerminalHost(this.state, {
          type: "VIDEO_JOINED",
          token,
        })
      })
  }
  snapshot(name: string): Promise<Receipt> {
    const current = this.state.context.snapshot
    if (current) {
      if (this.state.context.name !== name)
        return Promise.reject(new Error("Legacy migration identity mismatch"))
      return this.snapshots.get(current)!
    }
    const token = crypto.randomUUID()
    this.state = advanceTerminalHost(this.state, {
      type: "SNAPSHOT",
      token,
      name,
    })
    if (this.state.context.snapshot !== token)
      return Promise.reject(new Error("Legacy migration identity mismatch"))
    const drain = async () => {
      const exit = await this.work.run(
        Effect.gen({ self: this }, function* () {
          const actor = yield* createEffectActor(
            terminalHostDrainMachine({
              ...this.work,
              videoBusy: () => this.videoBusy,
              now: this.work.now ?? Date.now,
            })
          )
          const done = yield* waitFor(
            actor,
            (state) => state.status === "done"
          ).pipe(Effect.orDie)
          return yield* done.output!
        }).pipe(Effect.scoped, Effect.exit)
      )
      // The production runPromise boundary squashes a rejected Effect Cause.
      // Carry Exit as a value until this internal Promise re-enters Effect.
      if (Exit.isFailure(exit)) throw exit.cause
    }
    const pending = Promise.resolve()
      .then(() =>
        this.work.run(
          this.owned(
            nativeOperation(
              () => this.work.snapshot(name, drain),
              (cause, channel) => {
                if (channel === "failure") return cause as E
                throw cause
              }
            )
          )
        )
      )
      .finally(() => {
        this.state = advanceTerminalHost(this.state, {
          type: "SNAPSHOT_JOINED",
          token,
        })
        this.snapshots.delete(token)
      })
    this.snapshots.set(token, pending)
    return pending
  }
}
