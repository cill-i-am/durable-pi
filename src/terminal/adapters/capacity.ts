import { createEffectActor, waitFor } from "@xstate/effect"
import { Deferred, Effect, Exit, Scope } from "effect"

import { orDieAll } from "../../shared/effect"
import { nativeOperation } from "../../shared/interop"
import {
  capacityAcquisitionMachine,
  decideCapacity,
  type CapacityState,
  type CapacityLease,
} from "../capacity.machine"
export type { CapacityState, CapacityLease } from "../capacity.machine"
import { nativeOwnerMachine } from "../native-owner.machine"
import { startNativeContainer } from "./native-process"

export interface NativeCapacityRPC extends Rpc.DurableObjectBranded {
  acquire: (owner: string) => Promise<CapacityLease>
  release: (owner: string, epoch: number) => boolean
  status: () => { used: number; maximum: number }
}
export interface CapacityStorage {
  get: () => CapacityState | undefined
  put: (state: CapacityState) => void
  atomic: <T>(body: () => T) => T
}

/** A slot is never freed by a deadline alone: its owner must confirm teardown. */
export class TerminalCapacityPool {
  constructor(
    private readonly storage: CapacityStorage,
    private readonly retire: (lease: CapacityLease) => Promise<boolean>,
    private readonly now = Date.now
  ) {}
  private allocate(owner: string) {
    return this.storage.atomic(() => {
      const result = decideCapacity(this.storage.get(), {
        type: "ACQUIRE",
        owner,
        now: this.now(),
      })
      this.storage.put(result.state)
      return result.lease
    })
  }
  async acquire(owner: string): Promise<CapacityLease> {
    if (!/^[a-f0-9]{64}$/.test(owner))
      throw new Error("Invalid terminal capacity owner")
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen({ self: this }, function* () {
          const actor = yield* createEffectActor(
            capacityAcquisitionMachine({
              allocate: Effect.sync(() => this.allocate(owner)),
              candidates: Effect.sync(() => this.storage.get()?.leases ?? []),
              now: Effect.sync(this.now),
              retire: (lease) =>
                nativeOperation(
                  () => this.retire(lease),
                  (error) => error
                ),
              reclaim: (lease) =>
                Effect.sync(() => {
                  this.release(lease.owner, lease.epoch)
                  return this.allocate(owner)
                }),
            })
          )
          const result = yield* waitFor(
            actor,
            (snapshot) => snapshot.status === "done"
          )
          return yield* result.output!
        })
      )
    )
    if (Exit.isSuccess(exit)) return exit.value
    const reason =
      exit.cause.reasons.length === 1 ? exit.cause.reasons[0] : undefined
    if (
      reason?._tag === "Fail" &&
      [...reason.annotations.keys()].every(
        (key) => key === "effect/Cause/StackTrace"
      )
    )
      throw reason.error
    throw exit.cause
  }
  release(owner: string, epoch: number) {
    return this.storage.atomic(() => {
      const result = decideCapacity(this.storage.get(), {
        type: "RELEASE",
        owner,
        epoch,
      })
      if (result.released) this.storage.put(result.state)
      return result.released
    })
  }
  status() {
    return { used: this.storage.get()?.leases.length ?? 0, maximum: 4 }
  }
}

export interface CapacityOwnerStorage {
  token: () => number | undefined
  setToken: (epoch: number | undefined) => void
  fence: () => number
  setFence: (epoch: number) => void
}
export interface CapacityBinding {
  acquire: (owner: string) => Promise<CapacityLease>
  release: (owner: string, epoch: number) => Promise<boolean>
}

/** Persist the capability before starting. Reclamation fences late starts. */
export class NativeContainerOwner {
  private readonly actor
  constructor(
    private readonly owner: string,
    private readonly container: Pick<
      Container,
      "start" | "images" | "setInactivityTimeout" | "destroy" | "running"
    >,
    private readonly capacity: CapacityBinding,
    private readonly storage: CapacityOwnerStorage,
    private readonly scope = Scope.makeUnsafe()
  ) {
    // The Durable Object supplies its lifetime scope; standalone owners dispose
    // this explicit scope. close() releases a container, not the reusable owner.
    const native = <A>(work: () => Promise<A>) =>
      nativeOperation(work, (error) => error)
    this.actor = Effect.runSync(
      createEffectActor(
        nativeOwnerMachine({
          acquire: (request) =>
            native(async () => {
              request.signal?.throwIfAborted()
              const lease = await this.capacity.acquire(this.owner)
              if (
                lease.owner !== this.owner ||
                !Number.isSafeInteger(lease.epoch) ||
                lease.epoch < 1
              )
                throw new Error("Invalid terminal capacity lease")
              this.storage.setToken(lease.epoch)
            }),
          start: (request) =>
            native(async () => {
              request.signal?.throwIfAborted()
              const token = this.storage.token()
              if (token === undefined || token <= this.storage.fence())
                throw new Error("Terminal capacity lease was retired")
              await startNativeContainer(this.container, request.unrestricted)
            }),
          close: native(async () => {
            // Read only after all admitted acquisition/start work has settled.
            const token = this.storage.token()
            await this.container.destroy()
            if (this.container.running)
              throw new Error("Terminal container teardown is unconfirmed")
            if (token !== undefined) {
              await this.capacity.release(this.owner, token)
              if (this.storage.token() === token)
                this.storage.setToken(undefined)
            }
          }),
          retire: (epoch) =>
            native(async () => {
              if (!Number.isSafeInteger(epoch) || epoch < 1)
                throw new Error("Invalid terminal capacity epoch")
              const current = this.storage.token()
              if (current !== undefined && current !== epoch) return false
              if (this.container.running) return false
              this.storage.setFence(Math.max(this.storage.fence(), epoch))
              await this.container.destroy()
              return !this.container.running
            }),
        })
      ).pipe(Scope.provide(scope))
    )
    Effect.runSync(
      Effect.addFinalizer(() => this.closeEffect().pipe(orDieAll)).pipe(
        Scope.provide(scope)
      )
    )
  }
  private closeEffect() {
    return Effect.suspend(() => {
      const reply = Deferred.makeUnsafe<Exit.Exit<void, unknown>>()
      this.actor.send({ type: "CLOSE", reply })
      return Deferred.await(reply).pipe(Effect.flatMap((exit) => exit))
    })
  }
  private async result<A>(result: Effect.Effect<A, unknown>) {
    const exit = await Effect.runPromiseExit(result)
    if (Exit.isSuccess(exit)) return exit.value
    const reasons = exit.cause.reasons
    // Preserve ordinary native Error compatibility, but never squash a compound
    // Cause or its annotations at the Promise boundary.
    if (
      reasons.length === 1 &&
      reasons[0]?._tag === "Fail" &&
      [...reasons[0].annotations.keys()].every(
        (key) => key === "effect/Cause/StackTrace"
      )
    )
      throw reasons[0].error
    throw exit.cause
  }
  start(unrestricted = false, signal?: AbortSignal) {
    if (this.actor.getSnapshot().status !== "active")
      return Promise.reject(new Error("Terminal capacity owner is closed"))
    const reply = Deferred.makeUnsafe<Exit.Exit<void, unknown>>()
    this.actor.send({
      type: "START",
      unrestricted,
      signal,
      reply,
    })
    return this.result(
      Deferred.await(reply).pipe(Effect.flatMap((exit) => exit))
    )
  }
  close() {
    if (this.actor.getSnapshot().status !== "active")
      return Promise.reject(new Error("Terminal capacity owner is closed"))
    return this.result(this.closeEffect())
  }
  retireIdle(epoch: number) {
    if (!Number.isSafeInteger(epoch) || epoch < 1)
      return Promise.reject(new Error("Invalid terminal capacity epoch"))
    if (this.actor.getSnapshot().status !== "active")
      return Promise.reject(new Error("Terminal capacity owner is closed"))
    const reply = Deferred.makeUnsafe<Exit.Exit<boolean, unknown>>()
    this.actor.send({ type: "RETIRE", epoch, reply })
    return this.result(
      Deferred.await(reply).pipe(Effect.flatMap((exit) => exit))
    )
  }
  dispose() {
    return this.result(Scope.close(this.scope, Exit.void))
  }
}
