import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Clock, Effect, Equal, Exit } from "effect"

import { fatalCause, preserveFatal } from "../shared/effect"
import { appPumpMachine } from "./pump.machine"
import type { AppAdmission } from "./repository"
import type { Apps } from "./service"

export interface AppEventHost<TError, TRequirements = never> {
  active: () => Effect.Effect<boolean, TError, TRequirements>
  modelConnected: () => Effect.Effect<boolean, TError, TRequirements>
  prearm: () => Effect.Effect<number, TError, TRequirements>
  wakeConversation: () => Effect.Effect<void, TError, TRequirements>
  admission: AppAdmission
  notify: () => Effect.Effect<void, TError, TRequirements>
}
/** Effect owns one pass; the event machine owns bounded business backoff and
 * Lifecycle supplies durable wakeups. Admission remains a synchronous shared
 * ledger transaction, including the Conversations discovery lease check. */
export function appEventPump<TError, TRequirements>(
  apps: Pick<
    Apps["Service"],
    | "pending"
    | "deliverNext"
    | "nextDelivery"
    | "deferDelivery"
    | "cancelPending"
  >,
  host: AppEventHost<TError, TRequirements>
) {
  return {
    run: Effect.fn("Apps.deliverEvents")(function* () {
      let failure: Cause.Cause<unknown> | undefined
      const observe = <A, E, R>(work: Effect.Effect<A, E, R>) =>
        work.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isFailure(exit)) failure = exit.cause
            })
          )
        )
      const machine = appPumpMachine({
        inspect: observe(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const active = yield* host.active()
            const events = yield* apps.pending()
            const next = yield* apps.nextDelivery()
            return {
              now,
              active,
              id: events[0]?.id,
              next,
              connected:
                active && events.length > 0 && (next ?? Infinity) <= now
                  ? yield* host.modelConnected()
                  : false,
            }
          })
        ),
        arm: observe(Effect.suspend(host.prearm)),
        admit: (deadline) =>
          observe(
            apps.deliverNext(host.admission, deadline).pipe(
              preserveFatal,
              Effect.catchTag("ConversationFull", () =>
                Effect.succeed("full" as const)
              )
            )
          ),
        defer: (id, reason, now) =>
          observe(apps.deferDelivery(id, reason, now)),
        cancel: observe(
          apps.cancelPending(
            "This bot was archived before conversation admission. Saved app state and interaction receipts are retained."
          )
        ),
        wake: observe(Effect.suspend(host.wakeConversation)),
        notify: observe(Effect.suspend(host.notify)),
        next: observe(
          Effect.gen(function* () {
            const next = yield* apps.nextDelivery()
            return next === undefined
              ? undefined
              : Math.max(next, (yield* Clock.currentTimeMillis) + 100)
          })
        ),
      })
      return yield* Effect.gen(function* () {
        const actor = yield* createEffectActor(machine)
        const done = yield* waitFor(
          actor,
          (snapshot) => snapshot.status === "done"
        ).pipe(Effect.orDie)
        return yield* done.output
      }).pipe(
        Effect.scoped,
        Effect.onExit((exit) => {
          if (!failure || !Cause.hasDies(failure)) return Effect.void
          const retained = Exit.isFailure(exit) ? exit.cause.reasons : []
          const missing = failure.reasons.filter(
            (reason) =>
              reason._tag !== "Interrupt" &&
              !retained.some(
                (present) =>
                  Equal.equals(present, reason) ||
                  (present._tag === "Die" &&
                    reason._tag === "Fail" &&
                    Equal.equals(present.defect, reason))
              )
          )
          return missing.some((reason) => reason._tag === "Die")
            ? Effect.failCause(fatalCause(Cause.fromReasons(missing)))
            : Effect.void
        })
      )
    }),
  }
}
