import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Cause, Deferred, Effect, Equal, Schema, type Scope } from "effect"

import { ConnectionList, ToolSelection } from "@/access/connections"
import { agentApi } from "@/http/client"
import { orDieAll } from "@/shared/effect"
import { nativeOperation } from "@/shared/interop"

import {
  connectionsMachine,
  type ConnectionRequest,
  type ConnectionsView,
  type ConnectionsWork,
} from "./connections.machine"

type Actor = EffectActor<ReturnType<typeof connectionsMachine>>
export function connectionRequests(
  agentId: string | undefined
): ConnectionsWork {
  const request = (owner: string, path: string, body?: unknown) =>
    nativeOperation(
      (signal) => agentApi(owner)(path, body, signal),
      (cause) => cause
    )
  return {
    read: () =>
      Effect.all(
        {
          library: request("home", "connections").pipe(
            Effect.map(Schema.decodeUnknownSync(ConnectionList))
          ),
          selection:
            agentId === undefined
              ? Effect.succeed({ revision: 0, tools: [] })
              : request(agentId, "remote-tools").pipe(
                  Effect.map(Schema.decodeUnknownSync(ToolSelection))
                ),
        },
        { concurrency: "unbounded" }
      ),
    command: (input) => {
      if ((input.action === "select") !== (agentId !== undefined))
        return Effect.fail(
          new Error(
            "Open the matching connection settings before changing them."
          )
        )
      return input.action === "select"
        ? request(agentId!, "remote-tools", input.body).pipe(
            Effect.map((value) => ({
              kind: "selection" as const,
              value: Schema.decodeUnknownSync(ToolSelection)(value),
            }))
          )
        : request("home", `connections/${input.action}`, input.body).pipe(
            Effect.map((value) => ({
              kind: "library" as const,
              value: Schema.decodeUnknownSync(ConnectionList)(value),
            }))
          )
    },
  }
}
export function makeConnectionsOwner(
  view: ConnectionsView,
  work: ConnectionsWork
) {
  return Effect.gen(function* () {
    let actor: Actor | undefined
    const failures: Cause.Cause<unknown>[] = []
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
        const missing = failures
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
        return missing.length
          ? Effect.failCause(Cause.fromReasons(missing)).pipe(orDieAll)
          : Effect.void
      })
    )
    actor = yield* createEffectActor(
      connectionsMachine({
        read: () => observe(work.read()),
        command: (input) => observe(work.command(input)),
      }),
      { input: view }
    )
    return actor
  })
}
export function connectionCommand(actor: Actor, input: ConnectionRequest) {
  return Effect.gen(function* () {
    if (actor.getSnapshot().status !== "active") return false
    const done = yield* Deferred.make<boolean>()
    const settle = (ok: boolean) => Effect.runSync(Deferred.succeed(done, ok))
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        actor.on("settled", (event) => {
          if (event.requestId === input.requestId) settle(event.ok)
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
    return yield* Deferred.await(done)
  }).pipe(Effect.scoped)
}
