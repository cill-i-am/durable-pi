import { createEffectActor } from "@xstate/effect"
import { Cause, Effect, type Scope } from "effect"

import { orDieAll } from "@/shared/effect"

import {
  mailboxControlMachine,
  type MailboxControlView,
  type MailboxRequest,
} from "./mailbox-control.machine"
import { activityJsonRequest, activityQueryRequest } from "./query-owner"

export function mailboxControlRequest(
  view: MailboxControlView,
  request: MailboxRequest
) {
  return activityQueryRequest((signal) =>
    activityJsonRequest(view.agentId, "communication/control", signal, request)
  ).pipe(Effect.asVoid)
}
export function makeMailboxControlOwner(
  view: MailboxControlView,
  work: (
    view: MailboxControlView,
    request: MailboxRequest
  ) => Effect.Effect<void, unknown, Scope.Scope> = mailboxControlRequest,
  now: () => number = Date.now
) {
  return Effect.gen(function* () {
    const failures: Cause.Cause<unknown>[] = []
    // Snapshot context only projects a failure; it does not propagate that
    // failure to the parent scope. Keep each fatal observation until close.
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() =>
        failures.length
          ? Effect.failCause(
              Cause.fromReasons(failures.flatMap((cause) => cause.reasons))
            ).pipe(orDieAll)
          : Effect.void
      )
    )
    return yield* createEffectActor(
      mailboxControlMachine(
        (view, request) =>
          work(view, request).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (
                  exit._tag === "Failure" &&
                  (Cause.hasDies(exit.cause) ||
                    (Cause.hasInterrupts(exit.cause) &&
                      exit.cause.reasons.some(
                        (reason) => reason._tag === "Fail"
                      )))
                )
                  failures.push(exit.cause)
              })
            )
          ),
        now
      ),
      { input: view }
    )
  })
}
