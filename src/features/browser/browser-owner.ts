import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Cause, Deferred, Effect, Equal, Schema, type Scope } from "effect"

import { BrowserState } from "@/browser/contracts"
import { agentApi } from "@/http/client"
import { orDieAll } from "@/shared/effect"
import { nativeOperation } from "@/shared/interop"

import {
  browserMachine,
  type BrowserRequest,
  type BrowserView,
  type BrowserWork,
} from "./browser.machine"

type Actor = EffectActor<ReturnType<typeof browserMachine>>
export function browserRequests(agentId: string): BrowserWork {
  const request = (path: string, body?: unknown) =>
    nativeOperation(
      (signal) => agentApi(agentId)(path, body, signal),
      (cause) => cause
    ).pipe(Effect.map(Schema.decodeUnknownSync(BrowserState)))
  return {
    read: () => request("browser"),
    command: (input) =>
      Effect.gen(function* () {
        // Close deliberately observes current authority before its explicit POST.
        // Aborting an older HTTP observer alone cannot cancel remote browser work.
        const body =
          input.path === "close" && input.interrupt
            ? { generation: (yield* request("browser")).policy.generation }
            : input.body
        return yield* request(`browser/${input.path}`, body)
      }),
  }
}

export function makeBrowserOwner(view: BrowserView, work: BrowserWork) {
  return Effect.gen(function* () {
    const failures: Cause.Cause<unknown>[] = []
    let actor: Actor | undefined
    const observe = <A>(operation: Effect.Effect<A, unknown, Scope.Scope>) =>
      operation.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (exit._tag === "Failure" && Cause.hasDies(exit.cause))
              failures.push(exit.cause)
          })
        )
      )
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        const retained = actor?.getSnapshot().context.failure
        const reasons = failures
          .flatMap((failure) => failure.reasons)
          .filter(
            (reason) =>
              !(
                Cause.isCause(retained) &&
                retained.reasons.some((present) =>
                  Equal.equals(present, reason)
                )
              )
          )
        return reasons.length
          ? Effect.failCause(Cause.fromReasons(reasons)).pipe(orDieAll)
          : Effect.void
      })
    )
    actor = yield* createEffectActor(
      browserMachine({
        read: () => observe(work.read()),
        command: (input) => observe(work.command(input)),
      }),
      { input: view }
    )
    return actor
  })
}

/** A local acknowledgement listener, not a second command owner. Rejected,
 * superseded and stopped observers all settle false without a remote retry. */
export function browserCommand(actor: Actor, input: BrowserRequest) {
  return Effect.gen(function* () {
    if (actor.getSnapshot().status !== "active") return false
    const result = yield* Deferred.make<boolean>()
    const settle = (ok: boolean) => Effect.runSync(Deferred.succeed(result, ok))
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        actor.on("settled", (event) => {
          if (event.id === input.id) settle(event.ok)
        })
      ),
      (subscription) => Effect.sync(() => subscription.unsubscribe())
    )
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        actor.subscribe({
          complete: () => settle(false),
          error: () => settle(false),
        })
      ),
      (subscription) => Effect.sync(() => subscription.unsubscribe())
    )
    yield* send(actor, { type: "COMMAND", ...input })
    return yield* Deferred.await(result)
  }).pipe(Effect.scoped)
}
