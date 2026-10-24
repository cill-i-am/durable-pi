import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Cause, Deferred, Effect, Equal, Exit, Schema } from "effect"

import { AppDetail, AppDocument } from "@/apps/contracts"
import { agentApi } from "@/http/client"
import { orDieAll, preserveFatal } from "@/shared/effect"
import { nativeOperation } from "@/shared/interop"

import { appUiMachine, type AppCommand, type AppWork } from "./app-ui.machine"

/** Registered before actors so joined invocation failures remain observable. */
export const appWorkFailures = Effect.gen(function* () {
  const failures: Cause.Cause<unknown>[] = []
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      const reasons = failures
        .flatMap((cause) => cause.reasons)
        .filter(
          (reason, index, all) =>
            all.findIndex((other) => Equal.equals(reason, other)) === index
        )
      return reasons.length
        ? Effect.failCause(Cause.fromReasons(reasons)).pipe(orDieAll)
        : Effect.void
    })
  )
  return <A, E, R>(work: Effect.Effect<A, E, R>) =>
    work.pipe(
      preserveFatal,
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit) && Cause.hasDies(exit.cause))
            failures.push(exit.cause)
        })
      )
    )
})
export type AppActor = EffectActor<ReturnType<typeof appUiMachine>>
export function appRequests(agentId: string, id: string): AppWork {
  const request = (path: string, body?: unknown) =>
    nativeOperation(
      (signal) => agentApi(agentId)(path, body, signal),
      (cause) => cause
    )
  return {
    read: request(`apps/${encodeURIComponent(id)}`).pipe(
      Effect.map(Schema.decodeUnknownSync(AppDetail)),
      Effect.flatMap((detail) =>
        detail.app.id === id
          ? Effect.succeed(detail)
          : Effect.fail(new Error("App response identity changed."))
      )
    ),
    mutate: (attempt) =>
      request(attempt.path, attempt.input).pipe(
        Effect.map(Schema.decodeUnknownSync(AppDocument)),
        Effect.flatMap((document) =>
          document.id === id
            ? Effect.succeed(document)
            : Effect.fail(new Error("App response identity changed."))
        )
      ),
    cancel: (attempt) =>
      request("apps/cancel", { operationId: attempt.input.operationId }).pipe(
        Effect.map(
          Schema.decodeUnknownSync(Schema.Struct({ applied: Schema.Boolean }))
        )
      ),
  }
}
export function makeAppOwner(
  input: { agentId: string; id: string; visible: boolean },
  work: AppWork
) {
  return Effect.gen(function* () {
    const observe = yield* appWorkFailures
    return yield* createEffectActor(
      appUiMachine({
        read: observe(work.read),
        mutate: (attempt) => observe(work.mutate(attempt)),
        cancel: (attempt) => observe(work.cancel(attempt)),
      }),
      { input }
    )
  })
}
export function appCommand(actor: AppActor, command: AppCommand) {
  return Effect.gen(function* () {
    if (actor.getSnapshot().status !== "active") return false
    const ticket = crypto.randomUUID(),
      result = yield* Deferred.make<boolean>()
    const settle = (ok: boolean) => Effect.runSync(Deferred.succeed(result, ok))
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        actor.on("settled", (event) => {
          if (event.ticket === ticket) settle(event.ok)
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
    yield* send(actor, { type: "COMMAND", ticket, command })
    return yield* Deferred.await(result)
  }).pipe(Effect.scoped)
}
