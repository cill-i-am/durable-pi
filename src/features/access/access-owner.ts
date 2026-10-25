import { createEffectActor, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Equal, Schema, type Scope } from "effect"

import { AccessState } from "@/access/contracts"
import { agentApi } from "@/http/client"
import { orDieAll } from "@/shared/effect"
import { nativeOperation } from "@/shared/interop"

import {
  accessMachine,
  type AccessView,
  type AccessWork,
} from "./access.machine"
import {
  approvalMachine,
  type ApprovalRequest,
  type ApprovalView,
} from "./approval.machine"

export function accessRequests(agentId: string): AccessWork {
  const request = (path: string, body?: unknown) =>
    nativeOperation(
      (signal) => agentApi(agentId)(path, body, signal),
      (cause) => cause
    ).pipe(Effect.map(Schema.decodeUnknownSync(AccessState)))
  return {
    read: () => request("access"),
    update: (input) => request("access/policy", input),
  }
}
export function approvalRequest(input: ApprovalRequest) {
  return nativeOperation(
    (signal) =>
      agentApi(input.view.agentId)(
        "access/decide",
        {
          id: input.view.approval.id,
          expectedRevision: input.view.approval.revision,
          approve: input.approve,
          ...(input.remember
            ? {
                remember: {
                  expectedPolicyRevision: input.view.policy!.revision,
                },
              }
            : {}),
        },
        signal
      ),
    (cause) => cause
  ).pipe(Effect.map(Schema.decodeUnknownSync(AccessState)))
}
function observeRequests(retained: () => unknown) {
  return Effect.gen(function* () {
    const failures: Cause.Cause<unknown>[] = []
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        const current = retained()
        const missing = failures
          .flatMap((cause) => cause.reasons)
          .filter(
            (reason) =>
              !(
                Cause.isCause(current) &&
                current.reasons.some((existing) =>
                  Equal.equals(existing, reason)
                )
              )
          )
        return missing.length
          ? Effect.failCause(Cause.fromReasons(missing)).pipe(orDieAll)
          : Effect.void
      })
    )
    return <A>(work: Effect.Effect<A, unknown, Scope.Scope>) =>
      work.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (exit._tag === "Failure" && Cause.hasDies(exit.cause))
              failures.push(exit.cause)
          })
        )
      )
  })
}
export function makeApprovalOwner(view: ApprovalView, work = approvalRequest) {
  return Effect.gen(function* () {
    let actor: EffectActor<ReturnType<typeof approvalMachine>> | undefined
    const observe = yield* observeRequests(
      () => actor?.getSnapshot().context.failure
    )
    actor = yield* createEffectActor(
      approvalMachine((input) => observe(work(input))),
      { input: view }
    )
    return actor
  })
}
export function makeAccessOwner(view: AccessView, work: AccessWork) {
  return Effect.gen(function* () {
    let actor: EffectActor<ReturnType<typeof accessMachine>> | undefined
    const observe = yield* observeRequests(
      () => actor?.getSnapshot().context.failure
    )
    actor = yield* createEffectActor(
      accessMachine({
        read: () => observe(work.read()),
        update: (input) => observe(work.update(input)),
      }),
      { input: view }
    )
    return actor
  })
}
