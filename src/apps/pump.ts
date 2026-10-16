import { preserveFatal } from "../shared/effect"
import { Clock, Effect } from "effect"
import type { Apps } from "./service"
import type { AppAdmission } from "./repository"

export interface AppEventHost<TError, TRequirements = never> {
  active: () => Effect.Effect<boolean, TError, TRequirements>
  modelConnected: () => Effect.Effect<boolean, TError, TRequirements>
  wakeConversation: () => Effect.Effect<void, TError, TRequirements>
  admission: AppAdmission
  notify: () => Effect.Effect<void, TError, TRequirements>
}
/** The application owns admission order and retry decisions. Lifecycle only
 * interprets the returned wake time through its existing single alarm owner. */
export function appEventPump<TError, TRequirements>(
  apps: Pick<Apps["Service"], "pending" | "deliverNext">,
  host: AppEventHost<TError, TRequirements>
) {
  return {
    run: Effect.fn("Apps.deliverEvents")(function* () {
      if (!(yield* host.active()) || !(yield* apps.pending()).length) return
      if (!(yield* host.modelConnected()))
        return (yield* Clock.currentTimeMillis) + 60_000
      // Wake is persisted before atomic event-to-conversation admission.
      yield* host.wakeConversation()
      const delivered = yield* apps.deliverNext(host.admission).pipe(
        preserveFatal,
        Effect.catchTag("ConversationFull", () =>
          Effect.succeed("full" as const)
        )
      )
      if (delivered === "full") return (yield* Clock.currentTimeMillis) + 10_000
      yield* host.notify()
      return (yield* apps.pending()).length
        ? (yield* Clock.currentTimeMillis) + 100
        : undefined
    }),
  }
}
