import { createEffectActor } from "@xstate/effect"
import { Effect } from "effect"

import { familyChangeMachine, type FamilyChange } from "./family-change.machine"
import { makeFamilyRequests } from "./family-requests"

export function makeFamilyChange(ports: {
  authorized: (command: FamilyChange) => boolean
  change: (command: FamilyChange, signal: AbortSignal) => Promise<void>
  refresh: () => Promise<void>
}) {
  return Effect.gen(function* () {
    const requests = yield* makeFamilyRequests()
    const actor = yield* createEffectActor(
      familyChangeMachine({
        change: (command) =>
          requests
            .request(async (signal) => {
              if (!ports.authorized(command))
                throw new Error(
                  "Your family access has changed. Refresh before trying again."
                )
              await ports.change(command, signal)
              if (!requests.active() || !ports.authorized(command))
                throw new Error(
                  "Your family access has changed. Refresh to check the result."
                )
              return command.kind === "remove"
                ? `${command.name} was removed from the family.`
                : command.kind === "cancel"
                  ? "Invitation cancelled."
                  : `Invitation sent to ${command.email}.`
            })
            .pipe(
              Effect.match({
                onSuccess: (message) => ({ ok: true, message }),
                onFailure: (cause) => ({
                  ok: false,
                  message:
                    cause instanceof Error
                      ? cause.message
                      : "Could not update family access. Please try again.",
                }),
              })
            ),
        refresh: Effect.suspend(() =>
          requests.active()
            ? requests
                .request(ports.refresh)
                .pipe(Effect.catch(() => Effect.void))
            : Effect.void
        ),
      })
    )
    return { actor, revoke: requests.revoke }
  })
}
