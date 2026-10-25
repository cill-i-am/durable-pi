import { createEffectActor } from "@xstate/effect"
import { Effect, Redacted } from "effect"

import { authClient } from "@/auth/client"

import { AuthIssue } from "./auth-contracts"
import { authNative, authOwner, useAuthActor } from "./auth-owner"
import { securityError } from "./security-errors"
import { securityMachine, type SecurityWork } from "./security.machine"

export const securityRequests: Omit<SecurityWork, "close"> = {
  read: () =>
    Effect.gen(function* () {
      const result = yield* authNative(
        (signal) => authClient.listSessions({ fetchOptions: { signal } }),
        "Could not load browser sessions. Try refreshing."
      )
      if (result.error)
        return yield* Effect.fail(
          new AuthIssue({
            message: securityError(result.error),
            code: result.error.code,
          })
        )
      return result.data.map((session) => ({
        id: session.id,
        token: Redacted.make(session.token),
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        userAgent: session.userAgent,
      }))
    }),
  revoke: (input) =>
    Effect.gen(function* () {
      const result = yield* authNative(
        (signal) =>
          input.kind === "others"
            ? authClient.revokeOtherSessions({ fetchOptions: { signal } })
            : authClient.revokeSession(
                { token: Redacted.value(input.session.token) },
                { signal }
              ),
        "Could not confirm revocation. Refresh the list before trying again."
      )
      if (result.error)
        return yield* Effect.fail(
          new AuthIssue({
            message: securityError(result.error),
            code: result.error.code,
          })
        )
    }),
  signOut: () =>
    Effect.gen(function* () {
      const result = yield* authNative(
        (signal) => authClient.signOut({ fetchOptions: { signal } }),
        "Could not confirm sign-out."
      )
      if (result.error)
        return yield* Effect.fail(
          new AuthIssue({ message: "Could not confirm sign-out." })
        )
    }),
}
export function useSecurity(identity: string, close: () => void) {
  return useAuthActor(identity, (live) =>
    authOwner((observe) =>
      createEffectActor(
        securityMachine({
          read: () => observe(securityRequests.read()),
          revoke: (input) => observe(securityRequests.revoke(input)),
          signOut: () => observe(securityRequests.signOut()),
          close: () =>
            Effect.sync(() => {
              if (live()) close()
            }),
        }),
        { input: { currentId: identity } }
      )
    )
  )
}
