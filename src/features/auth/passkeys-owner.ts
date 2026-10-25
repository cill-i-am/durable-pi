import { createEffectActor } from "@xstate/effect"
import { Effect, Schema } from "effect"

import { authClient } from "@/auth/client"
import { nativeOperation } from "@/shared/interop"

import { AuthIssue } from "./auth-contracts"
import { authNative, authOwner, useAuthActor } from "./auth-owner"
import { passkeyError, passkeyErrorCode } from "./passkey-errors"
import {
  passkeysMachine,
  SavedPasskey,
  type PasskeyWork,
} from "./passkeys.machine"

export const passkeyRequests: PasskeyWork = {
  read: () =>
    Effect.gen(function* () {
      const result = yield* authNative(
        (signal) =>
          authClient.passkey.listUserPasskeys({ fetchOptions: { signal } }),
        "Could not load passkeys."
      )
      if (result.error)
        return yield* Effect.fail(
          new AuthIssue({
            message: passkeyError(result.error),
            code: passkeyErrorCode(result.error),
          })
        )
      return Schema.decodeUnknownSync(Schema.Array(SavedPasskey))(
        result.data ?? []
      )
    }),
  save: (input) =>
    Effect.gen(function* () {
      const result = yield* nativeOperation<
        { data?: unknown; error?: unknown },
        AuthIssue
      >(
        (signal) => {
          if (input.editor.kind === "add")
            return authClient.passkey.addPasskey({
              name: input.name,
              fetchOptions: { signal },
            })
          if (input.editor.kind === "rename")
            return authClient.passkey.updatePasskey(
              { id: input.editor.key.id, name: input.name },
              { signal }
            )
          return authClient.passkey.deletePasskey(
            { id: input.editor.key.id },
            { signal }
          )
        },
        () =>
          new AuthIssue({
            code: "UNCONFIRMED",
            message:
              "Could not confirm the change. Refresh the list before trying again.",
          })
      )
      if (result.error)
        return yield* Effect.fail(
          new AuthIssue({
            message: passkeyError(result.error),
            code: passkeyErrorCode(result.error),
          })
        )
      if (!result.data)
        return yield* Effect.fail(
          new AuthIssue({
            code: "UNCONFIRMED",
            message:
              "Could not confirm the change. Refresh the list before trying again.",
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
export function usePasskeyActor(
  identity: string,
  view: { disabled: boolean; available: boolean }
) {
  return useAuthActor(identity, () =>
    authOwner((observe) =>
      createEffectActor(
        passkeysMachine({
          read: () => observe(passkeyRequests.read()),
          save: (input) => observe(passkeyRequests.save(input)),
          signOut: () => observe(passkeyRequests.signOut()),
        }),
        { input: view }
      )
    )
  )
}
